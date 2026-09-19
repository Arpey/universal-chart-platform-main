"""
app.py
Tradovate Executor - 方案 B 修复版
- 手动登录 + Token 捕获
- 修复 _api_call: 只有 401/403 才换 token
- 合约查询改用 /contract/suggest
- 新增 /debug-contract 诊断接口
"""

import os
import asyncio
import httpx
import logging
from typing import Optional, Dict, Any, List
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from playwright.async_api import async_playwright, Browser, BrowserContext, Page

TRADOVATE_USER = os.environ.get("TRADOVATE_USER", "")
TRADOVATE_PASS = os.environ.get("TRADOVATE_PASS", "")
TRADOVATE_URL = "https://trader.tradovate.com/"
TRADOVATE_API_BASE = os.environ.get(
    "TRADOVATE_API_BASE", "https://demo.tradovateapi.com/v1"
)
PORT = int(os.environ.get("PORT", "8000"))
HEADLESS = os.environ.get("HEADLESS", "false").lower() == "true"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("tradovate")

app = FastAPI(title="Tradovate Executor", version="2.2")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

playwright_instance = None
browser_instance: Optional[Browser] = None
context_instance: Optional[BrowserContext] = None
page_instance: Optional[Page] = None
lock = asyncio.Lock()

_token_candidates: List[str] = []
_current_token: str = ""
_account_info: Dict[str, Any] = {}

TRADE_API_HINTS = ["/account/", "/order/", "/position/", "/cashBalance/", "/contract/", "/user/"]


async def _capture_auth(request):
    """捕获所有带 Bearer 的请求"""
    global _current_token
    try:
        if "tradovateapi.com" not in request.url:
            return
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer ") or len(auth) < 30:
            return
        token = auth[7:]

        if token not in _token_candidates:
            _token_candidates.append(token)
            is_trade = any(h in request.url for h in TRADE_API_HINTS)
            tag = "交易API" if is_trade else "其他"
            logger.info(f"🔑 捕获 Token [{tag}] 长度={len(token)} 来源={request.url}")
            if is_trade:
                _current_token = token
    except Exception:
        pass


async def _try_token(method: str, url: str, token: str, payload: dict = None):
    """用指定 token 调一次 API，返回 (ok, status, data)"""
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if payload is not None:
        headers["Content-Type"] = "application/json"

    async with httpx.AsyncClient(timeout=15) as client:
        try:
            if method == "GET":
                resp = await client.get(url, headers=headers)
            else:
                resp = await client.post(url, headers=headers, json=payload)
        except httpx.RequestError as e:
            return False, 0, str(e)

    try:
        data = resp.json()
    except Exception:
        data = {"raw": resp.text[:200]}

    return resp.status_code in (200, 201), resp.status_code, data


async def _api_call(method: str, path: str, payload: dict = None) -> Any:
    """
    遍历所有候选 token，找到能用的那个。
    关键修复：只有 401/403 才换 token 重试；其他 4xx 直接抛错。
    """
    global _current_token

    if not _token_candidates and not _current_token:
        raise HTTPException(401, "尚未捕获到任何 Token")

    url = f"{TRADOVATE_API_BASE}{path}"

    candidates = []
    if _current_token:
        candidates.append(_current_token)
    for t in reversed(_token_candidates):
        if t != _current_token:
            candidates.append(t)

    last_status = 0
    for token in candidates:
        ok, status, data = await _try_token(method, url, token, payload)
        if ok:
            if token != _current_token:
                _current_token = token
                logger.info(f"✅ Token 切换为 (长度={len(token)})")
            return data

        # 只有认证失败才换 token
        if status in (401, 403):
            last_status = status
            continue

        # 其他错误（404、400、500 等）直接抛出
        raise HTTPException(status, f"API 错误 [{status}]: {data}")

    raise HTTPException(401, f"所有 Token 均失效 (最后状态码: {last_status})")


async def wait_for_login_and_token(timeout_sec: int = 300) -> bool:
    """等待用户完成登录 + 捕获有效 token"""
    logger.info("=" * 60)
    logger.info("📌 请在弹出的浏览器中手动登录 Tradovate")
    logger.info("   1. 输入用户名密码（含 2FA）")
    logger.info("   2. 如果出现交易模式选择页，点击进入")
    logger.info("   3. 直到看到【市价买入 / 市价卖出】按钮")
    logger.info("=" * 60)

    start = asyncio.get_running_loop().time()
    while asyncio.get_running_loop().time() - start < timeout_sec:
        await page_instance.wait_for_timeout(5000)

        try:
            btns = await page_instance.locator(
                'button:has-text("市价买入"), button:has-text("市价卖出"), '
                'button:has-text("Buy Market"), button:has-text("Sell Market"), '
                'button:has-text("在竞买价买入"), button:has-text("卖出出价")'
            ).count()
            if btns > 0:
                logger.info("✅ 已检测到交易界面按钮")
                await page_instance.wait_for_timeout(5000)
                return True
        except Exception:
            pass

        elapsed = int(asyncio.get_running_loop().time() - start)
        if elapsed % 30 < 5:
            logger.info(f"   ... 等待登录 ({elapsed}s) | 已捕获 {len(_token_candidates)} 个 token")

    logger.warning("⚠️ 等待超时")
    return False


async def auto_fill_form():
    """如果设置了用户名密码，自动填写表单"""
    if not (TRADOVATE_USER and TRADOVATE_PASS):
        return
    try:
        for sel in ['input[name="username"]', 'input[name="name"]', 'input[type="text"]', 'input[type="email"]']:
            loc = page_instance.locator(sel).first
            if await loc.count() > 0:
                await loc.fill(TRADOVATE_USER)
                logger.info("📝 已填用户名")
                break

        pwd = page_instance.locator('input[type="password"]').first
        if await pwd.count() > 0:
            await pwd.fill(TRADOVATE_PASS)
            logger.info("📝 已填密码")

        submit = page_instance.locator('button[type="submit"]').first
        if await submit.count() > 0:
            await submit.click()
        else:
            await pwd.press("Enter")
        logger.info("🔑 已提交登录表单")
    except Exception as e:
        logger.warning(f"⚠️ 自动填写失败: {e}")


async def refresh_account_info():
    global _account_info
    try:
        accounts = await _api_call("GET", "/account/list")
        if not accounts:
            logger.warning("⚠️ 账户列表为空")
            return
        acc = accounts[0]
        _account_info = {
            "accountId": acc.get("id"),
            "accountSpec": acc.get("name"),
            "accountName": acc.get("nickname") or acc.get("name"),
        }
        logger.info(f"✅ 账户已缓存: {_account_info}")
    except Exception as e:
        logger.error(f"❌ 获取账户失败: {e}")


async def resolve_contract(symbol: str) -> Dict[str, Any]:
    """
    把用户输入的品种（如 MES）解析为具体合约（如 MESZ5）。
    优先用 /contract/suggest 模糊搜索，失败则用 /contract/find 精确查找。
    """
    symbol = symbol.upper().strip()

    # 方式 1: suggest 模糊搜索
    try:
        suggestions = await _api_call("GET", f"/contract/suggest?t={symbol}&l=10")
        if suggestions and isinstance(suggestions, list):
            # 优先取名字以 symbol 开头的
            for c in suggestions:
                name = (c.get("name") or "").upper()
                if name.startswith(symbol):
                    logger.info(f"🔍 suggest: {symbol} → {c.get('name')} (id={c.get('id')})")
                    return c
            # 没匹配前缀就用第一个
            first = suggestions[0]
            logger.info(f"🔍 suggest 兜底: {symbol} → {first.get('name')} (id={first.get('id')})")
            return first
    except HTTPException as e:
        logger.warning(f"⚠️ suggest 失败: {e.detail}，尝试 find")

    # 方式 2: find 精确查找
    try:
        contract = await _api_call("GET", f"/contract/find?name={symbol}")
        if contract and contract.get("id"):
            logger.info(f"🔍 find: {symbol} → {contract.get('name')} (id={contract.get('id')})")
            return contract
    except HTTPException as e:
        logger.warning(f"⚠️ find 失败: {e.detail}")

    raise HTTPException(404, f"找不到合约 {symbol}")


@app.on_event("startup")
async def startup_event():
    global playwright_instance, browser_instance, context_instance, page_instance

    mode = "LIVE 🔴" if "live" in TRADOVATE_API_BASE else "DEMO 🟢"
    logger.info(f"🚀 启动 | 环境: {mode} | API: {TRADOVATE_API_BASE} | Headless: {HEADLESS}")

    playwright_instance = await async_playwright().start()
    browser_instance = await playwright_instance.firefox.launch(headless=HEADLESS)
    context_instance = await browser_instance.new_context(viewport={"width": 1920, "height": 1080})
    page_instance = await context_instance.new_page()
    page_instance.on("request", _capture_auth)

    try:
        await page_instance.goto(TRADOVATE_URL, wait_until="domcontentloaded", timeout=60000)
    except Exception as e:
        logger.warning(f"⚠️ 页面加载: {e}")

    await page_instance.wait_for_timeout(3000)
    await auto_fill_form()
    await wait_for_login_and_token(timeout_sec=300)

    if _token_candidates:
        logger.info(f"🔑 共捕获 {len(_token_candidates)} 个 Token，开始验证...")
        await refresh_account_info()
    else:
        logger.error("❌ 未捕获到任何 Token")


@app.on_event("shutdown")
async def shutdown_event():
    for obj, name in [(context_instance, "context"), (browser_instance, "browser"), (playwright_instance, "playwright")]:
        if obj:
            try:
                await obj.stop() if name == "playwright" else await obj.close()
            except Exception:
                pass


class OrderSignal(BaseModel):
    action: str
    symbol: Optional[str] = "MES"
    qty: int = 1
    order_type: str = "Market"


@app.post("/api/place-order")
async def api_place_order(signal: OrderSignal):
    action = signal.action.upper()
    if action not in ["BUY", "SELL"]:
        raise HTTPException(400, "只支持 BUY / SELL")

    if not _account_info.get("accountId"):
        await refresh_account_info()
    if not _account_info.get("accountId"):
        raise HTTPException(500, "账户未就绪")

    symbol = (signal.symbol or "MES").upper().strip()

    # 解析合约
    contract = await resolve_contract(symbol)
    contract_name = contract.get("name", symbol)

    payload = {
        "action": "Buy" if action == "BUY" else "Sell",
        "symbol": contract_name,
        "orderQty": signal.qty,
        "orderType": signal.order_type or "Market",
        "accountSpec": _account_info["accountSpec"],
        "accountId": _account_info["accountId"],
        "isAutomated": True,
    }

    logger.info(f"📤 [下单] {payload}")
    result = await _api_call("POST", "/order/placeOrder", payload)

    reason = result.get("failureReason") or result.get("failureText")
    if reason and reason != "Success":
        raise HTTPException(400, f"下单被拒: {reason}")

    order_id = result.get("orderId")
    logger.info(f"✅ [下单成功] orderId={order_id}")
    return {
        "status": "success",
        "orderId": order_id,
        "symbol": contract_name,
        "action": action,
        "qty": signal.qty,
    }


@app.get("/account-summary")
async def get_account_summary():
    return {
        "status": "success",
        "accounts": await _api_call("GET", "/account/list"),
        "positions": await _api_call("GET", "/position/list"),
        "cash_balances": await _api_call("GET", "/cashBalance/list"),
    }


@app.get("/orders")
async def get_orders():
    return {"status": "success", "orders": await _api_call("GET", "/order/list")}


@app.get("/account-info")
async def get_account_info():
    return {"status": "success", "account": _account_info}


@app.get("/debug-contract")
async def debug_contract(name: str = "MES"):
    """诊断：查看品种解析结果"""
    try:
        suggestions = await _api_call("GET", f"/contract/suggest?t={name}&l=10")
        return {
            "status": "ok",
            "input": name,
            "count": len(suggestions) if isinstance(suggestions, list) else 0,
            "items": suggestions[:5] if isinstance(suggestions, list) else suggestions,
        }
    except HTTPException as e:
        return {"status": "error", "detail": e.detail}
    except Exception as e:
        return {"status": "error", "detail": str(e)}


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "browser_active": page_instance is not None,
        "tokens_captured": len(_token_candidates),
        "current_token_len": len(_current_token),
        "account_ready": bool(_account_info.get("accountId")),
        "env": "live" if "live" in TRADOVATE_API_BASE else "demo",
    }


@app.get("/diagnose")
async def diagnose():
    result = {
        "browser": page_instance is not None,
        "tokens_count": len(_token_candidates),
        "token_lengths": [len(t) for t in _token_candidates],
        "current_token_len": len(_current_token),
        "account_info": _account_info,
    }
    if page_instance:
        try:
            result["url"] = page_instance.url
        except Exception:
            pass

    if _token_candidates:
        try:
            accounts = await _api_call("GET", "/account/list")
            result["api_test"] = f"OK ({len(accounts)} accounts)"
        except Exception as e:
            result["api_test"] = f"FAIL: {e}"
    else:
        result["api_test"] = "SKIP (no token)"

    return result


if __name__ == "__main__":
    import uvicorn
    logger.info(f"⚡ 监听端口: {PORT}")
    uvicorn.run("app:app", host="0.0.0.0", port=PORT, reload=False)