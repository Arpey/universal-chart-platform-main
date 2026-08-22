import type { Interval, Kline } from '../types'
const wsUrl = import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001/ws'

type WsIncoming =
  | { type: 'kline'; data: Kline }
  | { type: 'connected'; symbol: string; interval: string }
  | { type: 'error'; message: string }

export function connectMarket(
  symbol: string,
  interval: Interval,
  onKline: (kline: Kline) => void,
  onState: (connected: boolean) => void,
) {
  const url = `${wsUrl}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`
  let socket: WebSocket | null = null
  let stopped = false
  let retries = 0
  let reconnectTimer: number | null = null

  const scheduleReconnect = () => {
    if (stopped) return // 已被手动断开或替换，禁止重连
    onState(false)
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
      onState(true)
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
      // 只把真正的 K 线数据交给 store；connected / error 等协议消息忽略
      if (msg?.type === 'kline' && msg.data) {
        onKline(msg.data)
      } else if (msg?.type === 'connected') {
        onState(true)
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
