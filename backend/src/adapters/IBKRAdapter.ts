import { BaseAdapter } from './BaseAdapter'
import { IBKRClient, IBKR_CME_SYMBOLS } from '../services/IBKRClient'
import type { MarketDataAdapter, SymbolInfo } from '../types/adapter'
import type { Interval, Kline } from '../types/kline'
import type { Ticker } from '../types/market'
import type { TickerMessage } from '../types/market'
import { logger } from '../utils/logger'

/**
 * IBKR（盈透证券）数据源适配器。
 *
 * 内部管理 IBKRClient 实例，将 IBKR 的行情统一转换为项目通用格式：
 * - tickPrice / tickSize / tickByTickAllLast → { type: 'ticker', source: 'IBKR', symbol, price, size, timestamp }
 * - reqHistoricalData 历史 K 线 → Kline[]（REST / WS 全量快照）
 * - reqRealTimeBars 实时 K 线 → { symbol, time, open, high, low, close, volume }（WS 增量广播）
 *
 * 通过 subscribeTick / subscribeBar 注册的回调实时输出（供 WebSocketServer 广播给前端）。
 * 延迟行情（MarketDataType.DELAYED）免费可用，未付费订阅也能获取测试数据。
 */
export class IBKRAdapter extends BaseAdapter implements MarketDataAdapter {
  private readonly client = new IBKRClient()

  /** 连通性预检：等待 IB Gateway / TWS 连接就绪。 */
  ping(): Promise<void> {
    return this.client.waitForConnection()
  }

  getSymbols(): Promise<SymbolInfo[]> {
    return Promise.resolve(IBKR_CME_SYMBOLS.map((s) => ({
      symbol: s.symbol,
      baseAsset: s.symbol,
      quoteAsset: 'USD',
      name: s.name,
      exchange: s.exchange,
      secType: s.secType,
    })))
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const tick = this.client.getLast(symbol)
    return { symbol, price: tick?.price ?? 0, change24h: 0, volume24h: 0, updatedAt: tick?.timestamp ?? Date.now() }
  }

  async getAllTickers(): Promise<Ticker[]> {
    return IBKR_CME_SYMBOLS.map((s) => {
      const tick = this.client.getLast(s.symbol)
      return { symbol: s.symbol, price: tick?.price ?? 0, change24h: 0, volume24h: 0, updatedAt: tick?.timestamp ?? Date.now() }
    })
  }

  async getKlines(symbol: string, interval: Interval, limit = 300, endDateTime?: number): Promise<Kline[]> {
    // reqHistoricalData：合约参数（Symbol/SecType/Exchange/Currency）由 IBKRClient.CONTRACTS 统一维护；
    // 内置默认超时（15s），防止前端无限等待。endDateTime 用于分页拉取更早数据。
    return this.client.getHistoricalKlines(symbol, interval, limit, undefined, endDateTime)
  }

  /**
   * K 线订阅（与 URL 参数流的 kline 协议兼容）：
   * - onHist：reqHistoricalData 一次性全量历史（300 根）；
   * - onKline：reqRealTimeBars 实时增量（TWS 固定 5 秒 bar，延迟行情账户可能被拒，仅提示）。
   */
  subscribe(
    symbol: string,
    interval: Interval,
    onKline: (kline: Kline) => void,
    onHist?: (klines: Kline[]) => void,
    onError?: (message: string) => void,
  ): () => void {
    // 全量历史快照（内置超时，失败仅回调 onError）
    void this.getKlines(symbol, interval, 300)
      .then((rows) => onHist?.(rows))
      .catch((err) => onError?.(err instanceof Error ? err.message : String(err)))
    // 实时增量（subscribeBar 为异步，内部先解析合约）
    let cancel: (() => void) | null = null
    void this.subscribeBar(symbol, interval, onKline, onError).then((unsub) => { cancel = unsub })
    return () => cancel?.()
  }

  /**
   * 订阅 tick 行情：内部对 symbol 建立 IBKR 行情订阅，
   * 将统一格式的 TickerMessage 实时回调给调用方（WebSocketServer）。
   */
  async subscribeTick(
    symbol: string,
    onTick: (data: TickerMessage) => void,
    onError?: (message: string) => void,
  ): Promise<() => void> {
    let disposed = false
    let unsubscribeClient: (() => void) | null = null
    try {
      // 内部先解析真实近月合约（reqContractDetails），再 reqMktData / reqTickByTickData
      unsubscribeClient = await this.client.subscribeMarketData(symbol)
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err))
      return () => {}
    }
    const unsubscribeListener = this.client.onTick((tick) => {
      if (disposed || tick.symbol !== symbol) return
      onTick({ type: 'ticker', source: 'IBKR', ...tick })
    })
    return () => {
      disposed = true
      unsubscribeListener()
      unsubscribeClient?.()
    }
  }

  /**
   * 订阅实时 K 线：底层调用 reqRealTimeBars（TWS 固定 5 秒 bar），
   * 将 { symbol, time, open, high, low, close, volume } 标准化为 Kline 回调给调用方（WebSocketServer）。
   */
  async subscribeBar(
    symbol: string,
    _interval: Interval,
    onKline: (kline: Kline) => void,
    onError?: (message: string) => void,
  ): Promise<() => void> {
    let disposed = false
    let unsubscribeClient: (() => void) | null = null
    try {
      // 内部先解析真实近月合约，再 reqMktData + reqRealTimeBars（TWS 固定 5 秒 bar）
      unsubscribeClient = await this.client.subscribeMarketData(symbol)
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err))
      return () => {}
    }
    const unsubscribeListener = this.client.onRealtimeBar((bar) => {
      if (disposed || bar.symbol !== symbol) return
      onKline({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume })
    })
    return () => {
      disposed = true
      unsubscribeListener()
      unsubscribeClient?.()
    }
  }

  /** 监听底层 IB Gateway / TWS 连接状态（供 WebSocketServer 广播给客户端）。 */
  onStatus(listener: (connected: boolean, error?: Error) => void): () => void {
    return this.client.onStatus(listener)
  }

  /** 关闭底层连接（进程退出时调用）。 */
  close(): void {
    this.client.close()
  }
}
