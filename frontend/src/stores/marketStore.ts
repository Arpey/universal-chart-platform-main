import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { DataSource, Dom, Interval, Kline, MarketView, Quote, Source, SymbolInfo, Ticker, TradeTick } from '../types'
import { fetchMarket, fetchSymbols, fetchTickers } from '../services/chartService'

const DEFAULT_SYMBOL: Record<DataSource, string> = { binance: 'BTCUSDT', tradovate: 'NQ', tradefi: 'XAUUSDT', ibkr: 'MES' }

export const useMarketStore = defineStore('market', () => {
  const datasource = ref<DataSource>('binance')
  /** 当前分类：全部合约 / Tradefi（与 datasource 保持同步，tradovate 不在分类内）。 */
  const currentSource = ref<Source>('binance')
  const view = ref<MarketView>('candlestick')
  const symbol = ref(DEFAULT_SYMBOL.binance); const interval = ref<Interval>('1m'); const klines = ref<Kline[]>([]); const ticker = ref<Ticker>(); const loading = ref(false); const error = ref('')
  const symbols = ref<SymbolInfo[]>([]); const tickers = ref<Ticker[]>([]); const universeLoading = ref(false); const universeError = ref('')
  // Tradovate 实时流：报价 / 盘口 / 逐笔
  const quote = ref<Quote>()
  const dom = ref<Dom>()
  const trades = ref<TradeTick[]>([])
  const domConnected = ref(false)
  /** 最近一次收到行情数据的时间戳（epoch ms）：用于判断当前是否处于"已连接但无新行情"的休市/低流动性静默期。 */
  const lastDataAt = ref(0)

  async function load() {
    loading.value = true; error.value = ''
    try {
      const result = await fetchMarket(symbol.value, interval.value, datasource.value)
      klines.value = result.klines
      ticker.value = result.ticker
    } catch (e) { error.value = e instanceof Error ? e.message : '加载失败' } finally { loading.value = false }
  }

  /** 拉取交易对列表 + 24h 行情快照（供搜索列表展示）。任一失败都清空该侧并记录错误。 */
  async function loadUniverse() {
    universeLoading.value = true; universeError.value = ''
    // IBKR：标的列表由 WebSocket 消息驱动（get_symbols）提供，不走 HTTP universe 接口
    if (datasource.value === 'ibkr') {
      universeLoading.value = false
      return
    }
    try {
      // 两个接口相互独立：tickers 失败不影响 symbols 列表展示
      const [s, t] = await Promise.allSettled([fetchSymbols(datasource.value), fetchTickers(datasource.value)])
      if (s.status === 'fulfilled') {
        symbols.value = s.value
      } else {
        // 失败时清空旧列表，避免残留上一数据源的标的
        symbols.value = []
        universeError.value = s.reason instanceof Error ? s.reason.message : '标的列表加载失败'
      }
      if (t.status === 'fulfilled') tickers.value = t.value
      else tickers.value = []
    } catch (e) { universeError.value = e instanceof Error ? e.message : '列表加载失败' }
    finally { universeLoading.value = false }
  }

  /** 数据源分类选项：全部合约 / Tradefi。 */
  const availableSources = computed<Array<{ id: Source; label: string }>>(() => [
    { id: 'binance', label: '全部合约' },
    { id: 'tradefi', label: 'Tradefi' },
  ])

  /** 切换分类（全部合约 / Tradefi），映射到底层 datasource 并刷新列表与 K 线。 */
  function switchSource(next: Source) {
    if (currentSource.value === next && datasource.value === next) return
    currentSource.value = next
    setDatasource(next === 'tradefi' ? 'tradefi' : 'binance')
  }

  /** 切换数据源（同时重置标的为各源默认合约并重新加载列表）。 */
  function setDatasource(next: DataSource) {
    if (datasource.value === next) return
    datasource.value = next
    // 分类与底层数据源保持同步（tradovate / ibkr 不在分类切换器内，保持当前分类不变）
    if (next === 'tradefi') currentSource.value = 'tradefi'
    else if (next === 'binance') currentSource.value = 'binance'
    symbol.value = DEFAULT_SYMBOL[next]
    // 数据源切换后清空全部跨源数据，避免残留上一数据源的列表/行情
    klines.value = []
    ticker.value = undefined
    quote.value = undefined
    dom.value = undefined
    trades.value = []
    symbols.value = []
    tickers.value = []
    universeError.value = ''
    // IBKR 同时支持历史/实时 K 线与逐笔 tick，保留当前视图（不再强制切到 Tick）
    if (next !== 'tradovate' && view.value !== 'candlestick') view.value = 'candlestick'
    void loadUniverse()
  }

  /** 接收 IBKR 消息驱动的 CME 期货标的列表（get_symbols 响应），归一化到 SymbolInfo。 */
  function applySymbols(list: Array<{ symbol: string; name?: string; exchange?: string; secType?: string }>) {
    if (!Array.isArray(list)) return
    symbols.value = list.map((s) => ({
      symbol: s.symbol,
      baseAsset: s.symbol,
      quoteAsset: 'USD',
      name: s.name,
      exchange: s.exchange,
      secType: s.secType,
    }))
    // IBKR 标的无 24h 行情快照：清空 tickers，避免残留上一数据源行情
    tickers.value = []
    universeError.value = ''
    universeLoading.value = false
  }

  /** 切换图表视图（K 线 / 盘口 / Tick 流）。 */
  function setView(next: MarketView) {
    if (view.value === next) return
    view.value = next
    // 切换视图时清空旧的实时流数据，等待重新订阅
    dom.value = undefined
    trades.value = []
  }

  /** 切换交易对（由搜索列表触发）。 */
  function setSymbol(next: string) { symbol.value = next }

  /**
   * 切换标的/周期/数据源前清空旧标的全部行情快照（K 线、价格、盘口、逐笔），
   * 避免新数据到达前图表 / 顶栏价格 / 倒计时锚点继续沿用旧标的坐标与数值。
   */
  function clearMarketData() {
    klines.value = []
    ticker.value = undefined
    quote.value = undefined
    dom.value = undefined
    trades.value = []
    lastDataAt.value = 0
  }

  function update(kline: Kline) {
    if (!kline || typeof kline.time !== 'number') return
    lastDataAt.value = Date.now()
    const last = klines.value.at(-1)
    if (last?.time === kline.time) klines.value[klines.value.length - 1] = kline
    else klines.value.push(kline)
    if (klines.value.length > 500) klines.value.shift()
    if (ticker.value) ticker.value = { ...ticker.value, price: kline.close, updatedAt: Date.now() }
  }

  /**
   * 全量历史批量（append=false 整表替换；append=true 追加更早分页数据）。
   * 无论哪种模式都按 time 去重 + 升序，保证 setData 的有序性。
   */
  function applyHist(rows: Kline[], append = false) {
    if (!Array.isArray(rows)) return
    lastDataAt.value = Date.now()
    const seen = new Map<number, Kline>()
    const source = append ? klines.value : []
    for (const k of source) {
      if (k && typeof k.time === 'number' && Number.isFinite(k.time)) seen.set(k.time, k)
    }
    for (const k of rows) {
      if (k && typeof k.time === 'number' && Number.isFinite(k.time)) seen.set(k.time, k)
    }
    klines.value = [...seen.values()].sort((a, b) => a.time - b.time)
    const last = klines.value.at(-1)
    if (last && ticker.value) ticker.value = { ...ticker.value, price: last.close, updatedAt: Date.now() }
  }

  function setQuote(q: Quote) {
    if (!q) return
    quote.value = q
    const price = q.last ?? (q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : null)
    if (price != null) setPrice(price)
  }

  function setDom(d: Dom) {
    if (!d) return
    dom.value = d
    domConnected.value = true
    // 盘口更新时用买卖一档中间价刷新顶部价格
    const bids = d.levels.filter((l) => l.side === 'Bid').sort((a, b) => b.price - a.price)
    const asks = d.levels.filter((l) => l.side === 'Ask').sort((a, b) => a.price - b.price)
    const bestBid = bids[0]?.price
    const bestAsk = asks[0]?.price
    if (bestBid != null && bestAsk != null) setPrice((bestBid + bestAsk) / 2)
  }

  function addTrade(t: TradeTick) {
    if (!t || typeof t.price !== 'number') return
    trades.value.unshift(t)
    if (trades.value.length > 200) trades.value.length = 200
    setPrice(t.price)
  }

  /** 更新顶部最新价（实时流驱动）。 */
  function setPrice(price: number) {
    if (!Number.isFinite(price) || price <= 0) return
    lastDataAt.value = Date.now()
    const base = ticker.value ?? { symbol: symbol.value, change24h: 0, volume24h: 0, updatedAt: Date.now() }
    ticker.value = { ...base, price, updatedAt: Date.now() }
  }

  return {
    datasource, currentSource, availableSources, view, symbol, interval, klines, ticker, loading, error,
    symbols, tickers, universeLoading, universeError,
    quote, dom, trades, domConnected, lastDataAt,
    load, loadUniverse, setDatasource, switchSource, setView, setSymbol,
    update, applyHist, setQuote, setDom, addTrade, setPrice,
    applySymbols,
    clearMarketData,
  }
})
