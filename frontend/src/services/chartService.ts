import type { DataSource, Dom, Interval, Kline, Quote, SymbolInfo, Ticker, TradeTick } from '../types'
import { HISTORY_BAR_LIMIT_RESOLVED } from '../constants/intervals'
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

/** 历史 K 线分页响应：bars 为最近 limit 根（升序、去重），hasMore 表示可能还有更早的数据。 */
export interface KlineHistoryPage {
  bars: Kline[]
  hasMore: boolean
}

/**
 * 历史 K 线（切换 symbol / interval 时预加载最近 limit 根；渲染完成后再建立实时订阅）。
 * 后端契约：10 位 Unix 秒、按周期网格对齐、time 严格升序、同 time 去重（保留最后一条）、最多 limit 根。
 * @param endTime 分页边界（10 位 Unix 秒，可选）：只返回**严格早于**该时间的最近 limit 根（向左翻页）。
 */
export async function fetchKlineHistory(
  symbol: string,
  interval: Interval,
  source: DataSource = 'binance',
  limit: number = HISTORY_BAR_LIMIT_RESOLVED,
  endTime?: number,
): Promise<KlineHistoryPage> {
  const query = new URLSearchParams({ symbol, interval, limit: String(limit), source })
  if (typeof endTime === 'number' && Number.isFinite(endTime) && endTime > 0) query.set('endTime', String(Math.floor(endTime)))
  const response = await fetch(`${apiUrl}/api/kline/history?${query.toString()}`)
  if (!response.ok) throw await toError(response, '历史 K 线加载失败')
  const body = await response.json() as { bars?: Kline[]; hasMore?: boolean }
  const bars = Array.isArray(body?.bars) ? body.bars : []
  // hasMore：优先用后端字段；后端未提供时按「取满 limit 根」推断（数据源不支持历史 → 空数组 → false）
  const hasMore = typeof body?.hasMore === 'boolean' ? body.hasMore : bars.length >= limit
  return { bars, hasMore }
}

/** 单个标的行情快照（只取最新价；切品种后刷新顶栏，不额外消耗历史请求配额）。 */
export async function fetchTicker(symbol: string, source: DataSource = 'binance'): Promise<Ticker> {
  const query = new URLSearchParams({ symbol, source })
  const response = await fetch(`${apiUrl}/api/ticker?${query.toString()}`)
  if (!response.ok) throw await toError(response, '行情快照不可用')
  return await response.json() as Ticker
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
