"""
save_session.py
手动登录 Tradovate，保存完整浏览器状态到 state.json

关键点：
- Tradovate 是 SPA，交易界面在根路径 https://trader.tradovate.com/ 渲染
- 不能靠 URL 路径判断是否登录成功，必须靠 DOM 元素
- 支持中文界面（市价买入 / 市价卖出 / 在竞买价买入 / 卖出出价）
- 保存后验证 Cookies 数量，确保会话有效
"""

import asyncio
import os
import json
import sys
import logging

# ── 屏蔽 Python 3.7 + Playwright 的协程噪音日志 ──
logging.getLogger("asyncio").setLevel(logging.CRITICAL)

from playwright.async_api import async_playwright

STATE_FILE = "state.json"
TRADOVATE_URL = "https://trader.tradovate.com/"


async def is_on_trade_page(page) -> bool:
    """通过 DOM 元素判断是否在交易主界面（兼容中英文界面）"""
    try:
        url = (page.url or "").lower()
        # 明确排除登录/中间页
        if any(p in url for p in ("/welcome", "/login", "/trading-mode")):
            count = await page.locator(
                '.module-container, .chart-module, [data-qa="chart"]'
            ).count()
            return count > 0

        # 方式 1（最可靠）：CSS 类名，不受语言影响
        count = await page.locator(
            '.module-container, .chart-module, [data-qa="chart"], .account-panel'
        ).count()
        if count > 0:
            return True

        # 方式 2：中英文按钮文本
        try:
            trade_buttons = await page.locator(
                # 中文
                'button:has-text("市价买入"), button:has-text("市价卖出"), '
                'button:has-text("在竞买价买入"), button:has-text("卖出出价"), '
                # 英文兼容
                'button:has-text("Buy Market"), button:has-text("Sell Market"), '
                'button:has-text("Buy"), button:has-text("Sell")'
            ).count()
            if trade_buttons > 0:
                return True
        except Exception:
            pass

        # 方式 3：页面文本关键词
        try:
            body_text = await page.evaluate("() => document.body.innerText || ''")
            keywords = [
                "市价买入", "市价卖出", "在竞买价买入", "卖出出价",
                "账户", "持仓", "图表", "下单",
                "Buy", "Sell", "Account", "Position",
            ]
            hits = sum(1 for k in keywords if k in body_text)
            if hits >= 3:
                return True
        except Exception:
            pass

        return False
    except Exception:
        return False


async def get_storage_keys_with_retry(page, max_retries=3):
    """安全读取 localStorage keys，带重试机制"""
    for attempt in range(max_retries):
        try:
            return await page.evaluate("() => Object.keys(localStorage)")
        except Exception as e:
            if "Execution context was destroyed" not in str(e) or attempt == max_retries - 1:
                raise
            print(f"⚠️ 页面导航中，重试 ({attempt + 1}/{max_retries})...")
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=5000)
            except Exception:
                pass
            await page.wait_for_timeout(1000)
    return []


async def main():
    # 清理旧凭证
    if os.path.exists(STATE_FILE):
        try:
            os.remove(STATE_FILE)
            print(f"🧹 已清理旧凭证: {os.path.abspath(STATE_FILE)}")
        except Exception as e:
            print(f"⚠️ 清理旧文件失败: {e}")

    async with async_playwright() as p:
        print("🌐 启动 Playwright Firefox 浏览器...")
        try:
            browser = await p.firefox.launch(headless=False)
        except Exception as e:
            print(f"❌ Firefox 启动失败: {e}")
            print("💡 请先安装: pip install playwright && playwright install firefox")
            sys.exit(1)

        context = await browser.new_context()
        page = await context.new_page()

        print(f"🌐 打开 Tradovate: {TRADOVATE_URL}")
        try:
            await page.goto(TRADOVATE_URL, wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            print(f"⚠️ 打开页面警告: {e}")

        print()
        print("=" * 64)
        print("💡 请在弹出的浏览器中手动完成 Tradovate 登录：")
        print("   1. 输入用户名密码（含 2FA 验证）")
        print("   2. 如果出现交易模式选择页（trading-mode），")
        print("      点击进入模拟盘 / 实盘")
        print("   3. 等待页面渲染出【图表】和【市价买入 / 市价卖出】按钮")
        print("   4. 确认能看到账户面板后，回到终端按【Enter】")
        print("=" * 64)
        print()

        # 循环等待，直到确认在交易界面
        while True:
            input("👉 已登录并看到交易界面？按 Enter 继续...")

            print("⏳ 等待页面稳定...")
            try:
                await page.wait_for_load_state("networkidle", timeout=8000)
            except Exception:
                try:
                    await page.wait_for_load_state("domcontentloaded", timeout=3000)
                except Exception:
                    pass
            await page.wait_for_timeout(2000)

            current_url = page.url
            print(f"📍 当前页面 URL: {current_url}")

            if not await is_on_trade_page(page):
                print("⚠️ 未检测到交易界面元素（图表 / 市价买入按钮 / 账户面板）")
                print("   请确认：")
                print("   1. 已完成登录（含 2FA）")
                print("   2. 已进入模拟盘 / 实盘交易界面")
                print("   3. 页面上能看到【图表】和【市价买入 / 市价卖出】按钮")
                retry = input("👉 按 Enter 重新检查，或输入 q 退出: ").strip().lower()
                if retry == "q":
                    print("❌ 用户放弃，退出。")
                    await browser.close()
                    sys.exit(1)
                continue

            print("✅ 已检测到交易界面元素")
            break

        # 读取 localStorage（仅调试展示）
        print("\n📋 读取 localStorage keys...")
        try:
            keys = await get_storage_keys_with_retry(page)
            print(f"   共 {len(keys)} 个 key")

            auth_keys = [k for k in keys if any(
                s in k.lower() for s in ["token", "auth", "session"]
            )]
            if auth_keys:
                print(f"   认证相关 key: {auth_keys}")
            else:
                print("   （未发现认证 key，Tradovate 使用 Cookie 认证）")
        except Exception as e:
            print(f"⚠️ 读取 localStorage 失败: {e}")

        # 保存 storage_state
        try:
            await context.storage_state(path=STATE_FILE)
            print(f"\n✅ state.json 已保存: {os.path.abspath(STATE_FILE)}")
        except Exception as e:
            print(f"❌ 保存 state.json 失败: {e}")
            await browser.close()
            sys.exit(1)

        # 验证 state.json
        print("\n🔍 验证 state.json...")
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                state = json.load(f)

            cookies_count = len(state.get("cookies", []))
            origins_count = len(state.get("origins", []))
            print(f"   Cookies: {cookies_count} 条")
            print(f"   Origins: {origins_count} 个")

            cookie_names = [c.get("name", "") for c in state.get("cookies", [])]
            auth_cookies = [n for n in cookie_names if any(
                s in n.lower() for s in ["token", "auth", "session", "sid"]
            )]
            if auth_cookies:
                print(f"   认证相关 Cookie: {auth_cookies}")

            if cookies_count >= 10:
                print("\n🎉 会话凭证保存成功！")
                print("   ⚠️ Tradovate Token 有效期约 80 分钟，请尽快启动服务")
                print("   下一步: python app.py")
            else:
                print(f"\n⚠️ Cookies 数量偏少 ({cookies_count})，可能未正确登录")
                print("   建议: 重新运行 save_session.py")
        except Exception as e:
            print(f"⚠️ 验证 state.json 时出错: {e}")

        print("\n✅ 浏览器即将关闭...")
        await browser.close()
        print("✅ 完成。")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n⏹️ 用户中断操作。")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ 脚本失败: {e}")
        print("💡 检查 Playwright: pip install playwright && playwright install firefox")
        sys.exit(1)