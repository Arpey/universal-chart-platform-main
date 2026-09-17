"""
Tradovate 发单微服务（FastAPI + Playwright DOM 仿真 + REST 结果校验）。

模块划分：
1. 全局配置与状态（环境变量化，默认 demo 环境）
2. 请求 Payload 结构定义
3. 网络拦截与生命周期
4. 辅助函数：DOM 定位 / Token 提取 / 手数填写 / 下单点击与成交确认
5. API 路由：/webhook、/cancel-all、/flatten、/account-summary、/positions、/health、/diagnose
"""

import asyncio
import json
import logging
import os
import sys
import time
from typing import Any, Dict, List, Optional, Tuple, Union

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from playwright.async_api import (
    Browser,
    BrowserContext,
    Locator,
    Page,
    async_playwright,
)

# ================= 1. 全局配置与状态 =================
# 凭证 / 日志固定落在脚本所在目录，不受启动时的工作目录影响
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(BASE_DIR, "state.json")     # 登录凭证持久化文件
LOG_FILE = os.path.join(BASE_DIR, "app.log")          # 运行日志文件
TRADOVATE_URL = os.environ.get("TRADOVATE_URL", "https://trader.tradovate.com/")
# 模拟盘: https://demo.tradovateapi.com/v1 ；实盘: https://live.tradovateapi.com/v1
TRADOVATE_API_BASE = os.environ.get("TRADOVATE_API_BASE", "https://demo.tradovateapi.com/v1")
PORT = int(os.environ.get("PORT", "8000"))            # 服务端口（前端调用端口需与此一致）
BUTTON_WAIT_TIMEOUT_MS = 10000                        # 按钮可见等待上限（毫秒）
ORDER_CONFIRM_TIMEOUT = float(os.environ.get("ORDER_CONFIRM_TIMEOUT", "5"))  # 下单确认轮询上限（秒）
ORDER_CONFIRM_INTERVAL = 0.5                          # 下单确认轮询间隔（秒）
CORS_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]

# 手数输入框：找不到时必须报错，绝不静默沿用 Tradovate 默认手数
QTY_INPUT_SELECTOR = 'input[data-qa*="qty"], input[name*="qty"], input[type="number"]'
SYMBOL_CONTAINER_SELECTOR = (
    '.module-container:has-text("{s}"), '
    '.chart-module:has-text("{s}"), '
    'div[data-symbol*="{s}"]'
)
# 按钮文案兼容列表：依次尝试，取第一个可见按钮
BUY_BUTTON_TEXTS = ("Buy Market", "Buy", "Bid")
SELL_BUTTON_TEXTS = ("Sell Market", "Sell", "Ask")
CANCEL_BUTTON_TEXTS = ("Cancel All", "Cancel Orders")
FLATTEN_BUTTON_TEXTS = ("Flatten", "Exit & Cancel")


def _setup_logging() -> logging.Logger:
    """日志同时输出到 stdout 与 app.log（替代原 print）。"""
    # Windows 控制台默认 GBK：尽量切到 UTF-8，避免日志里的 emoji 触发编码异常
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass

    logger = logging.getLogger("push_order")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if logger.handlers:
        return logger

    formatter = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(formatter)
    logger.addHandler(stream_handler)

    try:
        file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
    except Exception as exc:  # 日志文件不可写时不影响服务启动
        logger.warning("日志文件 %s 初始化失败，仅输出到 stdout: %s", LOG_FILE, exc)
    return logger


logger = _setup_logging()


def describe_environment() -> str:
    """当前 Tradovate 环境描述（demo / live）。"""
    return "LIVE（实盘）" if "demo" not in TRADOVATE_API_BASE.lower() else "DEMO（模拟盘）"


app = FastAPI(
    title="Tradovate Light Executor & Monitor",
    description="基于 Playwright 的 Tradovate 零延迟发单、持仓监控与指定品种撤单微服务"
)

# 前端（Vite dev server: 5173）跨域调用必需
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

playwright_instance = None
browser_instance: Optional[Browser] = None
context_instance: Optional[BrowserContext] = None
page_instance: Optional[Page] = None
lock = asyncio.Lock()

latest_positions_cache: Dict[str, Any] = {}
latest_orders_cache: Dict[str, Any] = {}


# ================= 2. 请求 Payload 结构定义 =================
class OrderSignal(BaseModel):
    action: str                        # BUY, SELL, CANCEL_ALL, FLATTEN
    symbol: Optional[str] = "MES"      # 合约代码/品种 (例如 MES, MNQ, MCL)
    qty: int = 1                       # 数量
    order_type: str = "MARKET"


# ================= 3. 拦截与生命周期 =================
async def handle_response(response):
    """被动缓存 Tradovate 页面自身请求到的持仓 / 订单数据（REST 失败时兜底）。"""
    global latest_positions_cache, latest_orders_cache
    try:
        url = response.url
        if response.status != 200:
            return
        if "position/list" in url or "position/deps" in url:
            latest_positions_cache["data"] = await response.json()
            latest_positions_cache["updated_at"] = asyncio.get_event_loop().time()
        elif "order/list" in url or "order/deps" in url:
            latest_orders_cache["data"] = await response.json()
            latest_orders_cache["updated_at"] = asyncio.get_event_loop().time()
    except Exception:
        pass


async def block_unnecessary_resources(route):
    if route.request.resource_type in ["image", "media", "font"]:
        await route.abort()
    else:
        await route.continue_()


@app.on_event("startup")
async def startup_event():
    global playwright_instance, browser_instance, context_instance, page_instance

    logger.info("🚀 [系统启动] 当前 Tradovate 环境: %s（API: %s）", describe_environment(), TRADOVATE_API_BASE)
    logger.info("🚀 [系统启动] 正在初始化 Playwright 常驻 Firefox 无头浏览器...")
    playwright_instance = await async_playwright().start()

    # 采用 Firefox 内核避开 Windows Server 下 chromium 的 chrome.dll 0x7F 错误
    browser_instance = await playwright_instance.firefox.launch(headless=True)

    if os.path.exists(STATE_FILE):
        logger.info("🔑 正在读取凭证文件 %s ...", STATE_FILE)
        context_instance = await browser_instance.new_context(storage_state=STATE_FILE)
    else:
        logger.warning("⚠️ 未找到 state.json 凭证文件（%s）！请先运行 save_session.py 生成。", STATE_FILE)
        context_instance = await browser_instance.new_context()

    page_instance = await context_instance.new_page()

    page_instance.on("response", handle_response)
    await page_instance.route("**/*", block_unnecessary_resources)

    logger.info("🌐 正在预热载入 Tradovate 页面: %s", TRADOVATE_URL)
    try:
        await page_instance.goto(TRADOVATE_URL, wait_until="networkidle", timeout=60000)
        logger.info("✅ [系统就绪] Tradovate DOM 结构与 Session 会话加载完成！")
    except Exception as exc:
        logger.warning("⚠️ 预热页面提示: %s", exc)


@app.on_event("shutdown")
async def shutdown_event():
    global playwright_instance, browser_instance, context_instance
    if context_instance:
        await context_instance.close()
    if browser_instance:
        await browser_instance.close()
    if playwright_instance:
        await playwright_instance.stop()


# ================= 4. 辅助函数：定位 DOM & 提取 Token =================
STORAGE_SNAPSHOT_JS = """() => {
    const dump = (storage) => {
        const out = {};
        try {
            for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i);
                out[key] = storage.getItem(key);
            }
        } catch (e) {}
        return out;
    };
    return { local: dump(localStorage), session: dump(sessionStorage) };
}"""


async def _get_storage_snapshot() -> Dict[str, Any]:
    """读取浏览器 localStorage / sessionStorage 全量快照（Token 提取与 /diagnose 共用）。"""
    global page_instance
    if not page_instance:
        return {"local": {}, "session": {}}
    try:
        snapshot = await page_instance.evaluate(STORAGE_SNAPSHOT_JS)
        if isinstance(snapshot, dict):
            return snapshot
    except Exception as exc:
        logger.warning("读取浏览器存储失败: %s", exc)
    return {"local": {}, "session": {}}


def _extract_token_from_storage(storage: Any) -> str:
    """按优先级从单个 storage 快照中提取 Tradovate Token。"""
    if not isinstance(storage, dict):
        return ""

    # 1) 首选：localStorage["token"] = {"token": "eyJ...", "expirationTime": "..."}
    raw_token = storage.get("token")
    if isinstance(raw_token, str) and raw_token.strip():
        try:
            parsed = json.loads(raw_token)
        except (ValueError, TypeError):
            return raw_token.strip()
        if isinstance(parsed, dict):
            for field in ("token", "accessToken", "auth_token"):
                value = parsed.get(field)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        elif isinstance(parsed, str) and parsed.strip():
            return parsed.strip()

    # 2) 依次尝试常见键名
    for key in ("accessToken", "auth_token", "access_token"):
        value = storage.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    # 3) 兜底：扫描所有值，取 JSON 中的 token / accessToken 字段
    for value in storage.values():
        if not isinstance(value, str) or "token" not in value.lower():
            continue
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            continue
        if not isinstance(parsed, dict):
            continue
        for field in ("token", "accessToken", "auth_token"):
            candidate = parsed.get(field)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
    return ""


async def get_tradovate_token() -> str:
    """从浏览器存储提取 API 访问 Token：localStorage["token"] → accessToken → auth_token → sessionStorage。"""
    global page_instance
    if not page_instance:
        return ""

    snapshot = await _get_storage_snapshot()

    token = _extract_token_from_storage(snapshot.get("local"))
    if token:
        return token

    token = _extract_token_from_storage(snapshot.get("session"))
    if token:
        logger.info("🔑 已在 sessionStorage 兜底路径中提取到 AccessToken")
        return token

    logger.warning("❌ 未能从 localStorage / sessionStorage 提取到 AccessToken（请重新运行 save_session.py 或检查 /diagnose）")
    return ""


async def get_symbol_container(symbol: str) -> Locator:
    """定位指定品种的专属交易面板；找不到直接 404，禁止回退到全局页面误点其他品种。"""
    global page_instance
    if not page_instance:
        raise HTTPException(status_code=500, detail="浏览器实例未就绪")

    clean_symbol = (symbol or "").upper().strip()
    if not clean_symbol:
        raise HTTPException(status_code=400, detail="symbol 参数不能为空")

    modules = page_instance.locator(SYMBOL_CONTAINER_SELECTOR.format(s=clean_symbol))
    if await modules.count() > 0:
        logger.info("🔍 已定位到品种 [%s] 的专属交易面板容器", clean_symbol)
        return modules.first

    raise HTTPException(
        status_code=404,
        detail="未找到品种 %s 的交易面板，请先在 Tradovate 中打开并连接该品种" % clean_symbol,
    )


def _describe_selectors(texts: Tuple[str, ...]) -> str:
    return ", ".join(['button:has-text("%s")' % text for text in texts])


async def _first_visible_locator(
    scope: Union[Page, Locator],
    texts: Tuple[str, ...],
    wait_ms: int = BUTTON_WAIT_TIMEOUT_MS,
) -> Tuple[Optional[str], Optional[Locator]]:
    """依次尝试多个文案选择器，返回第一个可见按钮的 (文案, Locator)。"""
    for text in texts:
        selector = 'button:has-text("%s")' % text
        try:
            locator = scope.locator(selector)
            if await locator.count() == 0:
                continue  # 页面里根本不存在该文案 → 快速切换下一个，避免白等超时
            candidate = locator.first
            await candidate.wait_for(state="visible", timeout=wait_ms)
            return text, candidate
        except Exception:
            continue
    return None, None


async def _click_first_visible(scope: Union[Page, Locator], texts: Tuple[str, ...], label: str) -> str:
    """点击第一个可见按钮（兼容多种文案），全部不可用时返回 500。"""
    matched_text, locator = await _first_visible_locator(scope, texts)
    if locator is None:
        raise HTTPException(
            status_code=500,
            detail="未找到可点击的%s按钮（已尝试：%s）" % (label, _describe_selectors(texts)),
        )
    await locator.click()
    return matched_text


async def _fill_order_qty(scope: Union[Page, Locator], qty: int) -> str:
    """填写手数输入框；找不到输入框直接 500，绝不静默使用 Tradovate 默认手数。"""
    qty_input = scope.locator(QTY_INPUT_SELECTOR).first
    try:
        await qty_input.wait_for(state="visible", timeout=BUTTON_WAIT_TIMEOUT_MS)
    except Exception:
        raise HTTPException(
            status_code=500,
            detail="未找到手数输入框（%s），已取消下单以免误用 Tradovate 默认手数" % QTY_INPUT_SELECTOR,
        )

    expected = str(int(qty))
    try:
        await qty_input.click()
        await qty_input.fill(expected)
        # 部分前端框架对 fill 不触发 onChange → 补发 input/change 事件，确保界面真的采纳该手数
        await qty_input.evaluate(
            "el => { el.dispatchEvent(new Event('input', {bubbles: true})); "
            "el.dispatchEvent(new Event('change', {bubbles: true})); }"
        )
        actual = (await qty_input.input_value()).strip()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail="填写手数失败: %s" % exc)

    if actual != expected:
        raise HTTPException(
            status_code=500,
            detail="手数填写失败：期望 %s，界面当前为 %s" % (expected, actual),
        )
    return actual


def _position_fingerprint(positions: Any) -> Dict[str, int]:
    """把持仓列表压缩成 {品种: 净持仓手数}，用于判断下单前后持仓是否变化。"""
    fingerprint: Dict[str, int] = {}
    if not isinstance(positions, list):
        return fingerprint
    for item in positions:
        if not isinstance(item, dict):
            continue
        name = item.get("symbol") or item.get("name") or item.get("contractId") or "UNKNOWN"
        raw_qty = item.get("netPos")
        if raw_qty is None:
            raw_qty = item.get("netPosition", item.get("quantity", item.get("position", 0)))
        try:
            qty_value = int(raw_qty)
        except (TypeError, ValueError):
            qty_value = 0
        key = str(name).upper()
        fingerprint[key] = fingerprint.get(key, 0) + qty_value
    return fingerprint


def _order_ids(orders: Any) -> List[str]:
    """提取订单 ID 列表（用于判断是否出现新订单记录）。"""
    ids: List[str] = []
    if not isinstance(orders, list):
        return ids
    for item in orders:
        if not isinstance(item, dict):
            continue
        order_id = item.get("id", item.get("orderId"))
        if order_id is not None:
            ids.append(str(order_id))
    return ids


async def _wait_for_order_confirmation(
    symbol: str,
    before_positions: Dict[str, int],
    before_orders: List[str],
) -> Dict[str, Any]:
    """点击 Buy/Sell 后轮询 /account-summary（最多 ORDER_CONFIRM_TIMEOUT 秒），确认持仓变化或新订单。"""
    deadline = time.monotonic() + ORDER_CONFIRM_TIMEOUT
    last_error = ""

    while True:
        await asyncio.sleep(ORDER_CONFIRM_INTERVAL)
        try:
            summary = await get_account_summary()
            after_positions = _position_fingerprint(summary.get("positions"))
            after_orders = _order_ids(summary.get("orders"))

            if after_positions != before_positions:
                return {"reason": "持仓已变化", "positions": after_positions, "orders_count": len(after_orders)}

            new_orders = [order_id for order_id in after_orders if order_id not in before_orders]
            if new_orders:
                return {
                    "reason": "订单列表出现新记录（%s）" % ", ".join(new_orders[:3]),
                    "positions": after_positions,
                    "orders_count": len(after_orders),
                }
            last_error = ""
        except HTTPException as exc:
            last_error = str(exc.detail)
        except Exception as exc:
            last_error = str(exc)

        if time.monotonic() >= deadline:
            break

    detail = (
        "已点击 %s 的下单按钮，但 %.0f 秒内未确认到持仓变化或新订单"
        "（可能未成交、品种面板未连接或 Tradovate 页面状态异常）"
        % (symbol, ORDER_CONFIRM_TIMEOUT)
    )
    if last_error:
        detail += "；最近一次查询错误: %s" % last_error
    raise HTTPException(status_code=500, detail=detail)


async def _click_order_button(scope: Union[Page, Locator], action: str, symbol: str, qty: int) -> Dict[str, Any]:
    """点击 Buy/Sell 发单：先写手数 → 兼容选择器点击 → 轮询确认，未确认成功则 500。"""
    button_texts = BUY_BUTTON_TEXTS if action == "BUY" else SELL_BUTTON_TEXTS
    action_label = "Buy" if action == "BUY" else "Sell"

    # 1) 点击前取基线快照（确认阶段用于对比持仓 / 订单）
    before = await get_account_summary()
    before_positions = _position_fingerprint(before.get("positions"))
    before_orders = _order_ids(before.get("orders"))

    # 2) 手数必须先写入界面，禁止使用 Tradovate 默认手数
    filled_qty = await _fill_order_qty(scope, qty)

    # 3) 依次尝试兼容选择器，点击第一个可见按钮
    matched_text = await _click_first_visible(scope, button_texts, action_label)
    logger.info(
        "🎯 [已发单] 品种 [%s] 点击【%s】(action=%s, qty=%s)，等待成交确认…",
        symbol, matched_text, action, filled_qty,
    )

    # 4) 轮询确认：只有持仓变化或出现新订单才算成功
    confirmation = await _wait_for_order_confirmation(symbol, before_positions, before_orders)
    return {
        "status": "success",
        "action": action,
        "symbol": symbol,
        "qty": int(qty),
        "button": matched_text,
        "confirmed_by": confirmation["reason"],
        "positions_before": before_positions,
        "positions_after": confirmation["positions"],
        "orders_before": len(before_orders),
        "orders_after": confirmation["orders_count"],
    }


# ================= 5. API 路由定义 =================
@app.post("/webhook")
async def handle_webhook(signal: OrderSignal):
    """
    【统一 Webhook 接口】通过 DOM 仿真点击发单（前端 http://localhost:5173 跨域直接调用）
    - BUY / SELL:  填写手数 → 点击 Buy/Sell → 轮询确认持仓 / 订单变化，未确认成功返回 500
    - CANCEL_ALL:  撤销指定品种所有挂单
    - FLATTEN:     指定品种一键平仓并全撤
    """
    global page_instance, lock
    action = (signal.action or "").upper().strip()
    symbol = (signal.symbol or "MES").upper().strip()

    if action not in ("BUY", "SELL", "CANCEL_ALL", "FLATTEN"):
        raise HTTPException(status_code=400, detail="Action 参数无效")
    if action in ("BUY", "SELL") and (signal.qty is None or int(signal.qty) <= 0):
        raise HTTPException(status_code=400, detail="qty 必须为正整数")

    async with lock:
        if not page_instance:
            raise HTTPException(status_code=500, detail="浏览器实例未就绪")

        try:
            scope = await get_symbol_container(symbol)

            if action == "CANCEL_ALL":
                matched_text = await _click_first_visible(scope, CANCEL_BUTTON_TEXTS, "Cancel All")
                logger.info("🛑 [撤单成功] 已点击【%s】取消品种 [%s] 的所有挂单", matched_text, symbol)
                return {
                    "status": "success",
                    "action": "CANCEL_ALL",
                    "symbol": symbol,
                    "button": matched_text,
                    "message": "已取消 %s 所有挂单" % symbol,
                }

            if action == "FLATTEN":
                matched_text = await _click_first_visible(scope, FLATTEN_BUTTON_TEXTS, "Flatten")
                logger.info("💥 [紧急平仓] 已点击【%s】平仓并撤销品种 [%s] 的所有头寸", matched_text, symbol)
                return {
                    "status": "success",
                    "action": "FLATTEN",
                    "symbol": symbol,
                    "button": matched_text,
                    "message": "已一键平仓并全撤 %s" % symbol,
                }

            result = await _click_order_button(scope, action, symbol, int(signal.qty))
            logger.info(
                "🎯 [发单成功] %s %s × %s（确认依据：%s）",
                action, symbol, result["qty"], result["confirmed_by"],
            )
            return result

        except HTTPException:
            raise  # 404「未找到品种交易面板」/ 400 / 500 等业务异常原样返回
        except Exception as exc:
            logger.exception("❌ [操作异常] 执行 %s 的 %s 指令失败", symbol, action)
            raise HTTPException(status_code=500, detail="执行 %s 的 %s 指令失败: %s" % (symbol, action, exc))


@app.post("/cancel-all")
async def cancel_all_orders(symbol: Optional[str] = "MES"):
    """【指定品种撤单端点】"""
    return await handle_webhook(OrderSignal(action="CANCEL_ALL", symbol=symbol))


@app.post("/flatten")
async def flatten_positions(symbol: Optional[str] = "MES"):
    """【指定品种平仓全撤端点】"""
    return await handle_webhook(OrderSignal(action="FLATTEN", symbol=symbol))


# ================= 6. 方案 B：REST API 持仓与资金查询接口 =================
@app.get("/account-summary")
async def get_account_summary():
    """
    【方案 B】提取会话 Token 并直接请求 Tradovate REST API，
    高精度获取账户列表、实时资金/余额、当前所有持仓与订单（下单确认的判定依据）。
    """
    token = await get_tradovate_token()
    if not token:
        raise HTTPException(status_code=401, detail="无法从当前浏览器 Session 中提取到有效 AccessToken，请重新获取 state.json")

    headers = {
        "Authorization": "Bearer %s" % token,
        "Accept": "application/json",
    }

    async with httpx.AsyncClient() as client:
        try:
            # 1) 账户列表 2) 持仓列表 3) 资金明细 4) 订单列表（下单确认用）
            accounts_res = await client.get("%s/account/list" % TRADOVATE_API_BASE, headers=headers)
            positions_res = await client.get("%s/position/list" % TRADOVATE_API_BASE, headers=headers)
            cash_res = await client.get("%s/cashBalance/list" % TRADOVATE_API_BASE, headers=headers)
            orders_res = await client.get("%s/order/list" % TRADOVATE_API_BASE, headers=headers)

            return {
                "status": "success",
                "source": "REST_API_DIRECT",
                "environment": describe_environment(),
                "accounts": accounts_res.json() if accounts_res.status_code == 200 else [],
                "positions": positions_res.json() if positions_res.status_code == 200 else [],
                "cash_balances": cash_res.json() if cash_res.status_code == 200 else [],
                "orders": orders_res.json() if orders_res.status_code == 200 else [],
            }
        except Exception as exc:
            raise HTTPException(status_code=500, detail="REST API 查询异常: %s" % exc)


@app.get("/positions")
async def get_positions():
    """多级降级持仓查询接口（优先 API，其次 DOM/网络拦截）"""
    try:
        return await get_account_summary()
    except HTTPException:
        # API 失败（Token 缺失 / 网络异常）时降级回 DOM 与被动缓存
        global page_instance, latest_positions_cache
        if not page_instance:
            raise HTTPException(status_code=500, detail="浏览器未就绪")

        positions = []
        rows = page_instance.locator('.position-row, tr[data-position-id]')
        count = await rows.count()

        if count > 0:
            for i in range(count):
                row_text = await rows.nth(i).inner_text()
                parsed_text = [item.strip() for item in row_text.split("\n") if item.strip()]
                positions.append({"row_index": i, "details": parsed_text})
            return {"status": "success", "source": "DOM_FALLBACK", "positions": positions}

        return {"status": "success", "source": "CACHE_FALLBACK", "positions": latest_positions_cache.get("data", [])}


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "browser_active": page_instance is not None,
        "environment": describe_environment(),
        "tradovate_api_base": TRADOVATE_API_BASE,
        "port": PORT,
    }


@app.get("/diagnose")
async def diagnose():
    """【诊断接口】Token 长度、localStorage 键、Buy/Sell 按钮可用性、当前页面 URL。"""
    global page_instance, latest_positions_cache, latest_orders_cache
    if not page_instance:
        raise HTTPException(status_code=500, detail="浏览器实例未就绪")

    snapshot = await _get_storage_snapshot()
    local_storage = snapshot.get("local") or {}
    session_storage = snapshot.get("session") or {}
    token = await get_tradovate_token()

    buy_text, buy_locator = await _first_visible_locator(page_instance, BUY_BUTTON_TEXTS, wait_ms=1000)
    sell_text, sell_locator = await _first_visible_locator(page_instance, SELL_BUTTON_TEXTS, wait_ms=1000)

    return {
        "status": "success",
        "current_url": page_instance.url,
        "environment": describe_environment(),
        "tradovate_api_base": TRADOVATE_API_BASE,
        "token_len": len(token),
        "token_preview": ("%s…" % token[:12]) if token else "",
        "localStorage_keys": sorted(local_storage.keys()),
        "sessionStorage_keys": sorted(session_storage.keys()),
        "has_buy_button": buy_locator is not None,
        "has_sell_button": sell_locator is not None,
        "buy_button_text": buy_text,
        "sell_button_text": sell_text,
        "cached_positions_count": len(latest_positions_cache.get("data") or []),
        "cached_orders_count": len(latest_orders_cache.get("data") or []),
    }


if __name__ == "__main__":
    import uvicorn

    logger.info("⚡ 服务已开启，监听端口: %s | 当前环境: %s | API: %s", PORT, describe_environment(), TRADOVATE_API_BASE)
    logger.info("🌐 CORS 允许来源: %s", ", ".join(CORS_ORIGINS))
    uvicorn.run(app, host="0.0.0.0", port=PORT, reload=False)
