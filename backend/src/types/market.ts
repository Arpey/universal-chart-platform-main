export interface Ticker { symbol: string; price: number; change24h: number; volume24h: number; updatedAt: number }

/** 标准化实时报价（Tradovate quote 流清洗后） */
export interface QuoteData {
  symbol: string
  bid: number | null
  ask: number | null
  last: number | null
  size: number
  timestamp: number
}

/** 盘口档位 */
export interface DomLevel {
  price: number
  size: number
  side: 'Bid' | 'Ask'
}

/** 标准化盘口订单簿（Tradovate DOM 流清洗后，含完整一档至多档快照） */
export interface DomData {
  symbol: string
  levels: DomLevel[]
  timestamp: number
}

/** 标准化逐笔成交（Tradovate Trade/Quote 流清洗后） */
export interface TradeData {
  symbol: string
  price: number
  size: number
  side: 'Buy' | 'Sell' | ''
  timestamp: number
}
