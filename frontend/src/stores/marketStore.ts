import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { DataSource, Dom, Interval, Kline, MarketView, Quote, SymbolInfo, Ticker, TradeTick } from '../types'
import { fetchMarket, fetchSymbols, fetchTickers } from '../services/chartService'

const DEFAULT_SYMBOL: Record<DataSource, string> = { binance: 'BTCUSDT', tradovate: 'NQ' }

export const useMarketStore = defineStore('market', () => {
  const datasource = ref<DataSource>('binance')
  const view = ref<MarketView>('candlestick')
  const symbol = ref(DEFAULT_SYMBOL.binance); const interval = ref<Interval>('1m'); const klines = ref<Kline[]>([]); const ticker = ref<Ticker>(); const loading = ref(false); const error = ref('')
  const symbols = ref<SymbolInfo[]>([]); const tickers = ref<Ticker[]>([]); const universeLoading = ref(false); const universeError = ref('')
  // Tradovate 实时流：报价 / 盘口 / 逐笔
  const quote = ref<Quote>()
  const dom = ref<Dom>()
  const trades = ref<TradeTick[]>([])
  const domConnected = ref(false)

  async function load() {
    loading.value = true; error.value = ''
    try {
      const result = await fetchMarket(symbol.value, interval.value, datasource.value)
      klines.value = result.klines
      ticker.value = result.ticker
    } catch (e) { error.value = e instanceof Error ? e.message : '加载失败' } finally { loading.value = false }
  }

  /** 拉取交易对列表 + 24h 行情快照（供搜索列表展示）。任一侧失败都清空该侧并记录错误。 */
  async function loadUniverse() {
    universeLoading.value = true; universeError.value = ''
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

  /** 切换数据源（同时重置标的为各源默认合约并重新加载列表）。 */
  function setDatasource(next: DataSource) {
    if (datasource.value === next) return
    datasource.value = next
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
    if (next !== 'tradovate' && view.value !== 'candlestick') view.value = 'candlestick'
    void loadUniverse()
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

  function update(kline: Kline) {
    if (!kline || typeof kline.time !== 'number') return
    const last = klines.value.at(-1)
    if (last?.time === kline.time) klines.value[klines.value.length - 1] = kline
    else klines.value.push(kline)
    if (klines.value.length > 500) klines.value.shift()
    if (ticker.value) ticker.value = { ...ticker.value, price: kline.close, updatedAt: Date.now() }
  }

  /** 全量历史批量（Tradovate hist）：整表替换。 */
  function applyHist(rows: Kline[]) {
    if (!Array.isArray(rows)) return
    // 按 time 去重 + 升序，保证 setData 有序性
    const seen = new Map<number, Kline>()
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
    const base = ticker.value ?? { symbol: symbol.value, change24h: 0, volume24h: 0, updatedAt: Date.now() }
    ticker.value = { ...base, price, updatedAt: Date.now() }
  }

  return {
    datasource, view, symbol, interval, klines, ticker, loading, error,
    symbols, tickers, universeLoading, universeError,
    quote, dom, trades, domConnected,
    load, loadUniverse, setDatasource, setView, setSymbol,
    update, applyHist, setQuote, setDom, addTrade, setPrice,
  }
})
