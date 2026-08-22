import type { MarketAdapter } from '../types/adapter'

export abstract class BaseAdapter implements MarketAdapter {
  abstract getKlines(symbol: string, interval: any, limit: number): Promise<any[]>
  abstract getTicker(symbol: string): Promise<any>
  abstract subscribe(symbol: string, interval: any, onKline: (kline: any) => void): () => void
}
