export type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
/** 数据源：binance（默认）/ tradovate（美股指/期货） */
export type DataSource = 'binance' | 'tradovate'
/** 图表视图：K 线 / 盘口订单簿 / Tick 流 */
export type MarketView = 'candlestick' | 'dom' | 'tick'
export interface Kline { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface Ticker { symbol: string; price: number; change24h: number; volume24h: number; updatedAt: number }
export interface SymbolInfo { symbol: string; baseAsset: string; quoteAsset: string }
/** 搜索列表行：合并交易对基本信息、数据源标记与实时行情 */
export interface SymbolRow extends SymbolInfo { source: string; price: number; change24h: number; volume24h: number }

/** 标准化实时报价（Tradovate quote 流清洗后） */
export interface Quote { symbol: string; bid: number | null; ask: number | null; last: number | null; size: number; timestamp: number }
/** 盘口档位 */
export interface DomLevel { price: number; size: number; side: 'Bid' | 'Ask' }
/** 标准化盘口订单簿（Tradovate DOM 流清洗后） */
export interface Dom { symbol: string; levels: DomLevel[]; timestamp: number }
/** 标准化逐笔成交（Tradovate Trade/Quote 流清洗后） */
export interface TradeTick { symbol: string; price: number; size: number; side: 'Buy' | 'Sell' | ''; timestamp: number }
