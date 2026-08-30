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
import { config } from '../utils/config'
import { logger } from '../utils/logger'
import type { Interval, Kline } from '../types/kline'

/** IBKR 行情合并后输出的标准化 tick（不含 type/source，由适配器补全） */
export interface IBKRTick {
  symbol: string
  price: number
  size: number
  timestamp: number
}

/** IBKR 实时 K 线（reqRealTimeBars，TWS 固定 5 秒 bar）输出格式 */
export interface IBKRRealtimeBar {
  symbol: string
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
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
  [ErrorCode.DISPLAYING_DELAYED_DATA]: '显示延迟数据（未付费实时行情，属正常提示）',
  [ErrorCode.FAIL_SEND_REQHISTDATA]: '历史数据请求发送失败（可能触发 IBKR 请求频率限制）',
  [ErrorCode.FAIL_SEND_REQRTBARS]: '实时 K 线请求发送失败',
}

/** 各周期对应的 IBKR barSize（reqHistoricalData / reqRealTimeBars 共用）。 */
const HISTORICAL_BAR_SIZE: Record<Interval, BarSizeSetting> = {
  '1m': BarSizeSetting.MINUTES_ONE,
  '5m': BarSizeSetting.MINUTES_FIVE,
  '15m': BarSizeSetting.MINUTES_FIFTEEN,
  '1h': BarSizeSetting.HOURS_ONE,
  '4h': BarSizeSetting.HOURS_FOUR,
  '1d': BarSizeSetting.DAYS_ONE,
}

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
 * - 连接成功后立即请求延迟行情（MarketDataType.DELAYED = 3），未付费订阅也能免费获取测试数据；
 * - 每个合约同时发起 reqMktData + reqTickByTickData(AllLast) + reqRealTimeBars，
 *   监听 tickPrice / tickSize / tickByTickAllLast 合并为 { symbol, price, size, timestamp }，
 *   实时 K 线（realtimeBar）输出为 { symbol, time, open, high, low, close, volume }；
 * - getHistoricalKlines 通过 reqHistoricalData 一次性拉取历史 K 线（带超时保护）；
 * - 断线指数退避自动重连，重连后重新设置延迟行情并恢复全部订阅。
 */
export class IBKRClient {
  private ib: IBApi | null = null
  private readonly host: string
  private readonly port: number
  private readonly clientId: number

  private connected = false
  private stopped = false
  private connectionError = ''
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0

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

  // 实时 K 线（reqRealTimeBars）与历史 K 线（reqHistoricalData）支持
  private readonly barListeners = new Set<(bar: IBKRRealtimeBar) => void>()
  private readonly realTimeBarReqIds = new Set<number>()
  private readonly historicalPending = new Map<number, HistoricalPending>()

  // 合约解析缓存（reqContractDetails 解析出的真实近月合约）
  private readonly contractCache = new Map<string, Contract>()
  private readonly contractPromises = new Map<string, Promise<Contract>>()
  private readonly contractPending = new Map<number, ContractPending>()

  constructor() {
    this.host = config.ibkr.host
    this.port = config.ibkr.port
    this.clientId = config.ibkr.clientId
    logger.info(`[IBKR] 客户端初始化: host=${this.host} port=${this.port} clientId=${this.clientId}${config.ibkr.debug ? '（IBKR_DEBUG=true，开启协议级日志）' : ''}`)
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

  /** 注册实时 K 线回调（reqRealTimeBars → { symbol, time, open, high, low, close, volume }），返回取消函数。 */
  onRealtimeBar(listener: (bar: IBKRRealtimeBar) => void): () => void {
    this.barListeners.add(listener)
    return () => this.barListeners.delete(listener)
  }

  isConnected(): boolean {
    return this.connected
  }

  /** 最近一次合并输出的行情（REST getTicker 用）。 */
  getLast(symbol: string): IBKRTick | undefined {
    return this.lastTicks.get(symbol)
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
    const durationStr = this.historicalDuration(interval, limit)
    // 分页：endDateTime 为旧 K 线最左侧时间戳，转为 IBKR 格式；缺省为空串 = 当前时刻
    const endStr = typeof endDateTime === 'number' && Number.isFinite(endDateTime) && endDateTime > 0 ? formatIBDateTime(endDateTime) : ''
    logger.info(`[IBKR] 请求历史K线: ${symbol} ${interval}（barSize=${barSize}, duration=${durationStr}, end=${endStr || 'now'}, reqId=${reqId}）`)

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
        // formatDate=1（标准 yyyyMMdd HH:mm:ss 时间格式）、keepUpToDate=false（一次性）
        ib.reqHistoricalData(reqId, contract, endStr, durationStr, barSize, WhatToShow.TRADES, false, 1, false)
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
   * 依据周期与请求根数计算 reqHistoricalData 的 durationStr。
   * 周期越短给越长的回看窗口（1m 至少 2 D，1h/1d 固定 1 M / 1 Y），
   * 保证远期 K 线能一次性加载到，同时按 IBKR 官方 step-size 上限封顶。
   */
  private historicalDuration(interval: Interval, limit: number): string {
    const minutesPerBar: Record<Interval, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 }
    // 25% 余量 → 换算成天数
    const days = Math.ceil((minutesPerBar[interval] * Math.max(1, limit) * 1.25) / 1440)
    switch (interval) {
      case '1d': return '1 Y' // 日线 → 1 年
      case '1h': return '1 M' // 1h → 1 个月（用户要求，720 根）
      case '4h': return '1 M' // 4h → 1 个月
      case '15m': return `${Math.max(4, days)} D` // 至少 4 天
      case '5m': return `${Math.max(2, days)} D` // 至少 2 天
      case '1m': return `${Math.max(2, days)} D` // 至少 2 天（用户要求）
    }
  }

  /**
   * 订阅指定合约的实时行情（先解析真实近月合约，再 reqMktData / reqTickByTickData / reqRealTimeBars）。
   * 同一合约重复订阅共享底层数据流（引用计数管理）。
   * @returns 取消订阅函数；最后一个订阅取消时自动 cancelMktData / cancelTickByTickData / cancelRealTimeBars。
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

  /** 确保底层连接已建立（懒连接：首次订阅时才触发）。 */
  ensureConnected(): void {
    if (this.ib?.isConnected) return
    if (this.ib) return // 已创建实例，正处于连接 / 重连流程中
    this.createConnection()
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

  /** 主动关闭连接（进程退出时调用）。 */
  close(): void {
    this.stopped = true
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.ib?.disconnect()
  }

  // ---------- 连接生命周期 ----------

  private createConnection(): void {
    this.stopped = false
    this.connectionError = ''
    const ib = new IBApi({ host: this.host, port: this.port })
    this.ib = ib
    logger.info(`[IBKR] 正在连接 ${this.host}:${this.port}（clientId=${this.clientId}）...`)
    // ---- 连接生命周期 / 握手相关事件（全量监听，便于按 ErrorCode 定位） ----
    ib.on(EventName.connected, () => this.handleConnected())
    ib.on(EventName.disconnected, () => this.handleDisconnected())
    // 库内部当前版本未主动 emit connectionClosed，保留兜底监听（兼容未来版本）
    ib.on(EventName.connectionClosed, () => this.handleDisconnected())
    ib.on(EventName.error, (err, code, reqId) => this.handleError(err, code, reqId))
    ib.on(EventName.info, (message, code) => this.handleInfo(message, code))
    ib.on(EventName.server, (version, connectionTime) => logger.info(`[IBKR] API Server 版本=${version}，连接时间=${connectionTime}`))
    ib.on(EventName.marketDataType, (reqId, marketDataType) => logger.info(`[IBKR] 行情类型已切换(reqId=${reqId}) -> MarketDataType=${marketDataType}`))
    ib.on(EventName.result, (eventName, args) => this.handleResult(eventName, args))
    // ---- 协议级日志（IBKR_DEBUG=true 时开启，否则不发） ----
    if (config.ibkr.debug) {
      ib.on(EventName.received, (tokens) => logger.debug(`[IBKR] <== 收到: ${JSON.stringify(tokens)}`))
      ib.on(EventName.sent, (tokens) => logger.debug(`[IBKR] ==> 发送: ${JSON.stringify(tokens)}`))
    }
    // ---- 行情 / K 线事件 ----
    ib.on(EventName.tickPrice, (reqId, field, value) => this.handleTickPrice(reqId, field, value))
    ib.on(EventName.tickSize, (reqId, field, value) => this.handleTickSize(reqId, field, value))
    ib.on(EventName.tickByTickAllLast, (reqId, _tickType, _time, price, size) => this.handleTickByTickAllLast(reqId, price, size))
    ib.on(EventName.realtimeBar, (reqId, time, open, high, low, close, volume) => this.handleRealtimeBar(reqId, time, open, high, low, close, volume))
    ib.on(EventName.historicalData, (reqId, date, open, high, low, close, volume) => this.handleHistoricalData(reqId, date, open, high, low, close, volume))
    ib.on(EventName.contractDetails, (reqId, contractDetails) => this.handleContractDetails(reqId, contractDetails))
    ib.on(EventName.contractDetailsEnd, (reqId) => this.handleContractDetailsEnd(reqId))
    ib.connect(this.clientId)
  }

  private handleConnected(): void {
    this.connected = true
    this.connectionError = ''
    this.reconnectAttempts = 0
    logger.info(`[IBKR] 已连接 ${this.host}:${this.port}（clientId=${this.clientId}）`)
    // 立即启用延迟行情（3 号），未付费订阅也能获取免费测试数据。
    // TWS 每次重连后都会重置行情类型，因此这里必须在每次连接成功后重新设置。
    this.ib?.reqMarketDataType(MarketDataType.DELAYED)
    // 恢复断线前全部订阅（tick-by-tick 在延迟行情下可能被拒，不影响 reqMktData 流）
    for (const [reqId, sub] of this.activeSubscriptions.entries()) {
      this.requestMarketData(reqId, sub.symbol, sub.contract)
    }
    this.emitStatus(true)
  }

  private handleDisconnected(): void {
    this.connected = false
    this.lastPrice.clear()
    this.lastSize.clear()
    this.lastTs.clear()
    this.lastEmit.clear()
    logger.warn('[IBKR] 连接断开，准备自动重连...')
    this.emitStatus(false)
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000) + Math.floor(Math.random() * 500)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.ib?.connect(this.clientId)
      // 若本轮连接仍失败，socket 会再次触发 error / disconnected → 继续指数退避重连
    }, delay)
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
    // 连接层错误：reqId = -1（NO_VALID_ID）且尚未连接成功（如 ECONNREFUSED / CONNECT_FAIL=502）
    if (!this.connected && reqId === ErrorCode.NO_VALID_ID) {
      this.connectionError = `${message}（ErrorCode=${code}${suffix}）`
      logger.warn(`[IBKR] 连接错误: ErrorCode=${code}${suffix} message=${message}`)
      this.emitStatus(false, err)
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
      logger.warn(`[IBKR] 连接被拒绝: InfoCode=326（clientId=${this.clientId} 已被其他客户端占用）。请修改 IBKR_CLIENT_ID 或删除该配置以使用随机 ID。原始信息: ${message}`)
      return
    }
    logger.info(`[IBKR] 通知(InfoCode=${code}): ${message}`)
  }

  /** result 事件每个数据消息都会触发，日志量大，仅 IBKR_DEBUG=true 时输出。 */
  private handleResult(eventName: string, args: unknown[]): void {
    if (config.ibkr.debug) logger.debug(`[IBKR] result: ${eventName} ${JSON.stringify(args ?? [])}`)
  }

  /** reqRealTimeBars（固定 5 秒 bar）→ { symbol, time, open, high, low, close, volume } 广播给订阅者。 */
  private handleRealtimeBar(reqId: number, time: number, open: number, high: number, low: number, close: number, volume: number): void {
    const sub = this.activeSubscriptions.get(reqId)
    if (!sub) return
    if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) return
    const bar: IBKRRealtimeBar = {
      symbol: sub.symbol,
      time: typeof time === 'number' && Number.isFinite(time) && time > 0 ? time * 1000 : Date.now(),
      open, high, low, close,
      volume: typeof volume === 'number' && Number.isFinite(volume) && volume > 0 ? volume : 0,
    }
    for (const listener of this.barListeners) {
      try { listener(bar) } catch (err) { logger.error('[IBKR] RealtimeBar 回调异常', err) }
    }
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
    // 实时行情流（snapshot=false, regulatorySnapshot=false）
    ib.reqMktData(reqId, contract, '', false, false)
    // 逐笔成交流（延迟行情下可能返回不支持错误，不影响 tickPrice / tickSize 流）
    try {
      ib.reqTickByTickData(reqId, contract, TickByTickDataType.AllLast, 0, false)
    } catch (err) {
      logger.warn(`[IBKR] ${symbol} 请求 tick-by-tick 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
    // 实时 K 线流（barSize 参数当前被 TWS 忽略，固定 5 秒 bar；延迟行情下若被拒仅影响实时 K 线，不影响 tick 流）
    try {
      ib.reqRealTimeBars(reqId, contract, 5, WhatToShow.TRADES, false)
      this.realTimeBarReqIds.add(reqId)
    } catch (err) {
      logger.warn(`[IBKR] ${symbol} 请求实时K线失败: ${err instanceof Error ? err.message : String(err)}`)
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
      if (this.realTimeBarReqIds.delete(reqId)) {
        try { this.ib.cancelRealTimeBars(reqId) } catch { /* 取消失败可忽略 */ }
      }
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
