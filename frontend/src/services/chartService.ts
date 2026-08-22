import type { Interval, Kline, SymbolInfo, Ticker } from '../types'
const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'
export async function fetchMarket(symbol: string, interval: Interval) {
  const response = await fetch(`${apiUrl}/api/market?symbol=${symbol}&interval=${interval}&limit=300`)
  if (!response.ok) throw new Error('行情服务暂不可用')
  return await response.json() as { klines: Kline[]; ticker: Ticker }
}
export async function fetchSymbols() {
  const response = await fetch(`${apiUrl}/api/symbols`)
  if (!response.ok) throw new Error('交易对列表不可用')
  return await response.json() as SymbolInfo[]
}
export async function fetchTickers() {
  const response = await fetch(`${apiUrl}/api/tickers`)
  if (!response.ok) throw new Error('行情快照不可用')
  return await response.json() as Ticker[]
}
