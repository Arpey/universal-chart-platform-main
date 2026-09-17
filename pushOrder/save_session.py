import asyncio
from playwright.async_api import async_playwright

async def generate_state():
    async with async_playwright() as p:
        print("🌐 正在启动 Playwright 内置 Firefox 浏览器...")
        # 改用 Firefox 内核启动，完美避开 chrome.dll 0x7F 系统 API 错误
        browser = await p.firefox.launch(headless=False)
        context = await browser.new_context()
        page = await context.new_page()

        print("🌐 正在打开 Tradovate 登录页...")
        await page.goto("https://trader.tradovate.com/")

        print("\n" + "="*50)
        print("💡 请在弹出的浏览器中手动完成 2FA 登录。")
        print("💡 登录成功并看到交易主界面后，回到这个控制台/终端，按【Enter 回车键】保存凭证...")
        print("="*50 + "\n")

        # 人工控制：按回车键触发保存
        input("👉 确认已登录完毕？按 Enter 键继续...")

        # 导出凭证
        await context.storage_state(path="state.json")
        print("✅ 登录成功！state.json 文件已生成！")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(generate_state())