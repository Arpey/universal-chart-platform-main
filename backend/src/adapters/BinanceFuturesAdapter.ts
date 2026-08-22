import WebSocket from 'ws'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { BaseAdapter } from './BaseAdapter'
import type { MarketAdapter } from '../types/adapter'
import type { Interval, Kline } from '../types/kline'
import type { Ticker } from '../types/market'
import { config } from '../utils/config'
import { logger } from '../utils/logger'

/**
 * 币安 U 本位永续合约（USDT-M Futures）适配器。
 * - REST:  fapi.binance.com/fapi/v1
 * - WS:    fstream.binance.com/ws/<symbol>@kline_<interval>（永续 symbol 为小写且不带 _ 后缀）
 * 请求通过本地代理（HTTP CONNECT）发出，以绕开网络封锁。
 */
export class BinanceFuturesAdapter extends BaseAdapter implements MarketAdapter {
  private readonly dispatcher = new ProxyAgent(config.proxy)

  // 短 TTL 缓存：避免每次请求都实时拉取币安全量接口（易超时/被限流）
  private symbolsCache: { data: Array<{ symbol: string; baseAsset: string; quoteAsset: string }>; at: number } | null = null
  private tickersCache: { data: Ticker[]; at: number } | null = null

  async getKlines(symbol: string, interval: Interval, limit = 300): Promise<Kline[]> {
    const url = `${config.futuresBaseUrl}/fapi/v1/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`
    const response = await undiciFetch(url, { dispatcher: this.dispatcher })
    if (!response.ok) throw new Error(`Binance Futures request failed: ${response.status} ${await response.text()}`)
    const rows = await response.json() as unknown[][]
    return rows.map((row) => ({
      time: Number(row[0]) / 1000,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5])
    }))
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const url = `${config.futuresBaseUrl}/fapi/v1/ticker/24hr?symbol=${symbol.toUpperCase()}`
    const response = await undiciFetch(url, { dispatcher: this.dispatcher })
    if (!response.ok) throw new Error(`Binance Futures ticker request failed: ${response.status} ${await response.text()}`)
    const data = await response.json() as Record<string, string>
    return {
      symbol: data.symbol,
      price: Number(data.lastPrice),
      change24h: Number(data.priceChangePercent),
      volume24h: Number(data.quoteVolume),
      updatedAt: Date.now()
    }
  }

  /** 拉取全部 USDT 报价的永续合约列表，用于前端搜索。交易对列表几乎不变，缓存 5 分钟。 */
  async getSymbols(): Promise<Array<{ symbol: string; baseAsset: string; quoteAsset: string }>> {
    if (this.symbolsCache && Date.now() - this.symbolsCache.at < 5 * 60_000) {
      return this.symbolsCache.data
    }
    const url = `${config.futuresBaseUrl}/fapi/v1/exchangeInfo`
    const response = await undiciFetch(url, { dispatcher: this.dispatcher })
    if (!response.ok) throw new Error(`Binance Futures exchangeInfo failed: ${response.status} ${await response.text()}`)
    const info = await response.json() as { symbols: Array<{ symbol: string; baseAsset: string; quoteAsset: string; contractType: string; status: string }> }
    const rows = info.symbols
      .filter((s) => s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL' && s.status === 'TRADING')
      .map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset }))
    this.symbolsCache = { data: rows, at: Date.now() }
    return rows
  }

  /** 拉取全部 USDT 永续合约的 24h 行情快照，用于交易对搜索列表实时展示。缓存 5 秒。 */
  async getAllTickers(): Promise<Ticker[]> {
    if (this.tickersCache && Date.now() - this.tickersCache.at < 5_000) {
      return this.tickersCache.data
    }
    const url = `${config.futuresBaseUrl}/fapi/v1/ticker/24hr`
    const response = await undiciFetch(url, { dispatcher: this.dispatcher })
    if (!response.ok) throw new Error(`Binance Futures tickers failed: ${response.status} ${await response.text()}`)
    const rows = (await response.json() as Array<Record<string, string>>)
      .filter((t) => t.symbol.endsWith('USDT'))
      .map((t) => ({
        symbol: t.symbol,
        price: Number(t.lastPrice),
        change24h: Number(t.priceChangePercent),
        volume24h: Number(t.quoteVolume),
        updatedAt: Date.now()
      }))
    this.tickersCache = { data: rows, at: Date.now() }
    return rows
  }

  subscribe(symbol: string, interval: Interval, onKline: (kline: Kline) => void): () => void {
    const stream = `${symbol.toLowerCase()}@kline_${interval}`
    const url = `${config.futuresWsUrl}/${stream}`
    const agent = new HttpsProxyAgent(config.proxy) // 复用一个 agent，避免重连时反复新建

    let socket: WebSocket | null = null
    let stopped = false
    let retries = 0
    let isAlive = false
    let lastMessageAt = 0 // 无数据看门狗：记录最近一次消息到达时间
    let pingTimer: ReturnType<typeof setInterval> | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const clearTimers = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    }

    const connect = () => {
      if (stopped) return
      socket = new WebSocket(url, { agent })

      socket.on('open', () => {
        retries = 0
        isAlive = true
        lastMessageAt = Date.now() // 以本次连接建立时刻为基准
        logger.info(`[BinanceFutures] WS 已连接: ${stream}`)
        // 无数据看门狗：连接后 10s 内未收到任何消息则告警（典型场景：代理节点被币安静默断流，连接正常但无数据）
        setTimeout(() => {
          if (stopped) return
          if (Date.now() - lastMessageAt > 10_000) {
            logger.warn(`[BinanceFutures] 已连接但 10s 内未收到数据，请检查代理节点/网络/数据源: ${stream}`)
          }
        }, 10_000)
        // 心跳：每 20s ping 一次；下一轮仍未收到 pong 则判死并强制重连
        pingTimer = setInterval(() => {
          if (!socket) return
          if (!isAlive) {
            logger.warn(`[BinanceFutures] 心跳超时，强制断开: ${stream}`)
            socket.terminate() // 触发 close → 自动重连
            return
          }
          isAlive = false
          socket.ping()
        }, 20_000)
      })

      socket.on('pong', () => { isAlive = true })

      socket.on('message', (raw) => {
        lastMessageAt = Date.now() // 看门狗基准：任一消息到达即刷新

        // 解析错误与 onKline 回调异常分开记录，避免转发层异常被误报为“消息解析失败”
        let data: { k: Record<string, string | number> }
        try {
          data = JSON.parse(raw.toString()) as { k: Record<string, string | number> }
        } catch (err) {
          logger.error(`[BinanceFutures] 消息解析失败: ${stream}`, err)
          return // 脏消息直接丢弃，不影响后续消息
        }

        const k = data.k
        // 周期内会连续推送同一根未收盘 K 线，前端按 time 去重即可
        try {
          onKline({
            time: Number(k.t) / 1000,
            open: Number(k.o),
            high: Number(k.h),
            low: Number(k.l),
            close: Number(k.c),
            volume: Number(k.v)
          })
        } catch (err) {
          logger.error(`[BinanceFutures] onKline 回调异常: ${stream}`, err)
        }
      })

      socket.on('error', (err) => {
        logger.error(`[BinanceFutures] WS 错误: ${stream}`, err)
      })

      socket.on('close', () => {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
        if (stopped) return
        // 指数退避重连：1s,2s,4s...最大 30s，加随机抖动避免集中重连
        const delay = Math.min(1000 * 2 ** retries, 30_000) + Math.floor(Math.random() * 500)
        retries += 1
        logger.warn(`[BinanceFutures] WS 断开，${(delay / 1000).toFixed(1)}s 后重连: ${stream}`)
        reconnectTimer = setTimeout(connect, delay)
      })
    }

    connect()

    return () => {
      stopped = true // 置位后 close 回调不会再触发重连
      clearTimers()
      socket?.close()
      socket = null
    }
  }
}
