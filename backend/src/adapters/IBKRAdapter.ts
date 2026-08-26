import { BaseAdapter } from './BaseAdapter'
import { IBKRClient, IBKR_SYMBOLS } from '../services/IBKRClient'
import type { MarketDataAdapter, SymbolInfo } from '../types/adapter'
import type { Interval, Kline } from '../types/kline'
import type { Ticker } from '../types/market'
import type { TickerMessage } from '../types/market'
import { logger } from '../utils/logger'

/**
 * IBKR（盈透证券）数据源适配器。
 *
 * 内部管理 IBKRClient 实例，将 IBKR 的 tickPrice / tickSize / tickByTickAllLast 行情
 * 统一转换为项目通用格式：
 *   { type: 'ticker', source: 'IBKR', symbol, price, size, timestamp }
 * 并通过 subscribeTick 注册的回调实时输出（供 WebSocketServer 广播给前端）。
 *
 * 当前仅支持 tick 实时行情（延迟数据免费），K 线订阅暂不支持。
 */
export class IBKRAdapter extends BaseAdapter implements MarketDataAdapter {
  private readonly client = new IBKRClient()

  /** 连通性预检：等待 IB Gateway / TWS 连接就绪。 */
  ping(): Promise<void> {
    return this.client.waitForConnection()
  }

  getSymbols(): Promise<SymbolInfo[]> {
    return Promise.resolve(IBKR_SYMBOLS.map((symbol) => ({ symbol, baseAsset: symbol, quoteAsset: 'USD' })))
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const tick = this.client.getLast(symbol)
    return { symbol, price: tick?.price ?? 0, change24h: 0, volume24h: 0, updatedAt: tick?.timestamp ?? Date.now() }
  }

  async getAllTickers(): Promise<Ticker[]> {
    return IBKR_SYMBOLS.map((symbol) => {
      const tick = this.client.getLast(symbol)
      return { symbol, price: tick?.price ?? 0, change24h: 0, volume24h: 0, updatedAt: tick?.timestamp ?? Date.now() }
    })
  }

  async getKlines(_symbol: string, _interval: Interval, _limit: number): Promise<Kline[]> {
    logger.warn('[IBKR] 暂不支持 K 线订阅（仅提供 tick 实时行情）')
    return []
  }

  subscribe(
    _symbol: string,
    _interval: Interval,
    _onKline: (kline: Kline) => void,
    _onHist?: (klines: Kline[]) => void,
    onError?: (message: string) => void,
  ): () => void {
    onError?.('IBKR 数据源暂不支持 K 线订阅，请使用 tick 行情')
    return () => {}
  }

  /**
   * 订阅 tick 行情：内部对 symbol 建立 IBKR 行情订阅，
   * 将统一格式的 TickerMessage 实时回调给调用方（WebSocketServer）。
   */
  subscribeTick(
    symbol: string,
    onTick: (data: TickerMessage) => void,
    onError?: (message: string) => void,
  ): () => void {
    let disposed = false
    let unsubscribeClient: (() => void) | null = null
    try {
      unsubscribeClient = this.client.subscribeMarketData(symbol)
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

  /** 关闭底层连接（进程退出时调用）。 */
  close(): void {
    this.client.close()
  }
}
