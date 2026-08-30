import type { Server } from 'http'
import { WebSocketServer, type WebSocket } from 'ws'
import { MarketManager } from './MarketManager'
import type { MarketDataAdapter } from '../types/adapter'
import type { Interval } from '../types/kline'
import { IBKR_CME_SYMBOLS } from '../services/IBKRClient'
import { config } from '../utils/config'
import { logger } from '../utils/logger'

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const
const DATASOURCES = ['binance', 'tradovate', 'tradefi'] as const
const DATA_TYPES = ['kline', 'quote', 'dom', 'tick'] as const

type WsDataType = (typeof DATA_TYPES)[number]

export function attachMarketSocket(server: Server, manager = new MarketManager()) {
  const wss = new WebSocketServer({ server, path: '/ws' })

  // IBKR 适配器单例（IBKR_ENABLED=true 时启用；连接为懒建立，首次订阅消息才连本地 IB Gateway / TWS）
  const ibkrAdapter: MarketDataAdapter | null = config.ibkr.enabled ? manager.resolve('ibkr') : null

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
    const requestUrl = new URL(request.url ?? '', 'http://localhost')
    // 无查询参数 = 纯消息驱动控制通道（IBKR get_symbols / subscribe），不建立 URL 订阅
    const isControlChannel = requestUrl.search === ''
    const query = requestUrl.searchParams
    const symbol = query.get('symbol') ?? 'BTCUSDT'
    const interval = (query.get('interval') ?? '1m') as Interval
    const datasource = query.get('source') ?? query.get('datasource') ?? 'binance'
    const dataType = (query.get('dataType') ?? 'kline') as WsDataType

    let unsubscribe: (() => void) | null = null
    // IBKR 消息驱动订阅集合：symbol -> 取消函数（client 断开时统一清理）
    const ibkrSubscriptions = new Map<string, () => void>()
    const cleanup = () => {
      unsubscribe?.() // 幂等：只清理一次
      unsubscribe = null
      for (const unsub of ibkrSubscriptions.values()) unsub()
      ibkrSubscriptions.clear()
    }
    const send = (payload: unknown) => {
      if (client.readyState === client.OPEN) client.send(JSON.stringify(payload))
    }

    // 消息驱动订阅：处理前端 JSON 消息，例如 {"action": "subscribe", "source": "IBKR", "symbol": "MES"}
    client.on('message', (raw) => {
      let msg: { action?: unknown; source?: unknown; symbol?: unknown; interval?: unknown; endDateTime?: unknown } | null = null
      try { msg = JSON.parse(raw.toString()) } catch { return } // 忽略非 JSON 消息
      if (!msg) return
      const action = String(msg.action ?? '').toLowerCase()
      const source = String(msg.source ?? '')
      if (source !== 'IBKR') return // 当前仅支持 IBKR 数据源的消息订阅

      // 获取 CME 期货标的列表（前端搜索弹窗选择 IBKR 时调用）
      if (action === 'get_symbols') {
        send({ type: 'symbols', source: 'IBKR', data: IBKR_CME_SYMBOLS })
        return
      }

      const symbol = String(msg.symbol ?? '').toUpperCase().trim()
      if (!/^[A-Z0-9]{1,20}$/.test(symbol)) {
        send({ type: 'error', message: '非法的 IBKR 合约代码' })
        return
      }
      const interval = (String(msg.interval ?? '1m') as Interval)
      if (!(INTERVALS as readonly string[]).includes(interval)) {
        send({ type: 'error', message: '非法的 K 线周期' })
        return
      }

      if (action === 'subscribe') {
        const adapter = ibkrAdapter
        if (!adapter?.subscribeTick || !adapter.subscribeBar) {
          send({ type: 'error', message: 'IBKR 数据源未启用（请检查 IBKR_ENABLED 配置）' })
          return
        }
        if (ibkrSubscriptions.has(symbol)) return // 同一 client 重复订阅去重
        // 连接预检：等待本地 IB Gateway / TWS 就绪，失败时向前端返回明确错误
        const preflight = adapter.ping?.() ?? Promise.resolve()
        preflight
          .then(async () => {
            if (client.readyState !== client.OPEN) return
            if (ibkrSubscriptions.has(symbol)) return
            const unsubs: Array<() => void> = []
            // 0) 底层连接状态：断线/重连时广播给客户端（前端据此提示）
            const unsubStatus = adapter.onStatus?.((connected, error) => {
              if (client.readyState !== client.OPEN) return
              if (connected) send({ type: 'connected', source: 'IBKR', symbol, interval, dataType: 'tick' })
              else send({ type: 'error', message: error?.message ? `[IBKR] 连接断开: ${error.message}` : '[IBKR] 连接断开，自动重连中...' })
            })
            if (unsubStatus) unsubs.push(unsubStatus)
            // 1) 逐笔 tick 流（reqContractDetails 解析合约 → reqMktData + reqTickByTickData）
            try {
              const unsubTick = await adapter.subscribeTick!(
                symbol,
                (tick) => send(tick), // TickerMessage 直接广播：{ type: 'ticker', source: 'IBKR', ... }
                (message) => send({ type: 'error', message }),
              )
              unsubs.push(unsubTick)
            } catch (err) {
              send({ type: 'error', message: err instanceof Error ? err.message : 'IBKR tick 订阅失败' })
              for (const unsub of unsubs) unsub()
              return
            }
            // 2) 实时 K 线流（reqRealTimeBars → { symbol, time, open, high, low, close, volume }）
            try {
              const unsubBar = await adapter.subscribeBar!(
                symbol,
                interval,
                (kline) => send({ type: 'kline', source: 'IBKR', symbol, interval, data: kline }),
                (message) => send({ type: 'error', message }),
              )
              unsubs.push(unsubBar)
            } catch (err) {
              send({ type: 'error', message: err instanceof Error ? err.message : 'IBKR 实时K线订阅失败' })
              for (const unsub of unsubs) unsub()
              return
            }
            // 3) 历史 K 线快照（reqHistoricalData 一次性全量，内置超时；失败仅报错不影响实时流）
            void adapter.getKlines(symbol, interval, 300)
              .then((rows) => {
                if (client.readyState === client.OPEN) send({ type: 'hist', source: 'IBKR', symbol, interval, append: false, data: rows })
              })
              .catch((err) => send({ type: 'error', message: err instanceof Error ? err.message : 'IBKR 历史K线加载失败' }))
            ibkrSubscriptions.set(symbol, () => { for (const unsub of unsubs) unsub() })
            send({ type: 'connected', source: 'IBKR', symbol, interval, dataType: 'tick' })
          })
          .catch((err) => {
            send({ type: 'error', message: err instanceof Error ? err.message : 'IBKR 数据源连接失败' })
          })
      } else if (action === 'unsubscribe') {
        const unsub = ibkrSubscriptions.get(symbol)
        if (unsub) {
          unsub()
          ibkrSubscriptions.delete(symbol)
          send({ type: 'unsubscribed', source: 'IBKR', symbol })
        }
      } else if (action === 'load_more_history') {
        // 分页拉取更早历史：endDateTime = 当前已加载 K 线最左侧的 Unix 时间戳（epoch ms），
        // 后端透传给 reqHistoricalData 的 endDateTime，返回更早一段数据并以 append 标记推送。
        const adapter = ibkrAdapter
        if (!adapter?.getKlines) {
          send({ type: 'error', message: 'IBKR 数据源未启用（请检查 IBKR_ENABLED 配置）' })
          return
        }
        const endDateTime = Number(msg.endDateTime)
        if (!Number.isFinite(endDateTime) || endDateTime <= 0) {
          send({ type: 'error', message: '非法的 endDateTime（应为已加载 K 线最左侧的 Unix 时间戳）' })
          return
        }
        logger.info(`[IBKR] load_more_history: ${symbol} ${interval} endDateTime=${endDateTime}`)
        void adapter.getKlines(symbol, interval, 300, endDateTime)
          .then((rows) => {
            if (client.readyState === client.OPEN) send({ type: 'hist', source: 'IBKR', symbol, interval, append: true, data: rows })
          })
          .catch((err) => send({ type: 'error', message: err instanceof Error ? err.message : 'IBKR 历史K线加载失败' }))
      }
    })

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
      // 无查询参数 = 纯消息驱动控制通道：仅等待 { action: "get_symbols" | "subscribe" } JSON 消息
      if (isControlChannel) {
        aliveClients.add(client)
        client.on('pong', () => aliveClients.add(client))
        logger.info('WebSocket 控制通道连接（IBKR 消息驱动）')
        return
      }
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
      // IBKR 的 subscribeTick 为异步（需先解析合约），仅经控制通道订阅，不会走到这里；
      // 其它数据源为同步，直接返回取消函数。
      const tickUnsub = adapter.subscribeTick(symbol, (data) => send({ type: 'tick', data }), onError)
      return typeof tickUnsub === 'function' ? tickUnsub : () => { void tickUnsub.then((unsub) => unsub()) }
    default:
      throw new Error('非法 dataType')
  }
}

