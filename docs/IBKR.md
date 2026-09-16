# IBKR（盈透证券）CME 期货行情接入与实时行情排查

IBKR 作为数据源接入 CME/CBOT/COMEX/NYMEX 期货行情（MES/MNQ/MYM/M2K/MGC/MCL/ES/NQ），
后端通过 **IB Gateway / TWS 的 API Socket 端口**（默认 `127.0.0.1:4001`）连接，前端经 WebSocket 控制通道订阅。

## 1. 配置（backend/.env）

```dotenv
IBKR_ENABLED=true
IBKR_HOST=127.0.0.1
IBKR_PORT=4001
# 行情类型：realtime 实时(1，默认) / frozen(2) / delayed 延迟(3) / delayed-frozen(4)
IBKR_MARKET_DATA_TYPE=realtime
# 请求实时行情但无权限（IB 回 10167/354/10197）时是否自动回退延迟行情，默认 true
# IBKR_FALLBACK_DELAYED=false
# clientId：后端只维护**一条**全局 IBKR 连接（IBKRClient 单例），固定使用该编号并一直复用。
# 不配置时默认 1；请勿使用随机编号 —— 每次重启随机换号会让 TWS/IB Gateway 的
# 「API clients」列表不断新增条目（即「TWS 里出现大量客户端连接」）。若默认 1 已被占用（Error 326），
# 在这里换一个未被占用的编号即可。
# IBKR_CLIENT_ID=42
# 断开后的最小重连间隔（毫秒，默认 30000）：给 TWS/IB Gateway 释放旧 clientId 的时间窗
# IBKR_RECONNECT_DELAY_MS=30000
# IBKR_DEBUG=true          # 输出协议级 sent/received/result 日志
```

- 后端**全进程只有一个 IBKRClient 实例**（`getIBKRClient()` 单例，构造函数私有），所有行情订阅、
  历史 K 线、状态查询都复用同一条到 TWS / IB Gateway 的连接；`connect()` 幂等（已连接 / 连接中 / 重连窗口内
  一律跳过），`disconnect()` 会置空并释放底层 socket。想减少 TWS 里看到的客户端数量，
  应在 TWS 的 API 客户端列表中确认只剩后端的这一个 clientId。

- `IBKR_HOST` 必须是 **后端进程所在机器** 上运行 IB Gateway/TWS 的地址。后端部署在云服务器时，
  IB Gateway 也必须装在并登录在那台服务器上（`127.0.0.1` 指向服务器自身，不是你的本地电脑）。
- 新增/变更行情订阅后**必须重新登录 IB Gateway**（行情权限在登录时加载），必要时重启网关进程。

## 2. 行情类型语义（重要）

| 值 | 含义 | 说明 |
| --- | --- | --- |
| 1 | 实时 Live | 需已订阅该交易所实时行情；逐笔（reqTickByTickData）与 5 秒实时 K 线（reqRealTimeBars）可用 |
| 2 | 冻结 Frozen | 休市时返回收盘前最后行情 |
| 3 | 延迟 Delayed | 免费，**CME 约延迟 10 分钟**；逐笔 / 实时 K 线不被支持 |
| 4 | 延迟冻结 | 无订阅 + 休市 |

后端行为：
- 连接成功后按 `IBKR_MARKET_DATA_TYPE` 请求行情类型（默认实时）；
- 收到 IB 的 `marketDataType` 事件即记录**实际生效类型**，并通过 WS `{ type: 'marketdata' }` 推给前端，状态栏显示「实时行情 / 延迟行情」；
- 请求实时但无权限（错误码 10167 / 354 / 10168 / 10197）时自动回退延迟行情，并停用仅实时可用的逐笔 / 实时 K 线请求（避免错误刷屏），保证「没有实时权限也不会完全拿不到数据」。

## 3. 一条命令确认当前拿到的是实时还是延迟

```bash
curl http://<后端地址>:3001/api/ibkr/status
```

返回示例（延迟行情）：

```json
{
  "enabled": true,
  "requested": "realtime",
  "connected": true,
  "requestedMarketDataType": 1,
  "marketDataType": 3,
  "marketDataTypeLabel": "延迟(Delayed，CME 约延迟 10 分钟)",
  "liveData": false,
  "subscriptions": ["MES"],
  "lastTicksAt": { "MES": 1789393259348 },
  "lastTickAt": 1789393259348,
  "lastError": "Requested market data is not subscribed. Displaying delayed market data.（ErrorCode=10167）"
}
```

判读：
- `marketDataType = 1` → 实时行情正常；
- `marketDataType = 3` + `lastError` 含 10167 → **账号在网关当前登录下没有生效的 CME 实时行情权限**（见下一节排查）；
- `marketDataType = null` → 尚未连接或尚未发起过行情请求；
- `connected = false` → 连不上 `IBKR_HOST:IBKR_PORT`（网关未启动/端口不符/未勾选 Enable ActiveX and Socket Clients）。

## 4. 「已订阅行情但仍拿不到实时数据」排查顺序

1. **Client Portal → Settings → Market Data Subscriptions**：确认含 `CME Real-Time (Globex) – Non-Professional`
   （MES/MNQ/ES/NQ/M2K 需要 CME Globex；MYM 属于 CBOT，MGC=COMEX，MCL=NYMEX），状态为 **Active**（不是 Pending，新增订阅可能需最长 24 小时）；
2. **订阅归属**：多账号时行情订阅可绑定到指定账号，须与 IB Gateway 当前登录的账号/用户一致；
3. **重新登录 IB Gateway**：行情权限在登录时加载，订阅变更后不重新登录不会生效；
4. **会话冲突（10197）**：不要用同一 IBKR 用户同时在本地 TWS 与服务器 IB Gateway 登录（会互相抢占实时行情会话）；
5. **网关 API 设置**：Enable ActiveX and Socket Clients 已勾选、Socket 端口 = `IBKR_PORT`、Socket 端口与 Trusted IPs 允许 `127.0.0.1`；建议关闭 Read-Only API；
6. **排查日志**：后端控制台查 `[IBKR] 已请求行情类型: ...`、`[IBKR] 行情类型已切换(reqId=...) -> 实时/延迟`、
   `[IBKR] 实时行情不可用(reqId=..., ErrorCode=10167...)`，需要协议级明细时设 `IBKR_DEBUG=true`；
7. **限制项**：IB 的 market data lines 上限、以及「10 分钟内最多 60 次新实时 K 线请求」的 pacing 限制，
   在多标的/高频切换时可能被拒（错误码 100/101/420 等）。

## 5. 相关接口

- `GET /api/ibkr/status` — 运行状态 / 行情类型 / 订阅 / 最近 tick / 最近错误（诊断首选）
- `GET /api/symbols?source=ibkr` — 内置期货标的清单
- `GET /api/market?source=ibkr&symbol=MES&interval=1m` — 历史 K 线 + 最新价快照
- WebSocket `/ws`（无查询参数 = 控制通道）：
  `{ "action": "subscribe", "source": "IBKR", "symbol": "MES", "interval": "1m" }`
  服务端回推 `ticker` / `kline` / `hist` / `marketdata` / `error`
