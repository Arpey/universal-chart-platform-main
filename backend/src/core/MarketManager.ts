import { BinanceFuturesAdapter } from '../adapters/BinanceFuturesAdapter'
import type { Interval } from '../types/kline'

export class MarketManager {
  readonly adapter = new BinanceFuturesAdapter()
  async snapshot(symbol: string, interval: Interval, limit: number) {
    return { klines: await this.adapter.getKlines(symbol, interval, limit), ticker: await this.adapter.getTicker(symbol) }
  }
  symbols() { return this.adapter.getSymbols() }
  allTickers() { return this.adapter.getAllTickers() }
}
