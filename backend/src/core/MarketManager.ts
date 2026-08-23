import { BinanceFuturesAdapter } from '../adapters/BinanceFuturesAdapter'
import { TradovateAdapter } from '../adapters/TradovateAdapter'
import type { MarketDataAdapter } from '../types/adapter'
import type { Interval } from '../types/kline'
import { config } from '../utils/config'

export type DataSource = 'binance' | 'tradovate'

export class MarketManager {
  readonly binance = new BinanceFuturesAdapter()
  readonly tradovate = config.tradovate.enabled ? new TradovateAdapter() : null

  /** 按数据源名解析适配器（binance 为默认）。 */
  resolve(source: string): MarketDataAdapter {
    if (source === 'tradovate') {
      if (!this.tradovate) throw new Error('Tradovate 数据源未配置（请检查 TRADOVATE_* 环境变量）')
      return this.tradovate
    }
    return this.binance
  }

  async snapshot(symbol: string, interval: Interval, limit: number, source = 'binance') {
    const adapter = this.resolve(source)
    return { klines: await adapter.getKlines(symbol, interval, limit), ticker: await adapter.getTicker(symbol) }
  }
  symbols(source = 'binance') { return this.resolve(source).getSymbols() }
  allTickers(source = 'binance') { return this.resolve(source).getAllTickers() }
}

