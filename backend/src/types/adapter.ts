import type { Interval, Kline } from './kline'
import type { DomData, QuoteData, Ticker, TradeData } from './market'

/** 交易对/合约基本信息（前端搜索列表用） */
export interface SymbolInfo {
  symbol: string
  baseAsset: string
  quoteAsset: string
}

export interface MarketAdapter {
  getKlines(symbol: string, interval: Interval, limit: number): Promise<Kline[]>
  getTicker(symbol: string): Promise<Ticker>
  /**
   * 订阅 K 线增量。
   * @param onKline 单根增量 K 线（未收盘反复推送同一根，前端按 time 去重）
   * @param onHist 全量历史批量（Tradovate hist 等；可选，前端应整表替换）
   * @param onError 订阅/上游异常回调（可选）
   */
  subscribe(
    symbol: string,
    interval: Interval,
    onKline: (kline: Kline) => void,
    onHist?: (klines: Kline[]) => void,
    onError?: (message: string) => void,
  ): () => void
  /** 实时报价流（可选，Tradovate 等数据源支持） */
  subscribeQuote?(symbol: string, onQuote: (data: QuoteData) => void, onError?: (message: string) => void): () => void
  /** 盘口订单簿流（可选） */
  subscribeDOM?(symbol: string, onDom: (data: DomData) => void, onError?: (message: string) => void): () => void
  /** 逐笔成交流（可选） */
  subscribeTick?(symbol: string, onTick: (data: TradeData) => void, onError?: (message: string) => void): () => void
}

/** 支持交易对/合约列表与批量行情的适配器（当前两个数据源均实现） */
export interface MarketDataAdapter extends MarketAdapter {
  getSymbols(): Promise<SymbolInfo[]>
  getAllTickers(): Promise<Ticker[]>
  /** 连通性预检（Tradovate 鉴权校验；可选） */
  ping?(): Promise<void>
}
