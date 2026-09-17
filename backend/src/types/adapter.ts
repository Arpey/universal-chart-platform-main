import type { Interval, Kline, KlineSeed } from './kline'
import type { DomData, QuoteData, Ticker, TickerMessage, TradeData } from './market'

/** 交易对/合约基本信息（前端搜索列表用） */
export interface SymbolInfo {
  symbol: string
  baseAsset: string
  quoteAsset: string
  /** 合约全名（IBKR CME 期货等数据源提供，如 "Micro E-mini S&P 500"） */
  name?: string
  /** 交易所（IBKR 等数据源提供，如 CME / CBOT / COMEX / NYMEX） */
  exchange?: string
  /** 证券类型（IBKR 等数据源提供，如 FUT） */
  secType?: string
}

export interface MarketAdapter {
  getKlines(symbol: string, interval: Interval, limit: number, endDateTime?: number): Promise<Kline[]>
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
  /** 逐笔成交流（可选，IBKR 需先解析合约故为异步） */
  subscribeTick?(symbol: string, onTick: (data: TradeData | TickerMessage) => void, onError?: (message: string) => void): (() => void) | Promise<() => void>
  /**
   * 实时 K 线流（可选，IBKR reqRealTimeBars → { symbol, time, open, high, low, close, volume }）。
   * 实现方负责把上游数据（5 秒实时 bar / 逐笔）聚合为 `interval` 周期的 K 线：
   * 时间戳统一为 10 位 Unix 秒并按周期向下取整对齐。
   * @param seed 历史最后一根 K 线（可为异步 Promise）：与实时首根同周期时续接而非覆盖。
   */
  subscribeBar?(symbol: string, interval: Interval, onKline: (kline: Kline) => void, onError?: (message: string) => void, seed?: KlineSeed): (() => void) | Promise<() => void>
}

/** 支持交易对/合约列表与批量行情的适配器（当前两个数据源均实现） */
export interface MarketDataAdapter extends MarketAdapter {
  getSymbols(): Promise<SymbolInfo[]>
  getAllTickers(): Promise<Ticker[]>
  /**
   * 历史 K 线（REST 预加载：前端切换 symbol / interval 时先铺满最近 limit 根，再衔接实时流）。
   * 统一契约：10 位 Unix 秒、按周期网格对齐、按 time 升序、同 time 去重（保留最后一条）、
   * 只返回最近 limit 根；默认 limit = HISTORY_BAR_LIMIT（100）。
   * @param endTime 分页边界（10 位 Unix 秒，可选）：只返回严格早于该时间的最近 limit 根（向左翻页）。
   * 不支持历史的数据源实现为「返回空数组 + warn」，前端需容错（此时仅显示实时数据）。
   */
  fetchHistoricalBars?(symbol: string, interval: Interval, limit: number, endTime?: number): Promise<Kline[]>
  /** 连通性预检（Tradovate 鉴权校验；可选） */
  ping?(): Promise<void>
  /** 底层连接状态订阅（可选，IBKR 断线/重连时广播给 WebSocket 客户端） */
  onStatus?(listener: (connected: boolean, error?: Error) => void): () => void
  /**
   * 行情类型变更订阅（可选，IBKR：1=实时 2=冻结 3=延迟 4=延迟冻结）。
   * 用于前端展示「实时行情 / 延迟行情」，避免用户把延迟数据误判为断流。
   */
  onMarketDataType?(listener: (marketDataType: number) => void): () => void
  /** 当前生效的行情类型（可选，IBKR：1=实时 3=延迟；尚未收到 IB 通知时为 null） */
  getMarketDataType?(): number | null
}
