import WebSocket from 'ws'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { BaseAdapter } from './BaseAdapter'
import type { Interval, Kline } from '../types/kline'
import type { Ticker } from '../types/market'
import { config } from '../utils/config'

export class BinanceAdapter extends BaseAdapter {
  private readonly dispatcher = new ProxyAgent(config.proxy)

  async getKlines(symbol: string, interval: Interval, limit = 300): Promise<Kline[]> {
    const url = `${config.binanceBaseUrl}/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`
    const response = await undiciFetch(url, { dispatcher: this.dispatcher })
    if (!response.ok) throw new Error(`Binance request failed: ${response.status}`)
    const rows = await response.json() as unknown[][]
    return rows.map((row) => ({ time: Number(row[0]) / 1000, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) }))
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const url = `${config.binanceBaseUrl}/api/v3/ticker/24hr?symbol=${symbol.toUpperCase()}`
    const response = await undiciFetch(url, { dispatcher: this.dispatcher })
    if (!response.ok) throw new Error(`Binance request failed: ${response.status}`)
    const data = await response.json() as Record<string, string>
    return { symbol: data.symbol, price: Number(data.lastPrice), change24h: Number(data.priceChangePercent), volume24h: Number(data.quoteVolume), updatedAt: Date.now() }
  }

  subscribe(symbol: string, interval: Interval, onKline: (kline: Kline) => void): () => void {
    const socket = new WebSocket(`${config.binanceWsUrl}/${symbol.toLowerCase()}@kline_${interval}`, {
      agent: new HttpsProxyAgent(config.proxy)
    })
    socket.on('message', (raw) => {
      const data = JSON.parse(raw.toString()) as { k: Record<string, string | number> }
      const k = data.k
      onKline({ time: Number(k.t) / 1000, open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c), volume: Number(k.v) })
    })
    return () => socket.close()
  }
}
