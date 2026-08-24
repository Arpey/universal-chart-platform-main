import type { DataSource, Dom, Interval, Kline, Quote, SymbolInfo, Ticker, TradeTick } from '../types'
const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'

/** 非 2xx 时优先提取后端返回的 message（如 Tradovate 鉴权/未配置错误），否则用兜底文案。 */
async function toError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = await response.json() as { message?: string }
    if (body?.message) return new Error(body.message)
  } catch { /* 非 JSON 响应 */ }
  return new Error(fallback)
}

export async function fetchMarket(symbol: string, interval: Interval, source: DataSource = 'binance') {
  const response = await fetch(`${apiUrl}/api/market?symbol=${symbol}&interval=${interval}&limit=300&source=${source}`)
  if (!response.ok) throw await toError(response, '行情服务暂不可用')
  return await response.json() as { klines: Kline[]; ticker: Ticker }
}
export async function fetchSymbols(source: DataSource = 'binance') {
  const response = await fetch(`${apiUrl}/api/symbols?source=${source}`)
  if (!response.ok) throw await toError(response, '交易对列表不可用')
  return await response.json() as SymbolInfo[]
}
export async function fetchTickers(source: DataSource = 'binance') {
  const response = await fetch(`${apiUrl}/api/tickers?source=${source}`)
  if (!response.ok) throw await toError(response, '行情快照不可用')
  return await response.json() as Ticker[]
}
export interface WsIncoming {
  type: 'kline' | 'hist' | 'quote' | 'dom' | 'tick' | 'connected' | 'error'
  data?: Kline | Kline[] | Quote | Dom | TradeTick
  message?: string
  symbol?: string
  interval?: string
}
