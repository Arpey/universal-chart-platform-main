import type { Server } from 'http'
import { WebSocketServer, type WebSocket } from 'ws'
import { BinanceFuturesAdapter } from '../adapters/BinanceFuturesAdapter'
import type { Interval } from '../types/kline'
import { logger } from '../utils/logger'

export function attachMarketSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' })
  const adapter = new BinanceFuturesAdapter()

  // 服务器心跳：每 30s ping 所有客户端，未回 pong 的 terminate。
  // 浏览器会自动回复 pong；前端收到 close 后自动重连，形成闭环。
  const HEARTBEAT_INTERVAL = 30_000
  const aliveClients = new WeakSet<WebSocket>()
  const heartbeat = setInterval(() => {
    wss.clients.forEach((client) => {
      if (!aliveClients.has(client)) {
        client.terminate()
        return
      }
      aliveClients.delete(client)
      client.ping()
    })
  }, HEARTBEAT_INTERVAL)
  wss.on('close', () => clearInterval(heartbeat)) // 关闭时清理定时器，防止泄漏

  wss.on('connection', (client, request) => {
    const query = new URL(request.url ?? '', 'http://localhost').searchParams
    const symbol = query.get('symbol') ?? 'BTCUSDT'
    const interval = query.get('interval') ?? '1m'

    let unsubscribe: (() => void) | null = null
    const cleanup = () => {
      unsubscribe?.() // 幂等：只清理一次
      unsubscribe = null
    }

    // 尽早注册 error/close 处理器：
    // 1) error 事件必须有监听，否则客户端异常断开会触发未捕获 error 导致进程崩溃
    // 2) 任何提前 return 的路径（参数校验失败/订阅失败）也能正确清理与关闭
    client.on('error', (error) => {
      logger.error(`WebSocket 错误: ${symbol} ${interval}`, error)
      cleanup()
      client.terminate() // 错误后确保真正关闭，避免悬挂连接
    })
    client.on('close', () => {
      cleanup()
      logger.info(`WebSocket 客户端断开连接: ${symbol} ${interval}`)
    })

    try {
      // 参数白名单校验：防止构造非法流名导致静默无数据
      const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d']
      if (!/^[A-Z0-9]{3,20}$/.test(symbol) || !INTERVALS.includes(interval)) {
        client.send(JSON.stringify({ type: 'error', message: '非法参数' }))
        client.close(1008)
        return
      }

      logger.info(`WebSocket 客户端连接: ${symbol} ${interval}`)

      aliveClients.add(client)
      client.on('pong', () => aliveClients.add(client))

      // 订阅行情
      unsubscribe = adapter.subscribe(symbol, interval as Interval, (kline) => {
        if (client.readyState === client.OPEN) {
          client.send(JSON.stringify({ type: 'kline', data: kline }))
        }
      })

      // 发送连接确认
      client.send(JSON.stringify({ type: 'connected', symbol, interval }))
    } catch (error) {
      logger.error('WebSocket 连接处理失败', error)
      client.send(JSON.stringify({ type: 'error', message: '连接处理失败' }))
      client.close(1000)
    }
  })

  logger.info(`WebSocket 服务启动在 /ws`)
  return wss
}
