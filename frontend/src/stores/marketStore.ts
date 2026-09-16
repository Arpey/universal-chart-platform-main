import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { DataSource, Dom, Interval, Kline, MarketView, Quote, Source, SymbolInfo, Ticker, TradeTick } from '../types'
import { fetchMarket, fetchSymbols, fetchTickers } from '../services/chartService'
import { normalizeKline, normalizeKlines } from '../utils/klineSeries'

const DEFAULT_SYMBOL: Record<DataSource, string> = { binance: 'BTCUSDT', tradovate: 'NQ', tradefi: 'XAUUSDT', ibkr: 'MES' }

export const useMarketStore = defineStore('market', () => {
  const datasource = ref<DataSource>('ibkr')
  /** 当前分类：全部合约 / Tradefi（与 datasource 保持同步，tradovate 不在分类内）。 */
  const currentSource = ref<Source>('ibkr')
  const view = ref<MarketView>('candlestick')
  const symbol = ref(DEFAULT_SYMBOL.ibkr); const interval = ref<Interval>('1m'); const ticker = ref<Ticker>(); const loading = ref(false); const error = ref('')
  /** K 线最大保留根数（超出裁掉最旧一根）。 */
  const MAX_BARS = 500
  /**
   * K 线数组：shallowRef + 纯 JS 对象（刻意 **不** 放进 Vue 深度响应式）。
   * 实时 tick 只对「最后一根」原地更新 —— 不新建数组、不触发深度遍历/深比较，
   * 消费方（图表等）通过 klineVersion / lastBarTime / barCount 这些轻量信号即时感知变化。
   */
  const klines = shallowRef<Kline[]>([])
  /** tick 级变更信号：每次成功写入 K 线自增，图表据此在 **同一任务内** 调用 series.update()（无节流）。 */
  const klineVersion = ref(0)
  /** 当前（未收盘）K 线的开盘时间（10 位 Unix 秒）：仅跨周期换线时变化，供倒计时 / 分页使用。 */
  const lastBarTime = ref(0)
  /** K 线根数：仅在结构性变化（新增 / 整表替换 / 裁掉最旧）时更新，避免每 tick 触发列表重建。 */
  const barCount = ref(0)
  const symbols = ref<SymbolInfo[]>([]); const tickers = ref<Ticker[]>([]); const universeLoading = ref(false); const universeError = ref('')
  // Tradovate 实时流：报价 / 盘口 / 逐笔
  const quote = ref<Quote>()
  const dom = ref<Dom>()
  const trades = ref<TradeTick[]>([])
  const domConnected = ref(false)
  /** 最近一次收到行情数据的时间戳（epoch ms）：用于判断当前是否处于"已连接但无新行情"的休市/低流动性静默期。 */
  const lastDataAt = ref(0)
  /**
   * IBKR 实际生效的行情类型：1=实时 / 2=冻结 / 3=延迟（CME 约延迟 10 分钟）/ 4=延迟冻结；null=未知。
   * 由后端 WS { type: 'marketdata' } 消息驱动，用于状态栏标注，避免把延迟数据误判为断流。
   */
  const ibkrMarketDataType = ref<number | null>(null)

  async function load() {
    loading.value = true; error.value = ''
    try {
      const result = await fetchMarket(symbol.value, interval.value, datasource.value)
      setKlines(result.klines)
      ticker.value = result.ticker
    } catch (e) { error.value = e instanceof Error ? e.message : '加载失败' } finally { loading.value = false }
  }

  /**
   * 结构性写入（历史快照 / 分页 / 加载 / 清空）：整表替换并同步轻量信号。
   * 归一化保证 10 位 Unix 秒 + 严格升序（图表 setData 要求），属于低频操作、非 tick 热路径。
   */
  function setKlines(next: readonly Kline[]) {
    const bars = normalizeKlines(next)
    klines.value = bars
    barCount.value = bars.length
    lastBarTime.value = bars.length ? bars[bars.length - 1].time : 0
    klineVersion.value++ // 通知图表：结构变化 → 全量重绘一次
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
    setKlines([])
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
    setKlines([])
    ticker.value = undefined
    quote.value = undefined
    dom.value = undefined
    trades.value = []
    lastDataAt.value = 0
    ibkrMarketDataType.value = null
  }

  /**
   * 单根实时 K 线（后端 Tick 合成的当前周期 K 线）。
   *
   * - 归一化：毫秒 → 10 位 Unix 秒、数值兜底、high/low 与 open/close 自洽；
   * - 防乱序：时间早于最后一根的迟到数据直接丢弃，否则 lightweight-charts 的 `update()`
   *   会因时间回退抛错（Cannot update oldest data）并让图表停止刷新；
   * - 同周期（time 相同）：整根替换 —— 后端已按 high=max / low=min / close=最新 / volume 累加合成；
   * - 跨入新周期（time 更大）：追加一根全新 K 线。
   */
  function update(kline: Kline) {
    const next = normalizeKline(kline)
    if (!next) return
    const bars = klines.value
    const last = bars.length ? bars[bars.length - 1] : null
    // 防乱序：早于最后一根的迟到数据直接丢弃（不刷新「最近收到行情」时间戳）
    if (last && next.time < last.time) return
    if (last && next.time === last.time) {
      // 同周期：原地更新最后一根（零数组分配；图表随后拿到全新的 Bar 对象覆盖当前蜡烛）
      last.open = next.open
      last.high = next.high
      last.low = next.low
      last.close = next.close
      last.volume = next.volume
    } else {
      // 跨入新周期：尾部追加全新 K 线（next.time 严格大于上一根，换线不锁不卡）
      bars.push(next)
      lastBarTime.value = next.time
      if (bars.length > MAX_BARS) bars.shift()
      barCount.value = bars.length
    }
    lastDataAt.value = Date.now()
    // 唯一增量信号：图表 watcher(flush:'sync') 在同一任务内立即 series.update()（无 rAF / 无节流）
    klineVersion.value++
    // 价格变化才重建 ticker 对象，避免每 tick 产生无意义的响应式写入
    if (ticker.value && ticker.value.price !== next.close) {
      ticker.value = { ...ticker.value, price: next.close, updatedAt: Date.now() }
    }
  }

  /**
   * 全量历史批量（append=false 整表替换；append=true 追加更早分页数据）。
   * 统一经 setKlines：毫秒/秒归一化为 10 位 Unix 秒、过滤非法行、按 time 去重升序，
   * 保证 `setData()` 的有序性（混排单位会导致排序错乱、历史被当成最新数据）。
   */
  function applyHist(rows: Kline[], append = false) {
    if (!Array.isArray(rows)) return
    lastDataAt.value = Date.now()
    setKlines(append ? [...klines.value, ...rows] : rows)
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

  /** 接收后端回报的 IBKR 行情类型（1=实时 / 3=延迟），供状态栏标注「实时行情 / 延迟行情」。 */
  function setIbkrMarketDataType(next: number | null) {
    ibkrMarketDataType.value = typeof next === 'number' && Number.isFinite(next) ? next : null
  }

  return {
    datasource, currentSource, availableSources, view, symbol, interval, klines, ticker, loading, error,
    klineVersion, lastBarTime, barCount,
    symbols, tickers, universeLoading, universeError,
    quote, dom, trades, domConnected, lastDataAt, ibkrMarketDataType,
    load, loadUniverse, setDatasource, switchSource, setView, setSymbol,
    update, applyHist, setQuote, setDom, addTrade, setPrice, setIbkrMarketDataType,
    applySymbols,
    clearMarketData,
  }
})
