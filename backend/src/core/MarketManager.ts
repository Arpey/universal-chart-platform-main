import { DataSourceDriver } from '../datasources/DataSourceDriver'
import type { MarketDataAdapter } from '../types/adapter'
import type { Interval } from '../types/kline'

export type DataSource = 'binance' | 'tradovate' | 'tradefi'

export class MarketManager {
  /** 按数据源名解析适配器（binance 为默认；tradefi 为白名单过滤的币安合约；tradovate 需 TRADOVATE_* 配置）。 */
  resolve(source: string): MarketDataAdapter {
    return DataSourceDriver.getAdapter(source)
  }

  async snapshot(symbol: string, interval: Interval, limit: number, source = 'binance') {
    const adapter = this.resolve(source)
    return { klines: await adapter.getKlines(symbol, interval, limit), ticker: await adapter.getTicker(symbol) }
  }
  symbols(source = 'binance') { return this.resolve(source).getSymbols() }
  allTickers(source = 'binance') { return this.resolve(source).getAllTickers() }
}

