export type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
export interface Kline { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface Ticker { symbol: string; price: number; change24h: number; volume24h: number; updatedAt: number }
export interface SymbolInfo { symbol: string; baseAsset: string; quoteAsset: string }
/** 搜索列表行：合并交易对基本信息、数据源标记与实时行情 */
export interface SymbolRow extends SymbolInfo { source: string; price: number; change24h: number; volume24h: number }
