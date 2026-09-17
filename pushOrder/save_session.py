"""
Tradovate 登录凭证（state.json）生成脚本。

流程：清理旧凭证 → 打开 Firefox 手动登录（2FA）→ 回车触发保存 → 打印 localStorage 键列表
      → 导出 state.json → 校验其中是否含 Tradovate 的 localStorage 条目。
"""

import asyncio
import json
import os

from playwright.async_api import Error as PlaywrightError, async_playwright

# 与 app.py 保持一致：state.json 固定落在脚本所在目录（不受启动时的工作目录影响）
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(BASE_DIR, "state.json")
TRADOVATE_URL = os.environ.get("TRADOVATE_URL", "https://trader.tradovate.com/")

LOCAL_STORAGE_KEYS_JS = """() => {
    const keys = [];
    try {
        for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    } catch (e) {}
    return keys;
}"""


async def generate_state() -> None:
    # 1) 打开页面前先清理旧 state.json，避免残留凭证干扰本次登录
    if os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)
        print(f"🧹 已清理旧凭证文件: {STATE_FILE}")
    else:
        print(f"ℹ️ 未发现旧凭证文件，无需清理: {STATE_FILE}")

    try:
        async with async_playwright() as p:
            print("🌐 正在启动 Playwright 内置 Firefox 浏览器...")
            # 改用 Firefox 内核启动，完美避开 chrome.dll 0x7F 系统 API 错误
            browser = await p.firefox.launch(headless=False)
            try:
                context = await browser.new_context()
                page = await context.new_page()

                print("🌐 正在打开 Tradovate 登录页...")
                await page.goto(TRADOVATE_URL)

                print("\n" + "=" * 50)
                print("💡 请在弹出的浏览器中手动完成 2FA 登录。")
                print("💡 登录成功并看到交易主界面后，回到这个控制台/终端，按【Enter 回车键】保存凭证...")
                print("=" * 50 + "\n")

                # 人工控制：按回车键触发保存
                input("👉 确认已登录完毕？按 Enter 键继续...")

                # 2) 保存前先打印 localStorage 的 key 列表（确认登录会话已写入浏览器）
                local_keys = await page.evaluate(LOCAL_STORAGE_KEYS_JS)
                print(f"🔑 当前 localStorage key（共 {len(local_keys)} 个）: {local_keys}")

                # 3) 导出凭证
                await context.storage_state(path=STATE_FILE)
                print(f"✅ 登录凭证已导出: {STATE_FILE}")

                # 4) 校验导出内容确实包含 Tradovate 的 localStorage 条目
                has_tradovate_origin = False
                local_entries = 0
                try:
                    with open(STATE_FILE, "r", encoding="utf-8") as fp:
                        state = json.load(fp)
                    for origin in state.get("origins") or []:
                        if "tradovate" not in str(origin.get("origin", "")).lower():
                            continue
                        has_tradovate_origin = True
                        local_entries += len(origin.get("localStorage") or [])
                except Exception as exc:
                    print(f"⚠️ 读取 {STATE_FILE} 校验失败: {exc}")

                if has_tradovate_origin and local_entries > 0:
                    print(f"✅ 校验通过：state.json 含 Tradovate localStorage 条目 {local_entries} 条")
                else:
                    print("⚠️ 可能登录未完成：state.json 中未发现 tradovate 的 localStorage 条目，请重新登录后再保存。")
            finally:
                await browser.close()
    except PlaywrightError as exc:
        print(f"❌ Firefox 启动/运行失败: {exc}")
        print("💡 请检查 Playwright 安装：pip install playwright && playwright install firefox")
    except Exception as exc:
        print(f"❌ 执行失败: {exc}")


if __name__ == "__main__":
    asyncio.run(generate_state())
