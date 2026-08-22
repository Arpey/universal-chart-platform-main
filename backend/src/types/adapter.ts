import type { Interval, Kline } from './kline'
import type { Ticker } from './market'

export interface MarketAdapter {
  getKlines(symbol: string, interval: Interval, limit: number): Promise<Kline[]>
  getTicker(symbol: string): Promise<Ticker>
  subscribe(symbol: string, interval: Interval, onKline: (kline: Kline) => void): () => void
}
