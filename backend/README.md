# Backend

Node.js + Express + WebSocket market gateway. 接入**币安 U 本位永续合约（USDT-M Futures）**：REST 拉取 K 线 / 24h ticker / 全部交易对行情，WebSocket 转发实时 K 线。

```bash
cp .env.example .env
npm install
npm run dev
```

默认通过本地代理访问币安（`HTTPS_PROXY`，默认 `http://127.0.0.1:10808`）。

Endpoints: `GET /health`、`GET /api/market?symbol=BTCUSDT&interval=1m&limit=300`、`GET /api/symbols`、`GET /api/tickers`、WebSocket `/ws?symbol=BTCUSDT&interval=1m`。
