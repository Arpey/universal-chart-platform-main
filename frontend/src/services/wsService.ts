import type { DataSource, Dom, Interval, Kline, Quote, TradeTick } from '../types'
import type { WsIncoming } from './chartService'
const wsUrl = import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001/ws'

export type WsDataType = 'kline' | 'quote' | 'dom' | 'tick'

export interface ConnectOptions {
  datasource?: DataSource
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

export function connectMarket(
  symbol: string,
  interval: Interval,
  opts: ConnectOptions = {},
) {
  const { datasource = 'binance', dataType = 'kline' } = opts
  const url = `${wsUrl}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&datasource=${datasource}&dataType=${dataType}`
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
    socket = new WebSocket(url)
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
  return () => {
    stopped = true // 清理后永不重连，防止旧连接定时器泄漏
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    socket?.close()
    socket = null
  }
}

