# Universal Chart Platform

本地期货/加密 K 线行情终端。当前接入两个数据源：
- **Binance U 本位永续合约（USDT-M Futures）**（默认）：全部 USDT 交易对搜索，1m/5m/15m/1h/4h/1d 周期。
- **Tradovate 美股指/期货（demo/live）**：NQ/ES/MNQ 等股指与商品期货，支持 K 线、盘口订单簿（DOM）与 Tick 逐笔流，详见 [docs/TRADOVATE.md](docs/TRADOVATE.md)。

## 快速开始

```bash
cd backend && cp .env.example .env && npm install && npm run dev
cd frontend && cp .env.example .env && npm install && npm run dev
```

打开 http://localhost:5173。详细说明见 [docs/SETUP.md](docs/SETUP.md)。

> 注意：后端默认通过本地代理（`http://127.0.0.1:10808`）访问币安。若币安返回 451（restricted location），说明代理出口在封锁地区，请更换节点国家。Tradovate 一般直连即可（`TRADOVATE_PROXY` 留空）。
