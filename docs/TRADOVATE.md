# Tradovate 数据源接入说明

Tradovate（美股指 / 商品期货行情）作为第二个数据源接入，支持 **live（实盘 / Lucid 考核账号）** 与 **demo（模拟盘）** 两种环境。

## 1. 配置（backend/.env）

```dotenv
TRADOVATE_ENV=live            # live | demo（Lucid 考核账号用 live）
TRADOVATE_USER=xxx            # Tradovate 登录用户名
TRADOVATE_PASSWORD=xxx        # 登录密码
```

- **Lucid 考核平台的 Tradovate 账号无需后台生成 API Key**，直接用「账号 + 密码」请求 Token；
  `appId` / `appVersion` 固定为 `ChartPlatform` / `1.0.0`，`cid=0`、`sec=""`（如需覆盖可设置
  `TRADOVATE_APP_ID` / `TRADOVATE_APP_VERSION` / `TRADOVATE_CID` / `TRADOVATE_SEC`，可选）。
- 后端检测到 `TRADOVATE_USER` 与 `TRADOVATE_PASSWORD` 均配置后即启用该数据源；
  否则 `/api/datasources` 只返回 Binance，前端不显示 Tradovate 切换按钮。
- **凭据务必写入 `backend/.env`（已被 `.gitignore` 忽略）**，不要填进 `.env.example`（模板文件不会被加载）。
- **`.env` 优先于终端/进程环境变量**：若终端残留旧的 `TRADOVATE_ENV`，`.env` 中配置为准。
- **限流提醒**：Tradovate 对 `accesstokenrequest` 限流为**每小时 5 次**，超限返回 `p-ticket/p-time/p-captcha`。
  客户端会自动识别并在 `p-time` 内冷却（前端会显示「鉴权被限流（需人工验证码，约 N 分钟后可重试）」）。
  因此请确认账号密码无误后再启动，避免反复尝试把额度耗尽。
- **live 环境**的 `POST /auth/accesstokenrequest` 需要 `tm-usr`（设备标识）请求头，代码已自动生成。
- Tradovate 的 `mdAccessToken` 有效期较短，客户端在过期前自动重新鉴权；断线自动指数退避重连并恢复订阅。

## 2. 协议实现（backend）

| 模块 | 职责 |
| --- | --- |
| `src/services/TradovateClient.ts` | REST 鉴权 + Market Data WebSocket（authorize / `[]` 心跳 / 请求-响应关联 / 事件路由 / 重连） |
| `src/adapters/TradovateAdapter.ts` | 合约近月解析（`NQ`→`NQU6`）、REST 历史 K 线、quote/dom/tick/K线 订阅与数据清洗 |
| `src/core/MarketManager.ts` | 按 `datasource`（binance/tradovate）路由适配器 |
| `src/core/WebSocketServer.ts` | 支持 `datasource` + `dataType`（kline/quote/dom/tick）广播 |

- **REST 鉴权**：`POST https://demo.tradovateapi.com/v1/auth/accesstokenrequest`（或 live），返回 `accessToken` + `mdAccessToken`。
- **MD WebSocket**：`wss://demo-md.tradovateapi.com/v1/websocket`（demo）/ `wss://md.tradovateapi.com/v1/websocket`（live）。
  现行帧协议：服务器先发 `o` 帧 → 客户端发 `authorize\n<id>\n\n<mdAccessToken>` → 每 ~2.5s 发 `[]` 心跳；
  请求为 `operation\n<id>\n<query>\n<body>`，响应为 `a`+JSON 数组，按 `i` 关联；订阅事件为 `{e, i, d}`。
- **订阅操作**：优先经典驼峰 `md/subscribeQuote`（报价/成交）、`md/subscribeDOM`（盘口）、`md/subscribeChart`（K 线），
  失败自动回退小写新版 `md/subscribequote` / `md/subscribedom` / `md/getchart`。取消操作为对应 `md/unsubscribeQuote` / `md/unsubscribeDOM` / `md/unsubscribeChart` / `md/cancelchart`。
- **数据清洗**：Quotes/DOM/Chart 增量统一转为项目标准 JSON：
  - K 线：`{ time, open, high, low, close, volume }`（时间戳归一化为秒），`hist` 全量通过 `{type:'hist'}` 推送、`upd` 增量通过 `{type:'kline'}` 推送；
  - 报价：`{ symbol, bid, ask, last, size, timestamp }`；
  - 盘口：`{ symbol, levels: [{price, size, side}], timestamp }`（增量 A/U/D 在服务端维护成完整快照）；
  - 成交：`{ symbol, price, size, side, timestamp }`。

## 3. REST / WS 接口

- `GET /api/market?symbol=NQ&interval=1m&datasource=tradovate` — 历史 K 线 + 最新报价
- `GET /api/symbols?datasource=tradovate` — 内置美股指/商品期货清单（自动解析近月合约）
- `GET /api/tickers?datasource=tradovate` — 各合约最新价
- `GET /api/datasources` — 可用数据源列表（前端切换按钮渲染依据）
- WebSocket `/ws?symbol=NQ&interval=1m&datasource=tradovate&dataType=kline|quote|dom|tick`

## 4. 前端

- 顶部新增 **数据源切换**（Binance / Tradovate）与 **视图切换**（K线 / 盘口 / Tick流）。
- 盘口视图：`DepthPanel.vue`（买卖 12 档深度条、点差、最新价）；Tick 视图：`TradeTape.vue`（逐笔成交滚动流）。
- 搜索弹窗新增 **Tradovate Tab**，点击即切换数据源并加载合约列表。
- 盘口 / Tick 视图仅对 Tradovate 数据源开放（Binance 无对应订阅能力）。

> 注意：demo 账号需具备对应交易所的市场数据权限（如 CME），否则 `md/subscribe*` 会返回
> `errorText`（如 “not authorized”）。该错误会通过后端 WS 的 `{type:'error'}` 上报到前端显示。
