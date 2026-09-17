import {
  IBApi,
  EventName,
  ErrorCode,
  SecType,
  MarketDataType,
  TickByTickDataType,
  BarSizeSetting,
  WhatToShow,
} from '@stoqey/ib'
import type { Contract, ContractDetails, TickType } from '@stoqey/ib'
import { IBKR_BAR_SIZE, ibkrHistoryDuration } from '../core/intervals'
import { config } from '../utils/config'
import type { IBKRMarketDataTypeSetting } from '../utils/config'
import { logger } from '../utils/logger'
import type { Interval, Kline } from '../types/kline'

/** IBKR 行情合并后输出的标准化 tick（不含 type/source，由适配器补全） */
export interface IBKRTick {
  symbol: string
  price: number
  size: number
  timestamp: number
}

/**
 * IBKR 运行状态快照（GET /api/ibkr/status）。
 * 「拿不到实时行情」时先看这里的 marketDataType：1=实时 / 3=延迟（约延迟 10 分钟）。
 */
export interface IBKRStatus {
  host: string
  port: number
  clientId: number
  connected: boolean
  /** 配置请求的行情类型（1=实时 … 3=延迟） */
  requestedMarketDataType: number
  /** IB 实际返回的行情类型（1=实时 3=延迟）；尚未收到 IB 通知时为 null */
  marketDataType: number | null
  marketDataTypeLabel: string
  /** 是否具备实时行情（收到延迟/冻结类型或「未订阅」错误后为 false） */
  liveData: boolean
  /** 当前活跃的行情订阅（合约代码） */
  subscriptions: string[]
  /** 各合约最近一次 tick 的接收时间（epoch ms） */
  lastTicksAt: Record<string, number>
  /** 最近一次 tick 的接收时间（epoch ms，0 表示本次连接尚无 tick） */
  lastTickAt: number
  /** 最近一次行情错误的原始文本（空串表示无） */
  lastError: string
}

/** IBKR ErrorCode → 中文排查提示（关键握手错误码，控制台可直接定位问题）。 */
const IBKR_ERROR_HINTS: Partial<Record<number, string>> = {
  [ErrorCode.CONNECT_FAIL]: '无法连接 TWS/IB Gateway：请确认「API 设置 → Enable ActiveX and Socket Clients」已勾选、Socket 端口与 IBKR_PORT 一致、IP 白名单包含 127.0.0.1',
  [ErrorCode.NOT_CONNECTED]: '未连接（握手未完成）：请确认 IB Gateway/TWS 已启动且登录完成，端口未被占用',
  [ErrorCode.UPDATE_TWS]: 'TWS 版本过旧，请升级',
  [ErrorCode.MISSING_ORDER_EXCHANGE]: 'Read-only API 或缺少交易所信息：请在 IB Gateway API 设置中关闭 Read-Only API，并核对合约 Exchange',
  [ErrorCode.REQ_MKT_DATA_NOT_AVAIL]: '请求的行情未订阅（延迟行情不可用）：请检查账户行情订阅或稍后重试',
  [ErrorCode.NO_TRADING_PERMISSIONS]: '无该合约的交易权限',
  [ErrorCode.UNKNOWN_CONTRACT]: '无法识别合约：请核对 Symbol/SecType/Exchange/Currency',
  [ErrorCode.ALREADY_CONNECTED]: '重复连接：请检查是否有其他客户端占用同一 clientId',
  [ErrorCode.PART_OF_REQUESTED_DATA_NOT_SUBSCRIBED]: '部分请求的行情未订阅',
  [ErrorCode.DISPLAYING_DELAYED_DATA]: '显示延迟数据（未订阅该交易所实时行情，属提示；延迟数据 CME 约延迟 10 分钟）',
  [ErrorCode.FAIL_SEND_REQHISTDATA]: '历史数据请求发送失败（可能触发 IBKR 请求频率限制）',
  [ErrorCode.FAIL_SEND_REQRTBARS]: '实时 K 线请求发送失败',
  10168: '请求的行情未订阅且无延迟行情：请核对行情订阅与合约参数',
  10197: '与同一 IBKR 用户的另一实时会话冲突：请勿在本地 TWS 与服务器 IB Gateway 同时登录同一用户',
}

/**
 * 各周期对应的 IBKR barSize（reqHistoricalData 用；实时 K 线为逐笔 tick 聚合，不使用上游 bar 周期）。
 * 唯一来源：`core/intervals.IBKR_BAR_SIZE`（'1 min' / '5 mins' / … 与 BarSizeSetting 枚举值一致），
 * 前后端周期映射因此不会各写一份而出现「请求周期与实拉周期不一致」。
 */
const HISTORICAL_BAR_SIZE: Record<Interval, BarSizeSetting> = IBKR_BAR_SIZE as unknown as Record<Interval, BarSizeSetting>

/** 配置字符串 → IB MarketDataType 数值（1=实时 2=冻结 3=延迟 4=延迟冻结）。 */
const MARKET_DATA_TYPE_VALUES: Record<IBKRMarketDataTypeSetting, MarketDataType> = {
  realtime: MarketDataType.REALTIME,
  frozen: MarketDataType.FROZEN,
  delayed: MarketDataType.DELAYED,
  'delayed-frozen': MarketDataType.DELAYED_FROZEN,
}

/** MarketDataType 数值 → 中文名（日志 / 前端状态展示用）。 */
const MARKET_DATA_TYPE_LABELS: Record<number, string> = {
  1: '实时(Live)',
  2: '冻结(Frozen)',
  3: '延迟(Delayed，CME 约延迟 10 分钟)',
  4: '延迟冻结(Delayed Frozen)',
}

/**
 * 连接生命周期参数（全局唯一连接，见文件末尾 getIBKRClient）：
 * - CONNECT_HANDSHAKE_TIMEOUT_MS：发出 socket 连接后等待 connected / disconnected 事件的上限。
 *   超时会主动释放半开连接（TCP 已建但 IB 握手未完成 —— 否则该 socket 会一直占着 TWS 的客户端槽位
 *   且永远不自己断开）并按重连间隔重试；
 * - RECONNECT_DELAY_MS：断开后允许再次连接的最小间隔（默认 30s，可用 IBKR_RECONNECT_DELAY_MS 覆盖）。
 *   TWS / IB Gateway 释放旧 clientId 需要时间，过快重连会被登记成「又一个 API 客户端」，
 *   表现为 TWS 里出现大量客户端连接，因此断开后必须等满该时间窗再重连；
 * - DISCONNECT_SETTLE_MS：disconnect() 后等待 socket 关闭（FIN/RST）落地的时间，避免同一 tick 内立刻重连。
 */
const CONNECT_HANDSHAKE_TIMEOUT_MS = 15_000
const RECONNECT_DELAY_MS = config.ibkr.reconnectDelayMs
const DISCONNECT_SETTLE_MS = 1_000

/** setTimeout 的 Promise 封装（连接 / 重连等待用）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 「实时行情不可用」错误码：收到后需停用仅实时可用的 reqTickByTickData，
 * 并按配置回退延迟行情（否则会只拿到空数据或错误刷屏）。
 * - 354：请求的行情未订阅（延迟行情也不可用）；
 * - 10167：请求的行情未订阅，IB 改为推送延迟行情；
 * - 10168：请求的行情未订阅且延迟行情不可用；
 * - 10197：与同一用户的另一实时会话冲突（本地 TWS 与服务器 IB Gateway 同时登录同一用户）。
 */
const LIVE_DATA_UNAVAILABLE_CODES: number[] = [
  ErrorCode.REQ_MKT_DATA_NOT_AVAIL,
  ErrorCode.DISPLAYING_DELAYED_DATA,
  10168,
  10197,
]

/** 时区名（如 "US/Central"）→ 该时区相对 UTC 的偏移（毫秒，含 DST）。Intl 不支持时回退 0（按 UTC）。 */
function timezoneOffsetMs(zone: string, epochMs: number): number {
  if (!zone) return 0
  try {
    const opts: Intl.DateTimeFormatOptions = { timeZone: zone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }
    const utc = new Date(new Date(epochMs).toLocaleString('en-US', { ...opts, timeZone: 'UTC' }))
    const zoned = new Date(new Date(epochMs).toLocaleString('en-US', opts))
    return zoned.getTime() - utc.getTime()
  } catch {
    return 0
  }
}

/**
 * 解析 IBKR historicalData 事件的时间字段为真实 UTC epoch 毫秒。
 * - formatDate=2 时通常为 10 位 epoch 秒字符串；
 * - formatDate=1 时为 "yyyyMMdd HH:mm:ss"，且带交易所时区名后缀（如 "20260826 20:33:00 US/Central"），
 *   会按该时区把墙上时钟转成真实 UTC（含 DST），保证图表时间正确、分页边界连续；
 * - 日线固定为 yyyyMMdd（无时区后缀 → 按 UTC 处理）。
 */
function parseBarTime(date: string): number {
  const s = date.trim()
  if (/^\d{10}$/.test(s)) return parseInt(s, 10) * 1000 // epoch 秒 → 毫秒
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\s+([A-Za-z_./-]+))?$/)
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', se = '0', tz = ''] = m
    const wallUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se))
    // 交易所时区墙上时钟 → 真实 UTC：wall - offset
    return wallUtc - timezoneOffsetMs(tz, wallUtc)
  }
  return Date.now()
}

/**
 * epoch 毫秒 → IBKR reqHistoricalData 的 endDateTime（yyyyMMdd-HH:mm:ss，UTC）。
 * 实测本网关将 endDateTime 按 UTC 解释（与 K 线时间戳的交易所时区无关），
 * 因此必须输出 UTC 墙上时钟，保证分页回环时新旧两段 K 线边界连续（无断层/无重叠）。
 */
function formatIBDateTime(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

type TickListener = (tick: IBKRTick) => void
type StatusListener = (connected: boolean, error?: Error) => void
/** 行情类型变更回调（1=实时 2=冻结 3=延迟 4=延迟冻结）。 */
type MarketDataTypeListener = (marketDataType: number) => void

/**
 * CME 期货标的配置（单一数据源：搜索弹窗 get_symbols / /api/symbols 返回，与订阅契约共用）。
 * 注意：此处仅为展示列表；实际订阅前会通过 resolveContract()（reqContractDetails）解析出真实近月合约。
 */
export interface IBKRContractMeta {
  symbol: string
  name: string
  exchange: string
  secType: string
}

export const IBKR_CME_SYMBOLS: IBKRContractMeta[] = [
  { symbol: 'MES', name: 'Micro E-mini S&P 500', exchange: 'CME', secType: 'FUT' },
  { symbol: 'MNQ', name: 'Micro E-mini Nasdaq 100', exchange: 'CME', secType: 'FUT' },
  { symbol: 'MYM', name: 'Micro E-mini Dow Jones', exchange: 'CBOT', secType: 'FUT' },
  { symbol: 'M2K', name: 'Micro E-mini Russell 2000', exchange: 'CME', secType: 'FUT' },
  { symbol: 'MGC', name: 'Micro Gold', exchange: 'COMEX', secType: 'FUT' },
  { symbol: 'MCL', name: 'Micro WTI Crude Oil', exchange: 'NYMEX', secType: 'FUT' },
  { symbol: 'ES',  name: 'E-mini S&P 500', exchange: 'CME', secType: 'FUT' },
  { symbol: 'NQ',  name: 'E-mini Nasdaq 100', exchange: 'CME', secType: 'FUT' },
]

/**
 * 订阅契约：由 IBKR_CME_SYMBOLS 派生，仅用于校验与展示。
 * 实际订阅前会通过 reqContractDetails 解析出真实近月合约（含 conId / lastTradeDateOrContractMonth /
 * localSymbol / tradingClass），因为直接用 FUT 且不带到期月请求行情/历史K线，TWS 会返回
 * Error 200/321（合约描述不清楚，必须指定 localSymbol 或到期月）；部分旧版 IB Gateway 亦不认 CONTFUT。
 */
const CONTRACTS: Record<string, Contract> = Object.fromEntries(
  IBKR_CME_SYMBOLS.map((s): [string, Contract] => [
    s.symbol,
    { symbol: s.symbol, secType: s.secType as SecType, exchange: s.exchange, currency: 'USD' },
  ]),
)

export const IBKR_SYMBOLS = IBKR_CME_SYMBOLS.map((s) => s.symbol)

interface ActiveSubscription {
  symbol: string
  contract: Contract
}

/** 历史 K 线请求的挂起状态（reqHistoricalData 事件驱动完成）。 */
interface HistoricalPending {
  bars: Kline[]
  onDone: (rows: Kline[]) => void
  onFail: (err: Error) => void
}

/** 合约解析请求的挂起状态（reqContractDetails 事件驱动完成）。 */
interface ContractPending {
  details: ContractDetails[]
  onDone: () => void
  onFail: (err: Error) => void
}

/**
 * IBKR（盈透证券）底层行情客户端：
 * - 连接本地 IB Gateway / TWS（默认端口 4001，可用 IBKR_PORT 覆盖），host 固定 127.0.0.1；
 * - 连接成功后按 IBKR_MARKET_DATA_TYPE 请求行情类型：默认实时（REALTIME=1）；显式配 delayed 可强制免费延迟行情；
 *   若账号/会话无实时权限（IB 返回 10167/354/10197），自动回退延迟行情（DELAYED=3）并停用仅实时可用的请求，
 *   保证「没有实时权限也不会完全拿不到数据」；
 * - 实时行情下每个合约发起 reqMktData + reqTickByTickData(AllLast)，
 *   监听 tickPrice / tickSize / tickByTickAllLast 合并为 { symbol, price, size, timestamp }，
 *   实时 K 线由上层（IBKRAdapter + KlineAggregator）用这些 tick 聚合得到（250ms 级刷新）；
 *   延迟行情下仅保留 reqMktData（延迟 tick），逐笔会被 IB 拒绝，故不发；
 * - getHistoricalKlines 通过 reqHistoricalData 一次性拉取历史 K 线（带超时保护）；
 * - 断线自动重连（断开后固定等待 RECONNECT_DELAY_MS，默认 30s），重连后重新设置行情类型并恢复全部订阅。
 *
 * 单例：构造函数私有，只能通过 getIBKRClient() / IBKRClient.getInstance() 获取全局唯一实例。
 * 每个 IBApi 实例都会向 TWS / IB Gateway 注册一个 API 客户端，重复实例化正是
 * 「TWS 里出现大量客户端连接」的根因，因此整个 backend 只允许存在一条 IBKR 连接。
 */
export class IBKRClient {
  /** 全局唯一实例（单例） */
  private static instance: IBKRClient | null = null

  private ib: IBApi | null = null
  private readonly host: string
  private readonly port: number
  private readonly clientId: number

  private connected = false
  /** 是否已下发 socket 连接、正在等待握手结果（由 connected / disconnected 事件结算） */
  private connecting = false
  private stopped = false
  private connectionError = ''
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  /** 握手看门狗：仅在 connected / disconnected 事件丢失时复位 connecting，不新建连接 */
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  /** 底层 TCP socket 是否处于「已创建 / 未确认关闭」状态（握手完成前后都为 true，close 事件 / 释放后置 false） */
  private socketOpen = false
  /** 最近一次断开时间（epoch ms）：用于强制「断开 → 重连」之间的最小间隔 */
  private lastDisconnectAt = 0

  // ---- 行情类型（实时 / 延迟）状态 ----
  private readonly marketDataTypeListeners = new Set<MarketDataTypeListener>()
  /** 配置请求的行情类型（构造时确定，见 config.ibkr.marketDataType） */
  private readonly requestedMarketDataType: MarketDataType
  /** IB 实际返回的行情类型（1=实时 3=延迟…）；尚未收到 IB 通知时为 null */
  private marketDataType: number | null = null
  /** 是否具备实时行情：门控仅实时可用的 reqTickByTickData */
  private liveData: boolean
  /** 是否已因「无实时权限」自动回退延迟行情（避免反复切换） */
  private fallbackApplied = false
  /** 最近一次行情错误的原始文本（诊断用） */
  private lastError = ''
  /** 最近一次 tick 的接收时间（诊断用） */
  private lastTickAt = 0

  private readonly tickListeners = new Set<TickListener>()
  private readonly statusListeners = new Set<StatusListener>()

  private nextReqId = 1
  private readonly symbolToReqId = new Map<string, number>()
  private readonly activeSubscriptions = new Map<number, ActiveSubscription>()
  private readonly refCount = new Map<string, number>()

  // 每个 reqId 的最新价格 / 数量 / 时间戳（tickPrice 与 tickSize 异步到达，需要合并后输出）
  private readonly lastPrice = new Map<number, number>()
  private readonly lastSize = new Map<number, number>()
  private readonly lastTs = new Map<number, number>()
  private readonly lastEmit = new Map<number, IBKRTick>()
  private readonly lastTicks = new Map<string, IBKRTick>()

  // 历史 K 线（reqHistoricalData）支持
  // 注：IBKR 的 5 秒实时 bar 请求已停用 —— 该接口粒度固定为 5 秒且受 TWS
  // 「10 分钟最多 60 次新请求」的 pacing 限制，无法满足 250ms 级实时 K 线刷新；
  // 实时 K 线统一由 reqMktData / reqTickByTickData 的逐笔 tick 聚合产生（见 IBKRAdapter）。
  private readonly historicalPending = new Map<number, HistoricalPending>()

  // 合约解析缓存（reqContractDetails 解析出的真实近月合约）
  private readonly contractCache = new Map<string, Contract>()
  private readonly contractPromises = new Map<string, Promise<Contract>>()
  private readonly contractPending = new Map<number, ContractPending>()

  private constructor() {
    this.host = config.ibkr.host
    this.port = config.ibkr.port
    this.clientId = config.ibkr.clientId
    this.requestedMarketDataType = MARKET_DATA_TYPE_VALUES[config.ibkr.marketDataType]
    // 先按配置乐观判断：只有实时类型才请求逐笔 / 5 秒实时 K 线；若 IB 回延迟通知或「未订阅」错误会自动停用
    this.liveData = this.requestedMarketDataType === MarketDataType.REALTIME
    logger.info(`[IBKR] 客户端初始化: host=${this.host} port=${this.port} clientId=${this.clientId} 配置行情类型=${config.ibkr.marketDataType}(${this.requestedMarketDataType})${config.ibkr.debug ? '（IBKR_DEBUG=true，开启协议级日志）' : ''}`)
  }

  /**
   * 获取全局唯一实例（单例）。
   * 构造函数已私有化 —— 任何位置（含未来新增模块）都无法再用 `new IBKRClient()` 建出第二个连接。
   */
  static getInstance(): IBKRClient {
    if (!IBKRClient.instance) {
      IBKRClient.instance = new IBKRClient()
      logger.info('[IBKR] 已创建全局唯一客户端实例（本进程后续调用均复用该实例，不再新建连接）')
    }
    return IBKRClient.instance
  }

  // ---------- 公共 API ----------

  /** 注册 Tick 回调，返回取消函数。 */
  onTick(listener: TickListener): () => void {
    this.tickListeners.add(listener)
    return () => this.tickListeners.delete(listener)
  }

  /** 注册连接状态回调（供 ping / waitForConnection 使用），返回取消函数。 */
  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  isConnected(): boolean {
    return this.connected
  }

  /** 最近一次合并输出的行情（REST getTicker 用）。 */
  getLast(symbol: string): IBKRTick | undefined {
    return this.lastTicks.get(symbol)
  }

  /** 注册行情类型变更回调（1=实时 2=冻结 3=延迟 4=延迟冻结），返回取消函数。 */
  onMarketDataType(listener: MarketDataTypeListener): () => void {
    this.marketDataTypeListeners.add(listener)
    return () => this.marketDataTypeListeners.delete(listener)
  }

  /** 当前生效的行情类型（1=实时 3=延迟）；尚未收到 IB 通知时为 null。 */
  getMarketDataType(): number | null {
    return this.marketDataType
  }

  /**
   * 运行状态快照（GET /api/ibkr/status）：
   * 排查「IBKR 拿不到实时行情」时最先看 marketDataType —— 1=实时 / 3=延迟（CME 约延迟 10 分钟）。
   */
  getStatus(): IBKRStatus {
    const marketDataType = this.marketDataType
    return {
      host: this.host,
      port: this.port,
      clientId: this.clientId,
      connected: this.connected,
      requestedMarketDataType: this.requestedMarketDataType,
      marketDataType,
      marketDataTypeLabel: marketDataType === null
        ? '未知（尚未收到 IB 行情类型通知：连接未建立或尚未发起行情请求）'
        : (MARKET_DATA_TYPE_LABELS[marketDataType] ?? String(marketDataType)),
      liveData: this.liveData,
      subscriptions: [...this.activeSubscriptions.values()].map((sub) => sub.symbol),
      lastTicksAt: Object.fromEntries([...this.lastTicks.entries()].map(([symbol, tick]) => [symbol, tick.timestamp])),
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
    }
  }

  /**
   * 请求历史 K 线（reqHistoricalData）。合约参数由 CONTRACTS 统一维护（Symbol/SecType/Exchange/Currency）。
   * @param endDateTime 分页参数：旧 K 线最左侧时间戳（epoch ms），用于向前拉取更早数据；缺省 = 当前时刻。
   * @param timeoutMs 默认超时，防止前端无限等待；超时自动 cancelHistoricalData 并 reject。
   */
  async getHistoricalKlines(symbol: string, interval: Interval, limit = 300, timeoutMs = 15_000, endDateTime?: number): Promise<Kline[]> {
    if (!CONTRACTS[symbol]) throw new Error(`不支持的 IBKR 合约: ${symbol}（支持 ${IBKR_SYMBOLS.join('/')}）`)
    if (!(interval in HISTORICAL_BAR_SIZE)) throw new Error(`不支持的 IBKR K 线周期: ${interval}`)

    // 解析真实近月合约（reqContractDetails），内部已包含 waitForConnection 与超时保护
    const contract = await this.resolveContract(symbol)
    const ib = this.ib
    if (!ib || !ib.isConnected) throw new Error(this.connectionError || 'IBKR 未连接')

    const reqId = this.nextReqId++
    const barSize = HISTORICAL_BAR_SIZE[interval]
    // durationStr 按「周期 + 需要根数」动态计算（下限保证 ≥ limit 根，上限封顶在 IBKR 各 barSize 允许的回看窗口内）
    const durationStr = ibkrHistoryDuration(interval, limit)
    // 分页：endDateTime 为旧 K 线最左侧时间戳，转为 IBKR 格式；缺省为空串 = 当前时刻
    const endStr = typeof endDateTime === 'number' && Number.isFinite(endDateTime) && endDateTime > 0 ? formatIBDateTime(endDateTime) : ''
    logger.info(`[IBKR] 请求历史K线: ${symbol} ${interval}（barSize=${barSize}, duration=${durationStr}, limit=${limit}, end=${endStr || 'now'}, reqId=${reqId}）`)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.historicalPending.delete(reqId)
        try { ib.cancelHistoricalData(reqId) } catch { /* 忽略 */ }
        reject(new Error(`IBKR 历史K线请求超时（${timeoutMs}ms）：${symbol} ${interval}`))
      }, timeoutMs)
      this.historicalPending.set(reqId, {
        bars: [],
        onDone: (rows) => {
          clearTimeout(timer)
          this.historicalPending.delete(reqId)
          resolve(rows.slice(-limit)) // 只保留最近 limit 根，保证升序
        },
        onFail: (err) => {
          clearTimeout(timer)
          this.historicalPending.delete(reqId)
          reject(err)
        },
      })
      try {
        // whatToShow=TRADES、useRTH=0（全天 24h 电子盘，避免期货盘前盘后断层）、
        // formatDate=2（Unix 秒，时间戳不含时区歧义，跨 DST 也不会偏移）、
        // keepUpToDate=false（一次性拉取）
        ib.reqHistoricalData(reqId, contract, endStr, durationStr, barSize, WhatToShow.TRADES, false, 2, false)
      } catch (err) {
        clearTimeout(timer)
        this.historicalPending.delete(reqId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /**
   * 解析合约的真实近月版本（reqContractDetails → 取最近到期日）。
   * 结果按 symbol 缓存；并发调用共享同一个 Promise。
   */
  private resolveContract(symbol: string): Promise<Contract> {
    const cached = this.contractCache.get(symbol)
    if (cached) return Promise.resolve(cached)
    const inflight = this.contractPromises.get(symbol)
    if (inflight) return inflight
    const promise = this.doResolveContract(symbol).finally(() => this.contractPromises.delete(symbol))
    this.contractPromises.set(symbol, promise)
    return promise
  }

  private async doResolveContract(symbol: string): Promise<Contract> {
    const meta = IBKR_CME_SYMBOLS.find((s) => s.symbol === symbol)
    if (!meta) throw new Error(`不支持的 IBKR 合约: ${symbol}（支持 ${IBKR_SYMBOLS.join('/')}）`)

    await this.waitForConnection(8000)
    const ib = this.ib
    if (!ib || !ib.isConnected) throw new Error(this.connectionError || 'IBKR 未连接')

    const reqId = this.nextReqId++
    logger.info(`[IBKR] 解析合约: ${symbol}（reqId=${reqId}）`)
    return new Promise<Contract>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.contractPending.delete(reqId)
        reject(new Error(`IBKR 合约解析超时（8000ms）：${symbol}`))
      }, 8000)
      this.contractPending.set(reqId, {
        details: [],
        onDone: () => {
          clearTimeout(timer)
          const pending = this.contractPending.get(reqId)
          this.contractPending.delete(reqId)
          // 选近月：TWS 返回的均为可交易合约，按到期月（YYYYMM 字典序）取最早者
          const front = (pending?.details ?? [])
            .map((d) => d.contract)
            .filter((c) => c.conId && c.lastTradeDateOrContractMonth)
            .sort((a, b) => (a.lastTradeDateOrContractMonth! < b.lastTradeDateOrContractMonth! ? -1 : a.lastTradeDateOrContractMonth! > b.lastTradeDateOrContractMonth! ? 1 : 0))[0]
          if (!front) {
            reject(new Error(`IBKR 未找到 ${symbol} 的合约描述（收到 ${pending?.details.length ?? 0} 条记录）`))
            return
          }
          const resolved: Contract = {
            ...front,
            symbol,
            secType: meta.secType as SecType,
            exchange: meta.exchange,
            currency: 'USD',
          }
          this.contractCache.set(symbol, resolved)
          logger.info(`[IBKR] 合约已解析: ${symbol} → conId=${resolved.conId} localSymbol=${resolved.localSymbol ?? ''} 到期=${resolved.lastTradeDateOrContractMonth ?? ''} tradingClass=${resolved.tradingClass ?? ''}`)
          resolve(resolved)
        },
        onFail: (err) => {
          clearTimeout(timer)
          this.contractPending.delete(reqId)
          reject(err)
        },
      })
      try {
        ib.reqContractDetails(reqId, { symbol, secType: meta.secType as SecType, exchange: meta.exchange, currency: 'USD' })
      } catch (err) {
        clearTimeout(timer)
        this.contractPending.delete(reqId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /**
   * 订阅指定合约的实时行情（先解析真实近月合约，再 reqMktData / reqTickByTickData）。
   * 同一合约重复订阅共享底层数据流（引用计数管理）。
   * @returns 取消订阅函数；最后一个订阅取消时自动 cancelMktData / cancelTickByTickData。
   */
  async subscribeMarketData(symbol: string): Promise<() => void> {
    if (!CONTRACTS[symbol]) throw new Error(`不支持的 IBKR 合约: ${symbol}（支持 ${IBKR_SYMBOLS.join('/')}）`)
    const contract = await this.resolveContract(symbol)

    let reqId = this.symbolToReqId.get(symbol)
    if (reqId === undefined) {
      this.ensureConnected()
      reqId = this.nextReqId++
      this.symbolToReqId.set(symbol, reqId)
      this.activeSubscriptions.set(reqId, { symbol, contract })
      if (this.ib?.isConnected) this.requestMarketData(reqId, symbol, contract)
    }
    this.refCount.set(symbol, (this.refCount.get(symbol) ?? 0) + 1)

    return () => {
      const count = (this.refCount.get(symbol) ?? 1) - 1
      if (count <= 0) {
        this.refCount.delete(symbol)
        this.cancelMarketData(symbol, reqId!)
      } else {
        this.refCount.set(symbol, count)
      }
    }
  }

  /**
   * 建立（或复用）到 TWS / IB Gateway 的连接 —— 全进程唯一的连接入口。
   *
   * 幂等规则（避免 TWS 里出现大量客户端连接）：
   * - 已连接 → 直接复用，绝不再发起连接；
   * - connecting → 跳过（同一时刻只允许一次握手）；
   * - 已有 IBApi 实例但尚未连上（处于重连窗口）→ 跳过，交由 scheduleReconnect 统一重连；
   * - 距上次断开不足 RECONNECT_DELAY_MS → 先等待剩余时间（给 TWS 释放旧 clientId 的时间窗）。
   *
   * 正常流程下本方法只会在进程生命周期内真正发起一次连接，其余调用全部走「复用 / 跳过」分支。
   */
  async connect(): Promise<void> {
    if (this.connected && this.ib?.isConnected) {
      logger.info(`[IBKR] 已存在连接（${this.host}:${this.port} clientId=${this.clientId}），复用现有连接`)
      return
    }
    if (this.connecting) {
      logger.warn(`[IBKR] 正在连接中（clientId=${this.clientId}），跳过重复连接`)
      return
    }
    if (this.ib) {
      logger.warn(`[IBKR] 已有 IBApi 实例且尚未连接（clientId=${this.clientId}，isConnected=${this.ib.isConnected}），等待自动重连，跳过重复连接`)
      return
    }
    // 断开 → 重连之间强制等待 RELEASE 窗口：TWS / IB Gateway 需要时间释放旧 clientId，
    // 过早重连会被登记成「又一个客户端」（TWS 客户端列表不断增长）
    const waitMs = this.lastDisconnectAt > 0 ? this.lastDisconnectAt + RECONNECT_DELAY_MS - Date.now() : 0
    if (waitMs > 250) {
      logger.info(`[IBKR] 距上次断开不足 ${Math.round(RECONNECT_DELAY_MS / 1000)}s，等待 ${Math.round(waitMs / 1000)}s 后再连接（避免 TWS 侧旧连接未释放）`)
      await delay(waitMs)
      // 等待期间可能有其它调用（并发订阅 / 重连定时器）已发起连接：必须重新判定，
      // 否则两次调用都会走到 createConnection，产生两个 socket（TWS 侧即两个客户端）
      if (this.connected || this.connecting || this.ib) {
        logger.info(`[IBKR] 等待期间连接状态已变化（connected=${this.connected}, connecting=${this.connecting}, hasIb=${Boolean(this.ib)}），跳过重复连接`)
        return
      }
    }
    this.connecting = true
    try {
      this.createConnection()
    } catch (err) {
      this.connecting = false
      const error = err instanceof Error ? err : new Error(String(err))
      this.connectionError = error.message
      logger.error(`[IBKR] 连接发起失败（clientId=${this.clientId}）`, error)
      this.emitStatus(false, error)
      throw error
    }
  }

  /** 确保底层连接已建立（懒连接：首次订阅时才触发）。同步返回，连接结果由状态回调 / waitForConnection 结算。 */
  ensureConnected(): void {
    void this.connect().catch((err) => logger.warn(`[IBKR] 连接失败: ${err instanceof Error ? err.message : String(err)}`))
  }

  /** 等待连接就绪（供 WebSocket 预检 / REST 使用）。 */
  waitForConnection(timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connected) { resolve(); return }
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let unsubStatus: (() => void) | null = null
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        unsubStatus?.()
        fn()
      }
      timer = setTimeout(() => {
        finish(() => reject(new Error(
          this.connectionError || `IBKR 连接超时（请确认 IB Gateway / TWS 已启动，并在 API 设置中开启 ${this.host}:${this.port} 端口）`,
        )))
      }, timeoutMs)
      unsubStatus = this.onStatus((connected, error) => {
        if (connected) finish(resolve)
        else if (error) finish(() => reject(error))
      })
      this.ensureConnected()
    })
  }

  /**
   * 彻底断开连接（进程退出 / 显式关闭）：停止自动重连 → 关闭并释放 socket → 重置连接与行情状态。
   * 关键：this.ib 必须置空并移除全部监听，否则 TWS / IB Gateway 侧会残留客户端记录
   * （「TWS 里出现大量客户端连接」的主因）。需要重新连接时由 connect() 发起，
   * 且 connect() 会强制等满 RECONNECT_DELAY_MS 的释放窗口。
   */
  async disconnect(reason = 'manual'): Promise<void> {
    this.stopped = true
    this.clearTimers()
    const wasConnected = this.connected
    logger.info(`[IBKR] 正在断开连接（reason=${reason}, clientId=${this.clientId}, connected=${wasConnected}, 订阅数=${this.activeSubscriptions.size}）`)
    this.disposeIb()
    this.connected = false
    this.connecting = false
    this.lastDisconnectAt = Date.now()
    // 连接断开后行情类型状态未知，重连成功时由 handleConnected 重新请求
    this.marketDataType = null
    // 行情缓存随连接一起失效，避免重连后展示过期价格
    this.lastPrice.clear()
    this.lastSize.clear()
    this.lastTs.clear()
    this.lastEmit.clear()
    // 等待 socket 关闭落地，避免同一 tick 内立刻重连
    await delay(DISCONNECT_SETTLE_MS)
    logger.info(`[IBKR] 已断开连接（clientId=${this.clientId}），${Math.round(RECONNECT_DELAY_MS / 1000)}s 内不再重连（可用 IBKR_RECONNECT_DELAY_MS 调整）`)
    this.emitStatus(false)
  }

  /**
   * 关闭连接（同步版，进程退出时调用）。
   * disconnect() 在首个 await 之前就已完成状态清理与 socket 断开，因此这里无需 await。
   */
  close(): void {
    void this.disconnect('close()')
  }

  /** 释放底层 IBApi 实例：断开 socket（含「TCP 已连、IB 握手未完成」的半开连接）+ 移除全部事件监听。 */
  private disposeIb(): void {
    const ib = this.ib
    if (!ib) { this.socketOpen = false; return }
    this.ib = null
    try {
      // 半开连接（socketOpen=true 但 isConnected=false）同样必须 destroy，否则该 socket 会一直挂着：
      // TWS 侧残留客户端槽位，且本身也无法重连
      if (this.socketOpen || ib.isConnected) ib.disconnect()
    } catch (err) {
      logger.error('[IBKR] 断开底层 socket 失败（忽略）', err)
    }
    this.socketOpen = false
    ib.removeAllListeners()
  }

  /** 清空全部定时器（重连 / 握手看门狗）。 */
  private clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.clearHandshakeWatchdog()
  }

  /**
   * 启动握手看门狗：超时未收到 connected / disconnected 事件时，
   * 释放半开连接（TCP 已建立但 IB 握手未完成）并按退避间隔重试 ——
   * 这类 socket 既占着 TWS 的客户端槽位，又永远不会自己断开，必须主动回收。
   */
  private startHandshakeWatchdog(): void {
    this.clearHandshakeWatchdog()
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null
      if (!this.connecting && !this.socketOpen) return
      this.connecting = false
      logger.warn(`[IBKR] 连接握手超时（${CONNECT_HANDSHAKE_TIMEOUT_MS}ms 内未收到 connected/disconnected 事件，clientId=${this.clientId}），释放半开连接并准备重连`)
      this.disposeIb()
      this.lastDisconnectAt = Date.now()
      this.scheduleReconnect()
    }, CONNECT_HANDSHAKE_TIMEOUT_MS)
  }

  private clearHandshakeWatchdog(): void {
    if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null }
  }

  // ---------- 连接生命周期 ----------

  private createConnection(): void {
    this.stopped = false
    this.connectionError = ''
    const ib = new IBApi({ host: this.host, port: this.port })
    this.ib = ib
    // 每次新建 IBApi 都会向 TWS / IB Gateway 注册一个 API 客户端，
    // 因此本方法只允许由 connect() 在「确认无连接、无实例」时调用。
    logger.info(`[IBKR] 正在连接 ${this.host}:${this.port}（clientId=${this.clientId}）...`)
    this.startHandshakeWatchdog()
    // ---- 连接生命周期 / 握手相关事件（全量监听，便于按 ErrorCode 定位） ----
    ib.on(EventName.connected, () => this.handleConnected())
    ib.on(EventName.disconnected, () => this.handleDisconnected())
    // 库内部当前版本未主动 emit connectionClosed，保留兜底监听（兼容未来版本）
    ib.on(EventName.connectionClosed, () => this.handleDisconnected())
    ib.on(EventName.error, (err, code, reqId) => this.handleError(err, code, reqId))
    ib.on(EventName.info, (message, code) => this.handleInfo(message, code))
    ib.on(EventName.server, (version, connectionTime) => logger.info(`[IBKR] API Server 版本=${version}，连接时间=${connectionTime}`))
    ib.on(EventName.marketDataType, (reqId, marketDataType) => this.handleMarketDataType(reqId, marketDataType))
    ib.on(EventName.result, (eventName, args) => this.handleResult(eventName, args))
    // ---- 协议级日志（IBKR_DEBUG=true 时开启，否则不发） ----
    if (config.ibkr.debug) {
      ib.on(EventName.received, (tokens) => logger.debug(`[IBKR] <== 收到: ${JSON.stringify(tokens)}`))
      ib.on(EventName.sent, (tokens) => logger.debug(`[IBKR] ==> 发送: ${JSON.stringify(tokens)}`))
    }
    // ---- 行情 / K 线事件（实时 K 线不再订阅上游 5 秒 bar，改由逐笔 tick 聚合） ----
    ib.on(EventName.tickPrice, (reqId, field, value) => this.handleTickPrice(reqId, field, value))
    ib.on(EventName.tickSize, (reqId, field, value) => this.handleTickSize(reqId, field, value))
    ib.on(EventName.tickByTickAllLast, (reqId, _tickType, _time, price, size) => this.handleTickByTickAllLast(reqId, price, size))
    ib.on(EventName.historicalData, (reqId, date, open, high, low, close, volume) => this.handleHistoricalData(reqId, date, open, high, low, close, volume))
    ib.on(EventName.contractDetails, (reqId, contractDetails) => this.handleContractDetails(reqId, contractDetails))
    ib.on(EventName.contractDetailsEnd, (reqId) => this.handleContractDetailsEnd(reqId))
    // 唯一的一处 socket 连接发起：clientId 固定取自配置（IBKR_CLIENT_ID，默认 1）
    ib.connect(this.clientId)
    // TCP socket 已创建（握手结果由 connected / disconnected 事件结算）
    this.socketOpen = true
  }

  private handleConnected(): void {
    this.connected = true
    this.connecting = false
    this.clearHandshakeWatchdog()
    this.connectionError = ''
    this.lastError = ''
    this.reconnectAttempts = 0
    logger.info(`[IBKR] 连接成功 ${this.host}:${this.port}（clientId=${this.clientId}，复用全局唯一客户端实例，未新建额外连接）`)
    // 按配置请求行情类型（默认 REALTIME=1；可用 IBKR_MARKET_DATA_TYPE=delayed 强制免费延迟行情）。
    // TWS 每次重连后都会重置行情类型，因此这里必须在每次连接成功后重新设置。
    this.fallbackApplied = false
    this.marketDataType = null
    this.liveData = this.requestedMarketDataType === MarketDataType.REALTIME
    this.ib?.reqMarketDataType(this.requestedMarketDataType)
    logger.info(`[IBKR] 已请求行情类型: ${MARKET_DATA_TYPE_LABELS[this.requestedMarketDataType] ?? this.requestedMarketDataType}（IB 会在 marketDataType 事件中回报本条订阅实际返回的类型）`)
    // 恢复断线前全部订阅（逐笔 / 实时 K 线是否发起由 liveData 决定，延迟行情下自动跳过）
    for (const [reqId, sub] of this.activeSubscriptions.entries()) {
      this.requestMarketData(reqId, sub.symbol, sub.contract)
    }
    this.emitStatus(true)
  }

  private handleDisconnected(): void {
    const wasConnected = this.connected
    this.connected = false
    this.connecting = false
    this.socketOpen = false // socket 已由库关闭，无需再 destroy
    this.clearHandshakeWatchdog()
    // 连接断开后行情类型状态未知，重连成功时会重新请求（由 handleConnected 负责）
    this.marketDataType = null
    this.lastPrice.clear()
    this.lastSize.clear()
    this.lastTs.clear()
    this.lastEmit.clear()
    // 立刻释放旧实例：TWS / IB Gateway 只有在 socket 真正关闭后才释放 clientId，
    // 残留实例会让紧随其后的重连被登记成「又一个客户端」（TWS 客户端列表不断增长）
    this.disposeIb()
    this.lastDisconnectAt = Date.now()
    logger.warn(wasConnected
      ? `[IBKR] 连接断开（clientId=${this.clientId}，保留订阅=${this.activeSubscriptions.size}），${Math.round(RECONNECT_DELAY_MS / 1000)}s 后自动重连...`
      : `[IBKR] 连接失败 / 未建立（clientId=${this.clientId}），${Math.round(RECONNECT_DELAY_MS / 1000)}s 后重试...`)
    this.emitStatus(false)
    this.scheduleReconnect()
  }

  /**
   * 断线 / 连接失败后的自动重连：
   * 固定等待 RECONNECT_DELAY_MS（默认 30s，带 0~1s 抖动）让 TWS / IB Gateway 释放旧 clientId，
   * 到点后先确认旧实例已释放，再走统一的 connect()（复用同一 clientId，不产生新的客户端编号）。
   */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const waitMs = RECONNECT_DELAY_MS + Math.floor(Math.random() * 1000)
    this.reconnectAttempts += 1
    logger.info(`[IBKR] 将于 ${Math.round(waitMs / 1000)}s 后尝试第 ${this.reconnectAttempts} 次重连（clientId=${this.clientId}）`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopped) return
      this.disposeIb() // 双保险：旧 socket 已释放（通常已在 handleDisconnected 中释放）
      void this.connect().catch((err) => logger.warn(`[IBKR] 重连失败: ${err instanceof Error ? err.message : String(err)}`))
    }, waitMs)
  }

  private handleError(err: Error, code: ErrorCode, reqId: number): void {
    const message = err instanceof Error ? err.message : String(err)
    const hint = IBKR_ERROR_HINTS[code] ?? ''
    const suffix = hint ? `（${hint}）` : ''
    // 1100/1101：TWS 与 IB 服务器连接中断 / 恢复（行情订阅可能丢失），需重新提交订阅
    if (code === ErrorCode.FAIL_CONNECTION_LOST_BETWEEN_SERVER_AND_TWS || code === ErrorCode.CONNECTIVITY_RESTORED_DATA_LOST) {
      logger.warn(`[IBKR] 行情连接${code === ErrorCode.FAIL_CONNECTION_LOST_BETWEEN_SERVER_AND_TWS ? '中断' : '恢复'}${suffix}，重新订阅全部合约`)
      for (const [reqId, sub] of this.activeSubscriptions.entries()) this.requestMarketData(reqId, sub.symbol, sub.contract)
      return
    }
    // 实时行情不可用（未订阅该交易所实时行情 / 与另一实时会话冲突）：IB 只会给延迟数据，
    // 需停用仅实时可用的逐笔 / 实时 K 线，并按配置回退延迟行情，避免「只拿到空数据」。
    if (LIVE_DATA_UNAVAILABLE_CODES.includes(code)) {
      this.lastError = `${message}（ErrorCode=${code}${suffix}）`
      logger.warn(`[IBKR] 实时行情不可用(reqId=${reqId}, ErrorCode=${code}${suffix}): ${message}`)
      this.handleLiveDataUnavailable(code, message)
      return
    }
    // 连接层错误：reqId = -1（NO_VALID_ID）且尚未连接成功（如 ECONNREFUSED / CONNECT_FAIL=502）
    if (!this.connected && reqId === ErrorCode.NO_VALID_ID) {
      this.connectionError = `${message}（ErrorCode=${code}${suffix}）`
      logger.warn(`[IBKR] 连接错误: ErrorCode=${code}${suffix} message=${message}`)
      this.emitStatus(false, err)
      return
    }
    // 历史数据「无数据」类错误（162: HMDS query returned no data / No data of type TRADES…）：
    // 这是「分页翻到数据尽头 / 该区间无成交」的正常结果，不是失败 —— 直接以**空数据集**结束该请求，
    // 避免干等到 15s 超时（前端据此把 hasMore 置为 false，停止继续向左分页且不弹错误提示）。
    const pendingHistorical = this.historicalPending.get(reqId)
    // 注：ErrorCode 是「已知错误码字面量联合」类型，IB 的 162（历史数据无数据）不在其中，
    // 因此先落到 number 再比较，避免 TS2367（无重叠比较）。
    const codeNumber: number = code
    if (pendingHistorical && (codeNumber === 162 || /no data/i.test(message))) {
      logger.info(`[IBKR] 历史K线无数据(reqId=${reqId}, ErrorCode=${code}${suffix}): ${message}（按空数据集返回）`)
      pendingHistorical.onDone(pendingHistorical.bars)
      return
    }
    logger.warn(`[IBKR] 行情错误(reqId=${reqId}, ErrorCode=${code}${suffix}): ${message}`)
  }

  /**
   * IB 通知（info）事件。关键码：
   * - 326：客户号码已被使用（clientId 冲突，TCP 已通但被 TWS/IB Gateway 拒连）→ 升级为 warn 并提示修改 clientId；
   * - 2104/2106/2158：行情/sec-def 数据源连接正常（常规提示）。
   */
  private handleInfo(message: string, code: number): void {
    if (code === 326) {
      this.connectionError = `${message}（InfoCode=326，clientId=${this.clientId} 已被占用）`
      logger.warn(`[IBKR] 连接被拒绝: InfoCode=326（clientId=${this.clientId} 已被其他客户端占用）。请设置 IBKR_CLIENT_ID 换一个未被占用的编号，并确认没有第二个后端 / TWS 实例使用同一编号。原始信息: ${message}`)
      return
    }
    logger.info(`[IBKR] 通知(InfoCode=${code}): ${message}`)
  }

  /** result 事件每个数据消息都会触发，日志量大，仅 IBKR_DEBUG=true 时输出。 */
  private handleResult(eventName: string, args: unknown[]): void {
    if (config.ibkr.debug) logger.debug(`[IBKR] result: ${eventName} ${JSON.stringify(args ?? [])}`)
  }

  /** reqContractDetails 回调：收集匹配的合约描述。 */
  private handleContractDetails(reqId: number, contractDetails: ContractDetails): void {
    const pending = this.contractPending.get(reqId)
    if (!pending) return
    pending.details.push(contractDetails)
  }

  /** reqContractDetails 结束标记：触发解析完成。 */
  private handleContractDetailsEnd(reqId: number): void {
    const pending = this.contractPending.get(reqId)
    if (!pending) return
    pending.onDone()
  }

  /** reqHistoricalData 分批回调：聚合 bar，收到 "finished" 结束标记后 resolve。 */
  private handleHistoricalData(reqId: number, date: string, open: number, high: number, low: number, close: number, volume: number): void {
    const pending = this.historicalPending.get(reqId)
    if (!pending) return
    // 数据结束标记：@stoqey/ib decoder 以 "finished-..." 前缀 + 无效 OHLC 标识数据集结束
    if (typeof date === 'string' && date.startsWith('finished')) {
      pending.onDone(pending.bars)
      return
    }
    if (!Number.isFinite(open) || open <= 0 || !Number.isFinite(high) || high <= 0) return
    pending.bars.push({
      time: parseBarTime(String(date)),
      open, high, low, close,
      volume: Number.isFinite(volume) && volume > 0 ? volume : 0,
    })
  }

  // ---------- 行情订阅 ----------

  private requestMarketData(reqId: number, symbol: string, contract: Contract): void {
    const ib = this.ib
    if (!ib) return
    // 实时行情流（snapshot=false, regulatorySnapshot=false）：实时 / 延迟行情均可用
    ib.reqMktData(reqId, contract, '', false, false)
    // 逐笔（reqTickByTickData）仅实时行情支持：延迟行情下 IB 会直接拒绝（354/10167/10197），
    // 因此按 liveData 门控，避免无意义的错误刷屏；延迟行情下仍有 reqMktData 的 tickPrice / tickSize 可用。
    if (!this.liveData) {
      logger.info(`[IBKR] ${symbol} 当前为延迟行情，跳过 reqTickByTickData（仅实时行情支持，K 线改由 tickPrice/tickSize 聚合）`)
      return
    }
    // 逐笔成交流（实时行情下不可用时由 handleError 自动停用，不影响 tickPrice / tickSize 流）
    try {
      ib.reqTickByTickData(reqId, contract, TickByTickDataType.AllLast, 0, false)
    } catch (err) {
      logger.warn(`[IBKR] ${symbol} 请求 tick-by-tick 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private cancelMarketData(symbol: string, reqId: number): void {
    this.activeSubscriptions.delete(reqId)
    this.symbolToReqId.delete(symbol)
    this.lastPrice.delete(reqId)
    this.lastSize.delete(reqId)
    this.lastTs.delete(reqId)
    this.lastEmit.delete(reqId)
    if (this.ib?.isConnected) {
      try { this.ib.cancelMktData(reqId) } catch { /* 取消失败可忽略 */ }
      try { this.ib.cancelTickByTickData(reqId) } catch { /* 取消失败可忽略 */ }
    }
  }

  /**
   * IB 行情类型通知（marketDataType 事件）：事件值即本条订阅实际返回的数据类型（1=实时 3=延迟…）。
   * - 收到非实时类型 → 说明该账号在此 IB Gateway 登录下没有实时行情权限（或配置了延迟行情），
   *   此时必须停掉仅实时可用的 reqTickByTickData，否则会被 IB 反复拒绝；
   * - 恢复实时类型（如订阅生效后重连）→ 重新补发上述实时专属请求。
   */
  private handleMarketDataType(reqId: number, marketDataType: number): void {
    const changed = this.marketDataType !== marketDataType
    this.marketDataType = marketDataType
    const live = marketDataType === MarketDataType.REALTIME
    const label = `${MARKET_DATA_TYPE_LABELS[marketDataType] ?? marketDataType}`
    if (changed) {
      logger.info(`[IBKR] 行情类型已切换(reqId=${reqId}) -> ${label}`)
      // 仅在类型变化时通知监听方（WebSocketServer 据此广播给前端状态栏；
      // 订阅建立时由 WS 主动回发当前值，无需重复推送）
      this.emitMarketDataType(marketDataType)
    } else {
      logger.info(`[IBKR] 行情类型通知(reqId=${reqId}) -> ${label}`)
    }
    if (this.liveData === live) return
    this.liveData = live
    if (live) {
      // 恢复实时行情：补发实时专属请求（reqTickByTickData）
      for (const [id, sub] of this.activeSubscriptions.entries()) this.requestMarketData(id, sub.symbol, sub.contract)
    } else {
      this.cancelRealtimeOnlyRequests()
    }
  }

  /** 广播行情类型给监听方（WebSocketServer → 前端状态栏「实时行情 / 延迟行情」）。 */
  private emitMarketDataType(marketDataType: number): void {
    for (const listener of this.marketDataTypeListeners) {
      try { listener(marketDataType) } catch (err) { logger.error('[IBKR] 行情类型回调异常', err) }
    }
  }

  /**
   * 实时行情不可用（未订阅实时行情 / 与另一实时会话冲突）：
   * 记录原因并在配置允许时回退延迟行情，保证「没有实时权限也能拿到（延迟）数据」。
   */
  private handleLiveDataUnavailable(code: number, message: string): void {
    this.liveData = false
    this.cancelRealtimeOnlyRequests()
    if (this.fallbackApplied || !config.ibkr.fallbackToDelayed) {
      logger.warn(`[IBKR] 实时行情不可用（ErrorCode=${code}）: ${message}。当前仅推送延迟行情（约延迟 10 分钟）。` +
        '排查：Client Portal → Market Data Subscriptions 是否含 CME Globex 实时行情、状态是否 Active、是否绑定当前登录账号；新增订阅需重新登录 IB Gateway 才生效。')
      return
    }
    if (this.requestedMarketDataType !== MarketDataType.REALTIME) return // 本身就配置为延迟行情，无需回退
    this.fallbackApplied = true
    this.marketDataType = MarketDataType.DELAYED
    this.ib?.reqMarketDataType(MarketDataType.DELAYED)
    this.emitMarketDataType(MarketDataType.DELAYED)
    // 切换行情类型后重新提交订阅：此前按「实时」发起的请求可能已被 IB 拒绝，
    // 重新 reqMktData 才会立刻开始推送延迟数据（此时 liveData=false，不会重发实时专属请求）
    for (const [id, sub] of this.activeSubscriptions.entries()) this.requestMarketData(id, sub.symbol, sub.contract)
    logger.warn(`[IBKR] 实时行情不可用（ErrorCode=${code}: ${message}），已自动回退延迟行情（CME 约延迟 10 分钟）。` +
      '排查（按顺序）：1) Client Portal → Market Data Subscriptions 是否含 CME Globex（非专业）实时行情且状态 Active；' +
      '2) 订阅是否绑定到 IB Gateway 当前登录的账号；3) 新增订阅后需重新登录 IB Gateway 才生效；' +
      '4) 请勿在本地 TWS 与服务器 IB Gateway 同时登录同一 IBKR 用户（10197 会话冲突）。')
  }

  /** 取消仅实时行情可用的请求（reqTickByTickData），保留 reqMktData 主行情流（延迟行情的 K 线来源）。 */
  private cancelRealtimeOnlyRequests(): void {
    const ib = this.ib
    if (!ib?.isConnected) return
    for (const reqId of this.activeSubscriptions.keys()) {
      try { ib.cancelTickByTickData(reqId) } catch { /* 取消失败可忽略 */ }
    }
  }

  // ---------- Tick 合并 ----------

  private handleTickPrice(reqId: number, field: TickType, value: number): void {
    if (!this.activeSubscriptions.has(reqId)) return
    // 只关心最后成交价：实时 TickType.LAST(4) / 延迟 DELAYED_LAST(68)
    if (field !== 4 && field !== 68) return
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return
    this.lastPrice.set(reqId, value)
    this.lastTs.set(reqId, Date.now())
    this.emitTick(reqId)
  }

  private handleTickSize(reqId: number, field: TickType | undefined, value: number | undefined): void {
    if (!this.activeSubscriptions.has(reqId)) return
    // 只关心最后成交量：实时 TickType.LAST_SIZE(5) / 延迟 DELAYED_LAST_SIZE(71)
    if (field !== 5 && field !== 71) return
    const size = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
    this.lastSize.set(reqId, size)
    this.lastTs.set(reqId, Date.now())
    // tickSize 可能早于 / 晚于 tickPrice 到达：已有价格时补发一次，刷新数量
    if (this.lastPrice.has(reqId)) this.emitTick(reqId)
  }

  private handleTickByTickAllLast(reqId: number, price: number, size: number): void {
    if (!this.activeSubscriptions.has(reqId)) return
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return
    this.lastPrice.set(reqId, price)
    this.lastSize.set(reqId, typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0)
    // IB 的 time 为本地时间字符串，统一使用接收时间戳
    this.lastTs.set(reqId, Date.now())
    this.emitTick(reqId)
  }

  private emitTick(reqId: number): void {
    const sub = this.activeSubscriptions.get(reqId)
    if (!sub) return
    const price = this.lastPrice.get(reqId)
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return
    const size = this.lastSize.get(reqId) ?? 0
    const timestamp = this.lastTs.get(reqId) ?? Date.now()
    const prev = this.lastEmit.get(reqId)
    // 同一 (price, size, timestamp) 去重，避免 tickPrice + tickSize 对同一笔成交重复输出
    if (prev && prev.price === price && prev.size === size && prev.timestamp === timestamp) return
    const tick: IBKRTick = { symbol: sub.symbol, price, size, timestamp }
    this.lastEmit.set(reqId, tick)
    this.lastTicks.set(sub.symbol, tick)
    this.lastTickAt = timestamp
    for (const listener of this.tickListeners) {
      try { listener(tick) } catch (err) { logger.error('[IBKR] Tick 回调异常', err) }
    }
  }

  private emitStatus(connected: boolean, error?: Error): void {
    for (const listener of this.statusListeners) {
      try { listener(connected, error) } catch (err) { logger.error('[IBKR] 状态回调异常', err) }
    }
  }
}

/**
 * 全局唯一 IBKRClient 实例（单例工厂）——
 * 整个 backend 进程只维护一条到 TWS / IB Gateway 的连接：所有行情订阅、历史请求、状态查询
 * 都必须通过本函数（或 IBKRClient.getInstance()）获取客户端并复用同一条连接。
 *
 * 禁止再直接 `new IBKRClient()`：每个 IBApi 实例都会向 TWS 注册一个 API 客户端，
 * 重复实例化正是「TWS 里出现大量客户端连接」的根因；TS 层面构造函数已私有化以杜绝该写法。
 */
export function getIBKRClient(): IBKRClient {
  return IBKRClient.getInstance()
}
