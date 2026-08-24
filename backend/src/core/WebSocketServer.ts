import type { Server } from 'http'
import { WebSocketServer, type WebSocket } from 'ws'
import { MarketManager } from './MarketManager'
import type { MarketDataAdapter } from '../types/adapter'
import type { Interval } from '../types/kline'
import { logger } from '../utils/logger'

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const
const DATASOURCES = ['binance', 'tradovate', 'tradefi'] as const
const DATA_TYPES = ['kline', 'quote', 'dom', 'tick'] as const

type WsDataType = (typeof DATA_TYPES)[number]

export function attachMarketSocket(server: Server, manager = new MarketManager()) {
  const wss = new WebSocketServer({ server, path: '/ws' })

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
    const interval = (query.get('interval') ?? '1m') as Interval
    const datasource = query.get('source') ?? query.get('datasource') ?? 'binance'
    const dataType = (query.get('dataType') ?? 'kline') as WsDataType

    let unsubscribe: (() => void) | null = null
    const cleanup = () => {
      unsubscribe?.() // 幂等：只清理一次
      unsubscribe = null
    }
    const send = (payload: unknown) => {
      if (client.readyState === client.OPEN) client.send(JSON.stringify(payload))
    }

    // 尽早注册 error/close 处理器，任何提前 return / 抛错路径都能正确清理与关闭
    client.on('error', (error) => {
      logger.error(`WebSocket 错误: ${datasource}/${dataType} ${symbol} ${interval}`, error)
      cleanup()
      client.terminate()
    })
    client.on('close', () => {
      cleanup()
      logger.info(`WebSocket 客户端断开连接: ${datasource}/${dataType} ${symbol} ${interval}`)
    })

    try {
      // 参数白名单校验：防止构造非法流名导致静默无数据
      if (
        !/^[A-Z0-9]{1,20}$/.test(symbol)
        || !(INTERVALS as readonly string[]).includes(interval)
        || !(DATASOURCES as readonly string[]).includes(datasource)
        || !(DATA_TYPES as readonly string[]).includes(dataType)
      ) {
        send({ type: 'error', message: '非法参数' })
        client.close(1008)
        return
      }

      logger.info(`WebSocket 客户端连接: ${datasource}/${dataType} ${symbol} ${interval}`)

      aliveClients.add(client)
      client.on('pong', () => aliveClients.add(client))

      const adapter = manager.resolve(datasource)

      // 连接前预检（Tradovate 需先完成鉴权），通过后才建立上游订阅
      const preflight = adapter.ping?.() ?? Promise.resolve()
      preflight
        .then(() => {
          if (client.readyState !== client.OPEN) return
          unsubscribe = createSubscription(adapter, dataType, symbol, interval, send)
          send({ type: 'connected', symbol, interval, datasource, dataType })
        })
        .catch((err) => {
          logger.error(`数据源预检失败: ${datasource}`, err)
          send({ type: 'error', message: err instanceof Error ? err.message : '数据源连接失败' })
          client.close(1011)
        })
    } catch (error) {
      logger.error('WebSocket 连接处理失败', error)
      send({ type: 'error', message: error instanceof Error ? error.message : '连接处理失败' })
      client.close(1000)
    }
  })

  logger.info(`WebSocket 服务启动在 /ws`)
  return wss
}

/** 按 dataType 建立对应上游订阅，并把标准化行情广播给客户端。 */
function createSubscription(
  adapter: MarketDataAdapter,
  dataType: WsDataType,
  symbol: string,
  interval: Interval,
  send: (payload: unknown) => void,
): () => void {
  const onError = (message: string) => send({ type: 'error', message })
  switch (dataType) {
    case 'kline':
      // onKline 单根增量；onHist 全量批量（Tradovate hist，前端整表替换）
      return adapter.subscribe(
        symbol,
        interval,
        (kline) => send({ type: 'kline', data: kline }),
        (klines) => send({ type: 'hist', data: klines }),
        onError,
      )
    case 'quote':
      if (!adapter.subscribeQuote) throw new Error('当前数据源不支持报价流')
      return adapter.subscribeQuote(symbol, (data) => send({ type: 'quote', data }), onError)
    case 'dom':
      if (!adapter.subscribeDOM) throw new Error('当前数据源不支持盘口流')
      return adapter.subscribeDOM(symbol, (data) => send({ type: 'dom', data }), onError)
    case 'tick':
      if (!adapter.subscribeTick) throw new Error('当前数据源不支持逐笔流')
      return adapter.subscribeTick(symbol, (data) => send({ type: 'tick', data }), onError)
    default:
      throw new Error('非法 dataType')
  }
}

