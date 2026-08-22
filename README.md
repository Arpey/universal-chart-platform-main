# Universal Chart Platform

本地永续合约 K 线行情终端，当前接入**币安 U 本位永续合约（USDT-M Futures）**，支持全部 USDT 交易对搜索，以及 1m/5m/15m/1h/4h/1d 周期。

- **搜索列表**：右上角搜索按钮打开 TradingView 风格交易对搜索（按 24h 成交额排序，实时显示最新价/涨跌幅/成交额）。
- **数据源**：币安永续 `fapi.binance.com` / `fstream.binance.com`，通过本地代理访问。

## 快速开始

```bash
cd backend && cp .env.example .env && npm install && npm run dev
cd frontend && cp .env.example .env && npm install && npm run dev
```

打开 http://localhost:5173。详细说明见 [docs/SETUP.md](docs/SETUP.md)。

> 注意：后端通过本地代理（默认 `http://127.0.0.1:10808`）访问币安。若币安返回 451（restricted location），说明代理出口在封锁地区，请更换节点国家。
