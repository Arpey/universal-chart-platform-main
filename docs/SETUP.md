# 本地运行

需要 Node.js 22+。

```bash
cd backend && cp .env.example .env && npm install && npm run dev
cd frontend && cp .env.example .env && npm install && npm run dev
```

浏览器打开 `http://localhost:5173`。后端默认运行在 `http://localhost:3001`。

> 前端 Vite 通过 `--host 127.0.0.1`（见 `frontend/package.json` 的 `dev` 脚本）显式绑定 IPv4，确保浏览器无论将 `localhost` 解析为 `127.0.0.1` 或 `::1` 都能访问。若仍提示"无法访问此网站"，请确认前端 `npm run dev` 已在运行（端口 5173 有监听）。


## 数据源与代理

- 行情来自 **币安 U 本位永续合约（USDT-M Futures）** 公共接口（`fapi.binance.com` / `fstream.binance.com`），不需要 API Key。
- 后端默认通过**本地代理**访问币安：`HTTPS_PROXY=http://127.0.0.1:10808`（V2rayN/Clash 等）。可在 `backend/.env` 用 `HTTPS_PROXY` 覆盖，例如 `http://127.0.0.1:10809`。
  - REST 走 `undici ProxyAgent`，WebSocket 走 `ws` + `HttpsProxyAgent`，二者都支持 HTTP CONNECT 代理。
- 若后端返回 `502` 且消息为 `Service unavailable from a restricted location ... (451)`，表示**代理出口 IP 所在地区被币安封锁**（如美国 IP），请更换代理节点国家（港/日/新等）。
- 若 REST（历史 K 线 / ticker）正常但实时 WS 不推送，通常是代理出口被币安**静默屏蔽 `fstream`**（握手成功但永不推数据）。后端已内置 REST 兜底：WS 超过 20s 无推送自动降级为 `fapi/v1/klines` 轮询保活图表，WS 恢复后自动切回（日志 `启用 REST kline 轮询兜底`）。如需真正实时推送，请更换可访问 `fstream.binance.com` 的代理节点。
- TradeFi 品种（XAUUSDT/SPXUSDT/NVDAUSDT 等）属于币安 `TRADIFI_PERPETUAL` 合约，脚本/代码筛选合约时需同时匹配 `PERPETUAL` 与 `TRADIFI_PERPETUAL`。

## 接口

- `GET /api/market?symbol=BTCUSDT&interval=1m&limit=300` — K 线 + 24h ticker
- `GET /api/symbols` — 全部 USDT 永续合约列表
- `GET /api/tickers` — 全部 USDT 永续合约 24h 行情快照
- `GET /api/health` — 健康检查
- WebSocket `ws://localhost:3001/ws?symbol=BTCUSDT&interval=1m` — 实时 K 线推送
