import WebSocket from 'ws'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { BaseAdapter } from './BaseAdapter'
import type { MarketDataAdapter, SymbolInfo } from '../types/adapter'
import type { Interval, Kline } from '../types/kline'
import type { Ticker, TradeData } from '../types/market'
import { config } from '../utils/config'
import { logger } from '../utils/logger'

/**
 * 币安 U 本位永续合约（USDT-M Futures）行情适配器（TradFi 衍生品数据源）。
 * - REST: fapi.binance.com/fapi/v1，无需任何 API Key 鉴权；
 * - WS:   wss://fstream.binance.com/ws/<symbol>@kline_<interval>（K 线）
 *         wss://fstream.binance.com/ws/<symbol>@aggTrade（逐笔成交）
 * - 心跳：每 20s 发送一次 ping，下一轮未收到 pong 则判死并强制重连；
 * - 重连：指数退避 1s→30s + 随机抖动。
 * 请求通过本地代理（HTTP CONNECT）发出，以绕开网络封锁。
 */

/** 币安 kline 事件 → 项目统一 K 线结构（标准 Kline + 事件附加字段 symbol / isFinal）。 */
export interface BinanceKline extends Kline {
  symbol: string
  /** 本根 K 线是否已闭合 */
  isFinal: boolean
}

export class BinanceAdapter extends BaseAdapter implements MarketDataAdapter {
  private readonly dispatcher = new ProxyAgent(config.proxy)

  // 短 TTL 缓存：避免每次请求都实时拉取币安全量接口（易超时/被限流）
  private symbolsCache: { data: SymbolInfo[]; at: number } | null = null
  private tickersCache: { data: Ticker[]; at: number } | null = null

  async getKlines(symbol: string, interval: Interval, limit = 300): Promise<Kline[]> {
    const url = `${config.futuresBaseUrl}/fapi/v1/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`
    const response = await undiciFetch(url, { dispatcher: this.dispatcher })
    if (!response.ok) throw new Error(`Binance Futures request failed: ${response.status} ${await response.text()}`)
    const rows = await response.json() as unknown[][]
    return rows.map((row) => ({
      // 币安 REST 返回毫秒时间戳，统一换算为秒（与全项目 Kline 模型一致）
      time: Number(row[0]) / 1000,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
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
      updatedAt: Date.now(),
    }
  }

  /** 拉取全部 USDT 报价的永续合约列表，用于前端搜索。交易对列表几乎不变，缓存 5 分钟。 */
  async getSymbols(): Promise<SymbolInfo[]> {
    if (this.symbolsCache && Date.now() - this.symbolsCache.at < 5 * 60_000) return this.symbolsCache.data
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
    if (this.tickersCache && Date.now() - this.tickersCache.at < 5_000) return this.tickersCache.data
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
        updatedAt: Date.now(),
      }))
    this.tickersCache = { data: rows, at: Date.now() }
    return rows
  }

  /** 连通性预检（REST），WS 连接前调用。 */
  async ping(): Promise<void> {
    const url = `${config.futuresBaseUrl}/fapi/v1/time`
    const response = await undiciFetch(url, { dispatcher: this.dispatcher })
    if (!response.ok) throw new Error(`Binance Futures ping failed: ${response.status}`)
  }

  /**
   * 订阅 K 线增量。返回取消订阅函数。
   * 币安会在周期内连续推送同一根未收盘 K 线，前端按 time 去重即可。
   */
  subscribe(
    symbol: string,
    interval: Interval,
    onKline: (kline: BinanceKline) => void,
    _onHist?: (klines: Kline[]) => void,
    onError?: (message: string) => void,
  ): () => void {
    const stream = `${symbol.toLowerCase()}@kline_${interval}`
    return this.connectStream(stream, (raw) => {
      let data: { s: string; k: Record<string, string | number | boolean> }
      try {
        data = JSON.parse(raw.toString())
      } catch (err) {
        logger.error(`[Binance] 消息解析失败: ${stream}`, err)
        onError?.(`[Binance] 消息解析失败: ${stream}`)
        return // 脏消息直接丢弃，不影响后续消息
      }
      // 统一数据结构：币安 kline 事件 → 项目内部 Kline（附 symbol / isFinal）。
      // 注意：原始 data.k.t 为毫秒时间戳，这里换算为秒以匹配全项目 Kline 模型（前端按秒渲染）。
      const k = data.k
      try {
        onKline({
          symbol: String(data.s),
          time: Number(k.t) / 1000,
          open: Number(k.o),
          high: Number(k.h),
          low: Number(k.l),
          close: Number(k.c),
          volume: Number(k.v),
          isFinal: Boolean(k.x),
        })
      } catch (err) {
        logger.error(`[Binance] onKline 回调异常: ${stream}`, err)
      }
    }, onError)
  }

  /**
   * 订阅逐笔成交（aggTrade 流）。返回取消订阅函数。
   * m=true 表示买方为 maker → 主动方为卖方 → Sell。
   */
  subscribeTick(symbol: string, onTick: (data: TradeData) => void, onError?: (message: string) => void): () => void {
    const stream = `${symbol.toLowerCase()}@aggTrade`
    return this.connectStream(stream, (raw) => {
      let data: { s: string; p: string | number; q: string | number; T: string | number; m: boolean }
      try {
        data = JSON.parse(raw.toString())
      } catch (err) {
        logger.error(`[Binance] 消息解析失败: ${stream}`, err)
        onError?.(`[Binance] 消息解析失败: ${stream}`)
        return
      }
      try {
        onTick({
          symbol: String(data.s),
          price: Number(data.p),
          size: Number(data.q),
          side: data.m ? 'Sell' : 'Buy',
          timestamp: Number(data.T),
        })
      } catch (err) {
        logger.error(`[Binance] onTick 回调异常: ${stream}`, err)
      }
    }, onError)
  }

  /**
   * 建立一条带心跳与断线自动重连的 WS 流订阅。
   * - 心跳：每 20s ping 一次，下一轮未收到 pong 则判死并强制重连；
   * - 重连：指数退避 1s→30s + 随机抖动，避免集中重连；
   * - 无数据看门狗：连接后 10s 内未收到任何消息则告警。
   */
  private connectStream(
    stream: string,
    onMessage: (raw: WebSocket.RawData) => void,
    onError?: (message: string) => void,
  ): () => void {
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
        lastMessageAt = Date.now()
        logger.info(`[Binance] WS 已连接: ${stream}`)
        // 无数据看门狗：连接后 10s 内未收到任何消息则告警（典型场景：代理节点被币安静默断流，连接正常但无数据）
        setTimeout(() => {
          if (stopped) return
          if (Date.now() - lastMessageAt > 10_000) {
            logger.warn(`[Binance] 已连接但 10s 内未收到数据，请检查代理节点/网络/数据源: ${stream}`)
          }
        }, 10_000)
        // 心跳：每 20s ping 一次；下一轮仍未收到 pong 则判死并强制重连
        pingTimer = setInterval(() => {
          if (!socket) return
          if (!isAlive) {
            logger.warn(`[Binance] 心跳超时，强制断开: ${stream}`)
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
        onMessage(raw)
      })

      socket.on('error', (err) => {
        logger.error(`[Binance] WS 错误: ${stream}`, err)
        onError?.(`[Binance] WS 错误: ${stream}`)
      })

      socket.on('close', () => {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
        if (stopped) return
        // 指数退避重连：1s,2s,4s...最大 30s，加随机抖动避免集中重连
        const delay = Math.min(1000 * 2 ** retries, 30_000) + Math.floor(Math.random() * 500)
        retries += 1
        logger.warn(`[Binance] WS 断开，${(delay / 1000).toFixed(1)}s 后重连: ${stream}`)
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
