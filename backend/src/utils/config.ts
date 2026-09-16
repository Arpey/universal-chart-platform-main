import { config as loadDotEnv } from 'dotenv'
import { config as loadDotFile } from 'dotenv'

// .env 优先于终端/进程环境变量（避免残留的旧值如 TRADOVATE_ENV=demo 覆盖 .env 配置），
// 再补 config/<NODE_ENV>.env 作为环境补充（不覆盖 .env 已配置项）。
const nodeEnv = process.env.NODE_ENV ?? 'development'
loadDotEnv({ override: true })
loadDotFile({ path: `${__dirname}/../../config/${nodeEnv}.env`, override: false })

/** IBKR 默认 clientId：后端只维护一条全局连接（IBKRClient 单例），固定编号即可稳定复用同一个 TWS 客户端槽位。 */
const DEFAULT_IBKR_CLIENT_ID = 1

/**
 * 解析 IBKR clientId：
 * - 显式配置了正整数（如 IBKR_CLIENT_ID=42）→ 尊重显式配置；
 * - 未配置 / 0 / 非法值 → 固定使用 DEFAULT_IBKR_CLIENT_ID（1）。
 *
 * 注意：不要每次启动随机生成 clientId —— 整个 backend 只建立一条 IBKR 连接（IBKRClient 单例），
 * 随机 ID 会让 TWS / IB Gateway 的 API 客户端列表在每次重启后多出一条记录，
 * 表现为「TWS 里出现大量客户端连接」。若默认 1 与其它程序冲突（Error/InfoCode 326），
 * 显式设置 IBKR_CLIENT_ID 换一个未被占用的编号即可。
 */
function resolveIBKRClientId(): number {
  const raw = process.env.IBKR_CLIENT_ID
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw)
    if (Number.isInteger(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_IBKR_CLIENT_ID
}

/**
 * 解析 IBKR 断开后的最小重连间隔（毫秒，IBKR_RECONNECT_DELAY_MS）：
 * TWS / IB Gateway 释放旧 clientId 需要时间，过快重连会被登记成新的 API 客户端，
 * 因此默认 30s（下限 1s，避免误配成 0 造成快速重连）。
 */
function resolveIBKRReconnectDelay(): number {
  const parsed = Number(process.env.IBKR_RECONNECT_DELAY_MS ?? 30_000)
  if (!Number.isFinite(parsed) || parsed < 1_000) return 30_000
  return Math.floor(parsed)
}

/** IBKR 行情类型（MarketDataType）：realtime=实时(1) / frozen=冻结(2) / delayed=延迟(3) / delayed-frozen=延迟冻结(4)。 */
export type IBKRMarketDataTypeSetting = 'realtime' | 'frozen' | 'delayed' | 'delayed-frozen'

/**
 * 解析 IBKR_MARKET_DATA_TYPE：
 * - 默认 realtime（已订阅 CME 实时行情时取实时数据，5 秒实时 K 线 / 逐笔才可用）；
 * - 显式配 delayed 可强制使用免费延迟行情（CME 约延迟 10 分钟）；
 * - 配 realtime 但账号无实时权限时，IBKRClient 会依据 IB 的 10167/354 错误自动回退到 delayed，
 *   避免出现「完全拿不到数据」，因此不需要手工在 delayed/realtime 之间来回切换。
 */
function resolveIBKRMarketDataType(): IBKRMarketDataTypeSetting {
  const raw = (process.env.IBKR_MARKET_DATA_TYPE ?? 'realtime').trim().toLowerCase().replace(/_/g, '-')
  if (raw === 'frozen' || raw === 'delayed' || raw === 'delayed-frozen') return raw
  return 'realtime'
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  // 现货（保留，供 BinanceAdapter 使用）
  binanceBaseUrl: process.env.BINANCE_URL ?? 'https://api.binance.com',
  binanceWsUrl: process.env.BINANCE_WS_URL ?? 'wss://stream.binance.com:9443/ws',
  // 数据源：U 本位永续合约（USDT-M Futures）
  futuresBaseUrl: process.env.BINANCE_FUTURES_BASE_URL ?? 'https://fapi.binance.com',
  futuresWsUrl: process.env.BINANCE_FUTURES_WS_URL ?? 'wss://fstream.binance.com/ws',
  // 本地代理（V2rayN 等）。默认 10808 实测可用作 HTTP CONNECT 代理；可用 HTTPS_PROXY 覆盖，例如 http://127.0.0.1:10809
  proxy: (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.BINANCE_PROXY) ?? 'http://127.0.0.1:10808',
  // 数据源：Tradovate（美股指/期货行情，Lucid 考核账号 / demo 模拟盘 / live 实盘）
  // - REST 鉴权: POST {demo|live}.tradovateapi.com/v1/auth/accesstokenrequest
  // - MD WebSocket: wss://demo-md.tradovateapi.com/v1/websocket（demo）/ wss://md.tradovateapi.com/v1/websocket（live）
  // Lucid 考核平台的 Tradovate 账号无需后台生成 API Key，直接用「账号 + 密码」换取 Token；
  // appId/appVersion 固定为平台默认值（ChartPlatform / 1.0.0），cid=0、sec 为空。
  tradovate: {
    enabled: Boolean(process.env.TRADOVATE_USER && process.env.TRADOVATE_PASSWORD),
    env: (process.env.TRADOVATE_ENV ?? 'demo').toLowerCase() === 'live' ? 'live' : 'demo',
    user: process.env.TRADOVATE_USER ?? '',
    password: process.env.TRADOVATE_PASSWORD ?? '',
    // 应用标识（可用 TRADOVATE_APP_ID / TRADOVATE_APP_VERSION 覆盖，默认即考核账号要求的值）
    appId: process.env.TRADOVATE_APP_ID ?? 'ChartPlatform',
    appVersion: process.env.TRADOVATE_APP_VERSION ?? '1.0.0',
    cid: Number(process.env.TRADOVATE_CID ?? 0),
    sec: process.env.TRADOVATE_SEC ?? '',
    baseUrl: (process.env.TRADOVATE_ENV ?? 'demo').toLowerCase() === 'live' ? 'https://live.tradovateapi.com/v1' : 'https://demo.tradovateapi.com/v1',
    mdWsUrl: (process.env.TRADOVATE_ENV ?? 'demo').toLowerCase() === 'live' ? 'wss://md.tradovateapi.com/v1/websocket' : 'wss://demo-md.tradovateapi.com/v1/websocket',
    // Tradovate 专用代理；留空则直连（Tradovate 不受地区封锁，一般无需代理）。可复用 HTTPS_PROXY 的值。
    proxy: process.env.TRADOVATE_PROXY ?? ''
  },
  // 数据源：IBKR（盈透证券，CME 期货行情）
  // - 连接本地 IB Gateway / TWS 的 API 端口（默认 4001，可用 IBKR_PORT 覆盖；IB Gateway 实盘 4001 / 模拟 4002）；
  // - 连接成功后按 IBKR_MARKET_DATA_TYPE 请求行情类型（默认实时 = 1）；无实时权限时自动回退延迟行情（3）。
  ibkr: {
    enabled: process.env.IBKR_ENABLED === 'true',
    // 显式绑定 127.0.0.1，避免 localhost 解析为 IPv6 ::1 导致 TWS/IB Gateway 连接被拒
    host: process.env.IBKR_HOST ?? '127.0.0.1',
    port: Number(process.env.IBKR_PORT ?? 4001),
    clientId: resolveIBKRClientId(),
    // 全局唯一连接断开后的最小重连间隔（毫秒，默认 30s）：给 TWS/IB Gateway 释放旧 clientId 的时间窗，
    // 过快重连会被登记成新的 API 客户端，导致 TWS 客户端列表不断增长
    reconnectDelayMs: resolveIBKRReconnectDelay(),
    // 行情类型：realtime 实时(1) / frozen 冻结(2) / delayed 延迟(3) / delayed-frozen 延迟冻结(4)
    marketDataType: resolveIBKRMarketDataType(),
    // 请求实时行情却被 IB 判定为未订阅（10167/354/10197）时，是否自动回退延迟行情（默认 true）
    fallbackToDelayed: process.env.IBKR_FALLBACK_DELAYED !== 'false',
    // IBKR_DEBUG=true 时输出协议级 sent/received/result 日志，便于握手排障
    debug: process.env.IBKR_DEBUG === 'true'
  },
  // 本地 Playwright 下单服务（Tradovate 交易驱动经其下单 / 撤单 / 查询持仓与账户）
  // - 默认地址 http://localhost:8000，可用 TRADING_SERVICE_URL 覆盖；
  // - TRADING_SERVICE_TIMEOUT 控制单次 HTTP 请求超时（毫秒）。
  tradingService: {
    baseUrl: process.env.TRADING_SERVICE_URL ?? 'http://localhost:8000',
    timeoutMs: Number(process.env.TRADING_SERVICE_TIMEOUT ?? 15000)
  }
}

// ===== TradeFi 白名单分类（基于币安 U 本位合约，非独立数据源） =====
/**
 * 常用 TradFi / 大宗商品 / 美股合约预设（代码内置默认值，可用 TRADEFI_SYMBOLS 覆盖）。
 * 均为币安 USDⓈ-M 合约实际/候选代码，最终会与 fapi/v1/exchangeInfo 实时取交集：
 * 已上架（如 XAUUSDT/XAGUSDT/SPXUSDT 与美股 TradFi 永续）直接展示；尚未上架或已下架
 * 的候选（如股指/能源类变体）自动不可见，避免出现无法拉行情的死标的。
 */
const DEFAULT_TRADEFI_SYMBOLS = [
  // 股指/指数永续
  'SPXUSDT',
  // 贵金属 / 大宗商品（金、银、铜、Tether/Pax 黄金）
  'XAUUSDT', 'XAGUSDT', 'COPPERUSDT', 'XAUTUSDT', 'PAXGUSDT',
  // 美股权益类 TradFi 永续
  'NVDAUSDT', 'TSLAUSDT', 'AAPLUSDT', 'MSFTUSDT', 'AMZNUSDT', 'METAUSDT', 'AVGOUSDT',
  'INTCUSDT', 'IBMUSDT', 'UBERUSDT', 'BABAUSDT', 'SOXLUSDT', 'SQQQUSDT',
  'COINUSDT', 'MSTRUSDT', 'PLTRUSDT', 'ORCLUSDT', 'QCOMUSDT', 'AMDUSDT', 'NFLXUSDT', 'SHOPUSDT',
]

/** tradefi 分类允许的交易对白名单：优先取环境变量；未配置/为空时回退到内置预设列表。 */
export const TRADEFI_SYMBOLS: string[] = (() => {
  const raw = (process.env.TRADEFI_SYMBOLS ?? '').trim()
  if (raw) {
    return raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  }
  return [...DEFAULT_TRADEFI_SYMBOLS]
})()

/** 全部模式（binance）下是否隐藏 TRADEFI_SYMBOLS 中的品种。 */
export const HIDE_TRADEFI_IN_BINANCE = process.env.HIDE_TRADEFI_IN_BINANCE === 'true'
