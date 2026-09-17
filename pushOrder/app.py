import os
import asyncio
import httpx
from typing import Optional, Dict, Any
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from playwright.async_api import async_playwright, Browser, BrowserContext, Page

# ================= 1. 全局配置与状态 =================
STATE_FILE = "state.json"           # 登录凭证持久化文件
TRADOVATE_URL = "https://trader.tradovate.com/"
# 如果是实盘账号请更改为: "https://live.tradovateapi.com/v1"
TRADOVATE_API_BASE = "https://demo.tradovateapi.com/v1"
PORT = 8000                         # 服务端口

app = FastAPI(
    title="Tradovate Light Executor & Monitor",
    description="基于 Playwright 的 Tradovate 零延迟发单、持仓监控与指定品种撤单微服务"
)

playwright_instance = None
browser_instance: Optional[Browser] = None
context_instance: Optional[BrowserContext] = None
page_instance: Optional[Page] = None
lock = asyncio.Lock()

latest_positions_cache: Dict[str, Any] = {}


# ================= 2. 请求 Payload 结构定义 =================
class OrderSignal(BaseModel):
    action: str                        # BUY, SELL, CANCEL_ALL, FLATTEN
    symbol: Optional[str] = "MES"      # 合约代码/品种 (例如 MES, MNQ, MCL)
    qty: int = 1                       # 数量
    order_type: str = "MARKET"


# ================= 3. 拦截与生命周期 =================
async def handle_response(response):
    global latest_positions_cache
    try:
        url = response.url
        if "position/list" in url or "position/deps" in url:
            if response.status == 200:
                data = await response.json()
                latest_positions_cache["data"] = data
                latest_positions_cache["updated_at"] = asyncio.get_event_loop().time()
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

    print("🚀 [系统启动] 正在初始化 Playwright 常驻 Firefox 无头浏览器...")
    playwright_instance = await async_playwright().start()

    # 采用 Firefox 内核避开 Windows Server 下 chromium 的 chrome.dll 0x7F 错误
    browser_instance = await playwright_instance.firefox.launch(
        headless=True
    )

    if os.path.exists(STATE_FILE):
        print(f"🔑 正在读取凭证文件 {STATE_FILE}...")
        context_instance = await browser_instance.new_context(storage_state=STATE_FILE)
    else:
        print("⚠️ 警告: 未找到 state.json 凭证文件！")
        context_instance = await browser_instance.new_context()

    page_instance = await context_instance.new_page()

    page_instance.on("response", handle_response)
    await page_instance.route("**/*", block_unnecessary_resources)

    print(f"🌐 正在预热载入 Tradovate 页面: {TRADOVATE_URL}")
    try:
        await page_instance.goto(TRADOVATE_URL, wait_until="networkidle", timeout=60000)
        print("✅ [系统就绪] Tradovate DOM 结构与 Session 会话加载完成！")
    except Exception as e:
        print(f"⚠️ 预热页面提示: {e}")


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
async def get_symbol_container(symbol: str):
    """在 Tradovate 界面寻找包含指定品种的专用 Module DOM 节点"""
    global page_instance
    if not symbol:
        return page_instance

    clean_symbol = symbol.upper().strip()
    modules = page_instance.locator(f'.module-container:has-text("{clean_symbol}"), .chart-module:has-text("{clean_symbol}"), div[data-symbol*="{clean_symbol}"]')
    count = await modules.count()

    if count > 0:
        print(f"🔍 成功定位到品种 [{clean_symbol}] 的专属 DOM 模块容器")
        return modules.first
    else:
        print(f"ℹ️ 未找到 [{clean_symbol}] 的独立 DOM 模块，将在全局区域执行操作")
        return page_instance


async def get_tradovate_token() -> str:
    """从 Playwright 浏览器的 LocalStorage/SessionStorage 提取 API 访问 Token"""
    global page_instance
    if not page_instance:
        return ""

    try:
        token = await page_instance.evaluate("""() => {
            // 深入扫描 LocalStorage 提取认证 Token
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                const val = localStorage.getItem(key);
                if (val && val.includes("accessToken")) {
                    try {
                        const parsed = JSON.parse(val);
                        if (parsed.accessToken) return parsed.accessToken;
                    } catch(e){}
                }
            }
            return localStorage.getItem("accessToken") || localStorage.getItem("auth_token") || "";
        }""")
        return token
    except Exception as e:
        print(f"❌ 提取 AccessToken 失败: {e}")
        return ""


# ================= 5. API 路由定义 =================

@app.post("/webhook")
async def handle_webhook(signal: OrderSignal):
    """
    【统一 Webhook 接口】通过 DOM 仿真点击快速发单
    - BUY: 买入指定品种
    - SELL: 卖出指定品种
    - CANCEL_ALL: 撤销所有挂单
    - FLATTEN: 一键平仓并全撤
    """
    global page_instance, lock
    action = signal.action.upper()
    symbol = signal.symbol.upper() if signal.symbol else "MES"

    if action not in ["BUY", "SELL", "CANCEL_ALL", "FLATTEN"]:
        raise HTTPException(status_code=400, detail="Action 参数无效")

    async with lock:
        if not page_instance:
            raise HTTPException(status_code=500, detail="浏览器实例未就绪")

        try:
            scope = await get_symbol_container(symbol)

            if action == "CANCEL_ALL":
                btn = scope.locator('button:has-text("Cancel All"), button:has-text("Cancel Orders")').first
                await btn.wait_for(state="visible", timeout=3000)
                await btn.click()
                print(f"🛑 [撤单成功] 已取消品种 [{symbol}] 的所有挂单！")
                return {"status": "success", "action": "CANCEL_ALL", "symbol": symbol, "message": f"已取消 {symbol} 所有挂单"}

            elif action == "FLATTEN":
                btn = scope.locator('button:has-text("Flatten"), button:has-text("Exit & Cancel")').first
                await btn.wait_for(state="visible", timeout=3000)
                await btn.click()
                print(f"💥 [紧急平仓] 已平仓并撤销品种 [{symbol}] 的所有头寸！")
                return {"status": "success", "action": "FLATTEN", "symbol": symbol, "message": f"已一键平仓并全撤 {symbol}"}

            else:
                button_text = "Buy Market" if action == "BUY" else "Sell Market"
                btn = scope.locator(f'button:has-text("{button_text}")').first
                await btn.wait_for(state="visible", timeout=3000)
                await btn.click()
                print(f"🎯 [发单成功] 品种 [{symbol}] 已点击【{button_text}】！")

                return {
                    "status": "success",
                    "action": action,
                    "symbol": symbol,
                    "qty": signal.qty
                }

        except Exception as e:
            print(f"❌ [操作异常]: {str(e)}")
            raise HTTPException(status_code=500, detail=f"执行 {symbol} 的 {action} 指令失败: {str(e)}")


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
    高精度获取完整账户列表、实时资金/余额状态与当前所有持仓。
    """
    token = await get_tradovate_token()
    if not token:
        raise HTTPException(status_code=401, detail="无法从当前浏览器 Session 中提取到有效 AccessToken，请重新获取 state.json")

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json"
    }

    async with httpx.AsyncClient() as client:
        try:
            # 1. 请求账户列表
            accounts_res = await client.get(f"{TRADOVATE_API_BASE}/account/list", headers=headers)
            
            # 2. 请求持仓列表
            positions_res = await client.get(f"{TRADOVATE_API_BASE}/position/list", headers=headers)
            
            # 3. 请求资金与余额明细
            cash_res = await client.get(f"{TRADOVATE_API_BASE}/cashBalance/list", headers=headers)

            return {
                "status": "success",
                "source": "REST_API_DIRECT",
                "accounts": accounts_res.json() if accounts_res.status_code == 200 else [],
                "positions": positions_res.json() if positions_res.status_code == 200 else [],
                "cash_balances": cash_res.json() if cash_res.status_code == 200 else []
            }
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"REST API 查询异常: {str(e)}")


@app.get("/positions")
async def get_positions():
    """多级降级持仓查询接口（优先 API，其次 DOM/网络拦截）"""
    try:
        # 优先使用 REST API 精准持仓
        return await get_account_summary()
    except Exception:
        # API 失败时降级回 DOM 获取
        global page_instance, latest_positions_cache
        if not page_instance:
            raise HTTPException(status_code=500, detail="浏览器未就绪")

        positions = []
        rows = page_instance.locator('.position-row, tr[data-position-id]')
        count = await rows.count()

        if count > 0:
            for i in range(count):
                row_text = await rows.nth(i).inner_text()
                parsed_text = [item.strip() for item in row_text.split('\n') if item.strip()]
                positions.append({"row_index": i, "details": parsed_text})
            return {"status": "success", "source": "DOM_FALLBACK", "positions": positions}

        return {"status": "success", "source": "CACHE_FALLBACK", "positions": latest_positions_cache.get("data", [])}


@app.get("/health")
async def health_check():
    return {"status": "ok", "browser_active": page_instance is not None}


if __name__ == "__main__":
    import uvicorn
    print(f"⚡ 服务已开启，监听端口: {PORT}")
    uvicorn.run("app:app", host="0.0.0.0", port=PORT, reload=False)