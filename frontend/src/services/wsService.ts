import type { DataSource, Dom, Interval, Kline, Quote, TradeTick } from '../types'
import type { WsIncoming } from './chartService'
const wsUrl = import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001/ws'

export type WsDataType = 'kline' | 'quote' | 'dom' | 'tick'

export interface ConnectOptions {
  /** 数据源/分类：binance（默认）| tradefi | tradovate | ibkr */
  source?: DataSource
  /** 订阅类型：kline（默认）| quote | dom | tick */
  dataType?: WsDataType
  onKline?: (kline: Kline) => void
  /** 全量历史批量（Tradovate hist），应整表替换 */
  onHist?: (klines: Kline[]) => void
  onQuote?: (quote: Quote) => void
  onDom?: (dom: Dom) => void
  onTick?: (tick: TradeTick) => void
  onState?: (connected: boolean) => void
  onError?: (message: string) => void
}

export interface MarketConnection {
  disconnect: () => void
  /** 切换数据源/分类并自动重连（如 binance → tradefi）。 */
  setSource: (source: DataSource) => void
}

export function connectMarket(
  symbol: string,
  interval: Interval,
  opts: ConnectOptions = {},
): MarketConnection {
  const { source = 'binance', dataType = 'kline' } = opts
  let currentSource: DataSource = source
  const url = () => `${wsUrl}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&source=${currentSource}&dataType=${dataType}`
  let socket: WebSocket | null = null
  let stopped = false
  let retries = 0
  let reconnectTimer: number | null = null

  const scheduleReconnect = () => {
    if (stopped) return // 已被手动断开或替换，禁止重连
    opts.onState?.(false)
    // 指数退避：1s,2s,4s...最大 15s，加随机抖动避免集中重连
    const delay = Math.min(1000 * 2 ** retries, 15_000) + Math.floor(Math.random() * 300)
    retries += 1
    reconnectTimer = window.setTimeout(connect, delay)
  }

  const connect = () => {
    if (stopped) return
    socket = new WebSocket(url())
    socket.onopen = () => {
      retries = 0
      opts.onState?.(true)
    }
    socket.onclose = scheduleReconnect
    socket.onerror = () => { socket?.close() } // close 会触发 onclose → 重连
    socket.onmessage = (event) => {
      let msg: WsIncoming
      try {
        msg = JSON.parse(event.data) as WsIncoming
      } catch {
        return // 忽略无法解析的消息
      }
      switch (msg?.type) {
        case 'kline':
          if (msg.data) opts.onKline?.(msg.data as Kline)
          break
        case 'hist':
          if (msg.data) opts.onHist?.(msg.data as Kline[])
          break
        case 'quote':
          if (msg.data) opts.onQuote?.(msg.data as Quote)
          break
        case 'dom':
          if (msg.data) opts.onDom?.(msg.data as Dom)
          break
        case 'tick':
          if (msg.data) opts.onTick?.(msg.data as TradeTick)
          break
        case 'connected':
          opts.onState?.(true)
          break
        case 'error':
          opts.onError?.(msg.message ?? '数据源错误')
          opts.onState?.(false)
          break
        default:
          break
      }
    }
  }

  connect()

  return {
    disconnect: () => {
      stopped = true // 清理后永不重连，防止旧连接定时器泄漏
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      socket?.close()
      socket = null
    },
    setSource: (next) => {
      if (stopped || currentSource === next) return
      currentSource = next
      // 关闭当前连接触发 onclose → 自动用新 URL 重连；已断开则直接重建
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.close()
      else connect()
    },
  }
}

// ---------- IBKR 消息驱动订阅（CME 期货逐笔行情） ----------

/** IBKR CME 期货标的（get_symbols 响应项）。 */
export interface IBKRSymbolInfo {
  symbol: string
  name?: string
  exchange?: string
  secType?: string
}

export interface IBKRConnectOptions {
  /** 当前订阅的 IBKR 合约（如 MES），连接建立/重连后自动发送 subscribe 消息。 */
  symbol: string
  /** K 线周期（随 subscribe 消息下发，决定后端 reqHistoricalData / reqRealTimeBars 粒度）。 */
  interval: Interval
  /** get_symbols 返回的 CME 期货标的列表。 */
  onSymbols?: (symbols: IBKRSymbolInfo[]) => void
  /** IBKR tick 行情（标准化为 TradeTick，side 为空）。 */
  onTick?: (tick: TradeTick) => void
  /** IBKR 实时 K 线（后端 reqRealTimeBars 推送 { symbol, time, open, high, low, close, volume }）。 */
  onKline?: (kline: Kline) => void
  /** IBKR 历史 K 线（后端 reqHistoricalData 一次性推送；分页时 append=true 表示更早数据，应合并而非替换）。 */
  onHist?: (klines: Kline[], append?: boolean) => void
  onState?: (connected: boolean) => void
  onError?: (message: string) => void
}

export interface IBKRConnection {
  disconnect: () => void
  /** 分页加载更早历史：endDateTime = 已加载 K 线最左侧的 Unix 时间戳（epoch ms）。 */
  loadMoreHistory: (endDateTime: number) => void
}

/**
 * IBKR 消息驱动连接：WebSocket 建立后通过 JSON 消息控制（而非 URL 参数订阅）。
 * - 后端将无查询参数的连接识别为「控制通道」，不建立 URL 订阅；
 * - 打开/重连后发送 { action: 'get_symbols', source: 'IBKR' } 拉取 CME 期货标的列表，
 *   并发送 { action: 'subscribe', source: 'IBKR', symbol } 订阅逐笔行情；
 * - 后端广播 { type: 'ticker', source: 'IBKR', symbol, price, size, timestamp }。
 */
export function connectIBKR(opts: IBKRConnectOptions): IBKRConnection {
  let socket: WebSocket | null = null
  let stopped = false
  let retries = 0
  let reconnectTimer: number | null = null

  const send = (payload: unknown) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
  }
  const requestSymbols = () => send({ action: 'get_symbols', source: 'IBKR' })
  const subscribe = () => send({ action: 'subscribe', source: 'IBKR', symbol: opts.symbol, interval: opts.interval })
  /** 分页拉取更早历史 K 线（向后端透传最左侧时间戳）。 */
  const loadMoreHistory = (endDateTime: number) => send({ action: 'load_more_history', source: 'IBKR', symbol: opts.symbol, interval: opts.interval, endDateTime })

  const connect = () => {
    if (stopped) return
    socket = new WebSocket(wsUrl) // 无查询参数 → 后端识别为消息驱动控制通道
    socket.onopen = () => {
      retries = 0
      opts.onState?.(true)
      requestSymbols()
      subscribe()
    }
    socket.onmessage = (event) => {
      let msg: {
        type?: string
        data?: unknown
        message?: string
        symbol?: string
        price?: number
        size?: number
        timestamp?: number
        append?: boolean
      }
      try {
        msg = JSON.parse(event.data as string) as typeof msg
      } catch {
        return // 忽略无法解析的消息
      }
      switch (msg?.type) {
        case 'symbols':
          if (Array.isArray(msg.data)) opts.onSymbols?.(msg.data as IBKRSymbolInfo[])
          break
        case 'ticker':
          if (typeof msg.price === 'number' && Number.isFinite(msg.price) && msg.price > 0) {
            opts.onTick?.({
              symbol: String(msg.symbol ?? opts.symbol),
              price: msg.price,
              size: typeof msg.size === 'number' && msg.size > 0 ? msg.size : 0,
              side: '',
              timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
            })
          }
          break
        case 'kline':
          if (msg.data) opts.onKline?.(msg.data as Kline)
          break
        case 'hist':
          if (Array.isArray(msg.data)) opts.onHist?.(msg.data as Kline[], Boolean(msg.append))
          break
        case 'connected':
          opts.onState?.(true)
          break
        case 'unsubscribed':
          break
        case 'error':
          opts.onError?.(msg.message ?? 'IBKR 数据源错误')
          opts.onState?.(false)
          break
        default:
          break
      }
    }
    socket.onclose = () => {
      opts.onState?.(false)
      if (stopped) return // 已被手动断开，禁止重连
      // 指数退避：1s,2s,4s...最大 15s，加随机抖动避免集中重连
      const delay = Math.min(1000 * 2 ** retries, 15_000) + Math.floor(Math.random() * 300)
      retries += 1
      reconnectTimer = window.setTimeout(connect, delay)
    }
    socket.onerror = () => { socket?.close() } // close 会触发 onclose → 重连
  }

  connect()

  return {
    disconnect: () => {
      stopped = true // 清理后永不重连，防止旧连接定时器泄漏
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      socket?.close()
      socket = null
    },
    loadMoreHistory,
  }
}

