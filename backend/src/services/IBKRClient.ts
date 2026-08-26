import {
  IBApi,
  EventName,
  ErrorCode,
  SecType,
  MarketDataType,
  TickByTickDataType,
} from '@stoqey/ib'
import type { Contract, TickType } from '@stoqey/ib'
import { config } from '../utils/config'
import { logger } from '../utils/logger'

/** IBKR 行情合并后输出的标准化 tick（不含 type/source，由适配器补全） */
export interface IBKRTick {
  symbol: string
  price: number
  size: number
  timestamp: number
}

type TickListener = (tick: IBKRTick) => void
type StatusListener = (connected: boolean, error?: Error) => void

/**
 * 支持的 CME 期货根合约。
 * 不指定合约月份时，IB Gateway / TWS 会自动解析为当前近月合约。
 */
const CONTRACTS: Record<string, Contract> = {
  MES: { symbol: 'MES', secType: SecType.FUT, exchange: 'CME', currency: 'USD' },
  MNQ: { symbol: 'MNQ', secType: SecType.FUT, exchange: 'CME', currency: 'USD' },
  MGC: { symbol: 'MGC', secType: SecType.FUT, exchange: 'COMEX', currency: 'USD' },
}

export const IBKR_SYMBOLS = Object.keys(CONTRACTS)

interface ActiveSubscription {
  symbol: string
  contract: Contract
}

/**
 * IBKR（盈透证券）底层行情客户端：
 * - 连接本地 IB Gateway / TWS（默认端口 4002），处理 error / connected / disconnected 事件；
 * - 连接成功后立即请求延迟行情（MarketDataType.DELAYED = 3），未付费订阅也能免费获取测试数据；
 * - 每个合约同时发起 reqMktData + reqTickByTickData(AllLast)，
 *   监听 tickPrice / tickSize / tickByTickAllLast 并合并为 { symbol, price, size, timestamp }；
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

  constructor() {
    this.host = config.ibkr.host
    this.port = config.ibkr.port
    this.clientId = config.ibkr.clientId
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

  /**
   * 订阅指定合约的实时行情。同一合约重复订阅共享底层数据流（引用计数管理）。
   * @returns 取消订阅函数；最后一个订阅取消时自动 cancelMktData / cancelTickByTickData。
   */
  subscribeMarketData(symbol: string): () => void {
    const contract = CONTRACTS[symbol]
    if (!contract) throw new Error(`不支持的 IBKR 合约: ${symbol}（支持 ${IBKR_SYMBOLS.join('/')}）`)

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
    const ib = new IBApi({ host: this.host, port: this.port })
    this.ib = ib
    ib.on(EventName.connected, () => this.handleConnected())
    ib.on(EventName.disconnected, () => this.handleDisconnected())
    ib.on(EventName.error, (err, code, reqId) => this.handleError(err, code, reqId))
    ib.on(EventName.tickPrice, (reqId, field, value) => this.handleTickPrice(reqId, field, value))
    ib.on(EventName.tickSize, (reqId, field, value) => this.handleTickSize(reqId, field, value))
    ib.on(EventName.tickByTickAllLast, (reqId, _tickType, _time, price, size) => this.handleTickByTickAllLast(reqId, price, size))
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
    // 1100/1101：TWS 与 IB 服务器连接中断 / 恢复（行情订阅可能丢失），需重新提交订阅
    if (code === ErrorCode.FAIL_CONNECTION_LOST_BETWEEN_SERVER_AND_TWS || code === ErrorCode.CONNECTIVITY_RESTORED_DATA_LOST) {
      logger.warn(`[IBKR] 行情连接${code === ErrorCode.FAIL_CONNECTION_LOST_BETWEEN_SERVER_AND_TWS ? '中断' : '恢复'}，重新订阅全部合约`)
      for (const [reqId, sub] of this.activeSubscriptions.entries()) this.requestMarketData(reqId, sub.symbol, sub.contract)
      return
    }
    // 连接层错误：reqId = -1（NO_VALID_ID）且尚未连接成功（如 ECONNREFUSED / CONNECT_FAIL）
    if (!this.connected && reqId === ErrorCode.NO_VALID_ID) {
      this.connectionError = message
      logger.warn(`[IBKR] 连接错误: ${message}`)
      this.emitStatus(false, err)
      return
    }
    logger.warn(`[IBKR] 行情错误(reqId=${reqId}, code=${code}): ${message}`)
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
