import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { DataSource, Dom, Interval, Kline, MarketView, Quote, Source, SymbolInfo, Ticker, TradeTick } from '../types'
import { fetchKlineHistory, fetchSymbols, fetchTicker, fetchTickers } from '../services/chartService'
import { HISTORY_BAR_LIMIT_RESOLVED } from '../constants/intervals'
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
  /**
   * 历史 K 线快照最后一根的时间（10 位 Unix 秒）：实时数据与之衔接的边界。
   * 规则（避免历史与实时重叠 / 断档）：实时 bar.time < 边界 → 丢弃；== 边界 → 覆盖最后一根；> 边界 → 追加新根。
   */
  const lastHistoricalTime = ref(0)
  /** 历史请求序号：快速连续切换 symbol / interval 时丢弃过期响应（避免旧品种数据覆盖新品种）。 */
  let historyRequestSeq = 0
  /** 是否还存在更早的历史 K 线（后端 hasMore）：false 时图表不再向后分页。 */
  const hasMoreHistory = ref(false)
  /** 向后分页（加载更早 K 线）请求进行中：防止拖动时间轴时高频重入。 */
  const historyLoading = ref(false)
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

  /**
   * 加载历史 K 线并整表替换（切换 symbol / interval 后的第一步，TradingView 风格：
   * 先铺满最近 HISTORY_BAR_LIMIT 根，渲染完成后才建立实时订阅）。
   *
   * 流程：REST 拉取 → 归一化（10 位 Unix 秒 / 按周期网格对齐 / 升序 / 去重）→ setKlines（图表 setData + 整表重绘）
   * → 记录 lastHistoricalTime（实时衔接边界）。数据源不支持历史时返回空数组，不视为失败（等实时流补图）。
   * 过期响应（期间又切换了 symbol / interval / 数据源，或已 clearMarketData）会被直接丢弃。
   * @returns 是否成功（含「数据源无历史」= true；仅网络 / 接口报错为 false，供 UI 提示与重试判断）
   */
  async function loadHistory(options: { source?: DataSource; limit?: number } = {}): Promise<boolean> {
    const source = options.source ?? datasource.value
    const limit = options.limit ?? HISTORY_BAR_LIMIT_RESOLVED
    const requestSymbol = symbol.value
    const requestInterval = interval.value
    const seq = ++historyRequestSeq
    loading.value = true; error.value = ''
    try {
      const page = await fetchKlineHistory(requestSymbol, requestInterval, source, limit)
      if (seq !== historyRequestSeq) return false
      if (requestSymbol !== symbol.value || requestInterval !== interval.value) return false
      const bars = page.bars
      // 只保留最近 limit 根（后端已裁剪，这里再兜底一次，保证「不多不少」）
      setKlines(bars.length > limit ? bars.slice(bars.length - limit) : bars)
      // 分页游标：是否还有更早的数据（后端 hasMore；空数据源 → false，不再分页）
      hasMoreHistory.value = bars.length > 0 && (page.hasMore || bars.length >= limit)
      const last = klines.value.at(-1)
      lastHistoricalTime.value = last ? last.time : 0
      if (last) {
        ticker.value = ticker.value
          ? { ...ticker.value, price: last.close, updatedAt: Date.now() }
          : { symbol: requestSymbol, price: last.close, change24h: 0, volume24h: 0, updatedAt: Date.now() }
      }
      return true
    } catch (e) {
      if (seq === historyRequestSeq) error.value = e instanceof Error ? e.message : '历史 K 线加载失败'
      return false
    } finally {
      if (seq === historyRequestSeq) loading.value = false
    }
  }

  /** 顶栏行情快照（只取最新价；失败静默，不阻塞历史渲染与实时订阅）。 */
  async function loadTicker() {
    try {
      const snapshot = await fetchTicker(symbol.value, datasource.value)
      if (snapshot && Number.isFinite(snapshot.price) && snapshot.price > 0) ticker.value = snapshot
    } catch { /* 顶栏价格可由实时流补上，忽略快照失败 */ }
  }

  /** 兼容入口：历史 K 线（最近 HISTORY_BAR_LIMIT 根）+ 顶栏行情快照（并行、各自容错）。 */
  async function load() {
    await Promise.allSettled([loadHistory(), loadTicker()])
  }

  /**
   * 向左分页：加载更早的历史 K 线（图表拖动时间轴到最左侧时触发）。
   *
   * - `endTime` = 当前最早一根的时间：后端只返回**严格早于**它的最近 HISTORY_BAR_LIMIT 根，页与页不重叠；
   * - 合并去重（严格早于当前最早一根 + 去掉已存在的 time）后经 setKlines 整表写入，
   *   图表走全量 setData，随后由图表侧按新增根数补偿视口偏移（画面不跳动）；
   * - 并发 / 已切换品种 / 请求失败 → 返回 null（图表保持 hasMore 不变，稍后可重试）。
   *
   * @returns 新增（前置）的根数；0 = 没有更早的数据（hasMore=false）；null = 本次跳过
   */
  async function loadMoreHistory(): Promise<number | null> {
    const bars = klines.value
    const oldest = bars.length ? bars[0].time : 0
    if (!oldest || !hasMoreHistory.value) return 0
    if (historyLoading.value) return null
    const requestSymbol = symbol.value
    const requestInterval = interval.value
    const seq = historyRequestSeq
    historyLoading.value = true
    try {
      const page = await fetchKlineHistory(requestSymbol, requestInterval, datasource.value, HISTORY_BAR_LIMIT_RESOLVED, oldest)
      if (seq !== historyRequestSeq) return null
      if (requestSymbol !== symbol.value || requestInterval !== interval.value) return null
      const known = new Set(bars.map((bar) => bar.time))
      const older = normalizeKlines(page.bars, interval.value)
        .filter((bar) => bar.time < oldest && !known.has(bar.time))
      if (!older.length) {
        // 上游没有更早的数据（或数据源不支持分页）→ 停止继续向左分页
        hasMoreHistory.value = false
        return 0
      }
      setKlines([...older, ...bars])
      hasMoreHistory.value = page.hasMore
      lastDataAt.value = Date.now()
      return older.length
    } catch (e) {
      error.value = e instanceof Error ? e.message : '更早的 K 线加载失败'
      return null
    } finally {
      historyLoading.value = false
    }
  }

  /**
   * 结构性写入（历史快照 / 分页 / 加载 / 清空）：整表替换并同步轻量信号。
   * 归一化保证 10 位 Unix 秒 + 按当前周期网格对齐 + 严格升序（图表 setData 要求），属于低频操作、非 tick 热路径。
   */
  function setKlines(next: readonly Kline[]) {
    const bars = normalizeKlines(next, interval.value)
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
    // 历史衔接边界与在途历史请求一并失效：避免旧品种/旧周期的响应写回图表
    lastHistoricalTime.value = 0
    historyRequestSeq += 1
    // 分页状态重置：新标的/周期从「暂无更早数据」开始，由随后的 loadHistory 按后端 hasMore 重新置位
    hasMoreHistory.value = false
    historyLoading.value = false
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
    // 归一化 + 按当前周期网格对齐：与历史快照落在同一网格上，跨周期切换后不会出现错位/断点
    const next = normalizeKline(kline, interval.value)
    if (!next) return
    const bars = klines.value
    const last = bars.length ? bars[bars.length - 1] : null
    // ---- 历史 / 实时衔接规则（避免与历史最后一根重叠或断档）----
    // 边界 = 历史快照最后一根的时间（lastHistoricalTime；与当前最后一根取较大值兜底）：
    //   next.time <  边界 → 历史已覆盖过的重复数据，丢弃；
    //   next.time === 边界 === last.time → 用实时数据覆盖最后一根（update 语义）；
    //   next.time >  边界 → 追加为新 K 线（append 语义）。
    const boundary = Math.max(last?.time ?? 0, lastHistoricalTime.value)
    if (next.time < boundary) return
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
    klineVersion, lastBarTime, barCount, lastHistoricalTime, hasMoreHistory, historyLoading,
    symbols, tickers, universeLoading, universeError,
    quote, dom, trades, domConnected, lastDataAt, ibkrMarketDataType,
    load, loadHistory, loadMoreHistory, loadTicker, loadUniverse, setDatasource, switchSource, setView, setSymbol,
    update, applyHist, setQuote, setDom, addTrade, setPrice, setIbkrMarketDataType,
    applySymbols,
    clearMarketData,
  }
})
