import { BaseAdapter } from './BaseAdapter'
import { tradovateClient } from '../services/TradovateClient'
import type { MarketDataAdapter } from '../types/adapter'
import type { Interval, Kline } from '../types/kline'
import type { DomData, DomLevel, QuoteData, Ticker, TradeData } from '../types/market'
import type { TradovateCandle, TradovateContract, TradovateSubscribeVariant } from '../types/tradovate'
import { logger } from '../utils/logger'

/** 内置的美股股指 / 商品期货合约（前端搜索列表用），近月合约按当前日期自动解析。 */
const CONTRACTS: TradovateContract[] = [
  { root: 'NQ', baseAsset: 'NQ', quoteAsset: 'USD', name: '纳斯达克 100 指数期货' },
  { root: 'MNQ', baseAsset: 'MNQ', quoteAsset: 'USD', name: '微型纳斯达克 100 指数期货' },
  { root: 'ES', baseAsset: 'ES', quoteAsset: 'USD', name: '标普 500 指数期货' },
  { root: 'MES', baseAsset: 'MES', quoteAsset: 'USD', name: '微型标普 500 指数期货' },
  { root: 'YM', baseAsset: 'YM', quoteAsset: 'USD', name: '道琼斯工业平均指数期货' },
  { root: 'MYM', baseAsset: 'MYM', quoteAsset: 'USD', name: '微型道琼斯指数期货' },
  { root: 'RTY', baseAsset: 'RTY', quoteAsset: 'USD', name: '罗素 2000 指数期货' },
  { root: 'M2K', baseAsset: 'M2K', quoteAsset: 'USD', name: '微型罗素 2000 指数期货' },
  { root: 'CL', baseAsset: 'CL', quoteAsset: 'USD', name: 'WTI 原油期货' },
  { root: 'GC', baseAsset: 'GC', quoteAsset: 'USD', name: 'COMEX 黄金期货' },
  { root: 'SI', baseAsset: 'SI', quoteAsset: 'USD', name: 'COMEX 白银期货' },
]

/** 季度合约月份代码：3/6/9/12 月（股指与多数商品期货采用季度合约） */
const QUARTER_MONTHS: Array<{ code: string; month0: number }> = [
  { code: 'H', month0: 2 },
  { code: 'M', month0: 5 },
  { code: 'U', month0: 8 },
  { code: 'Z', month0: 11 },
]

/** 完整合约名形如 NQU6 / ESU6 / MNQZ6（根 + 月份代码 + 年份尾数） */
const MONTH_CODE_PATTERN = /^[A-Z]{1,4}[FGHJKMNQUVXZ]\d$/

/** 每个季度合约的第三个星期五（到期日约定） */
function thirdFriday(year: number, month0: number): Date {
  const first = new Date(Date.UTC(year, month0, 1))
  const dow = first.getUTCDay() // 0=周日
  const firstFriday = 1 + ((5 - dow + 7) % 7)
  return new Date(Date.UTC(year, month0, firstFriday + 14))
}

/**
 * 将根合约名（如 NQ / ES / MNQ）解析为当前近月完整合约（如 NQU6）。
 * 若传入已是完整合约名（如 NQZ6），直接返回。到期前 5 天自动滚动到下一季度合约。
 */
export function resolveContract(symbol: string, now: Date = new Date()): string {
  const s = symbol.trim().toUpperCase()
  if (MONTH_CODE_PATTERN.test(s)) return s
  const root = s.replace(/[^A-Z]/g, '')
  if (!root) return s
  const threshold = now.getTime() - 5 * 24 * 3600 * 1000
  let best: { expiry: number; contract: string } | null = null
  for (let y = now.getFullYear(); y <= now.getFullYear() + 1; y++) {
    for (const q of QUARTER_MONTHS) {
      const expiry = thirdFriday(y, q.month0).getTime()
      if (expiry >= threshold) {
        const contract = `${root}${q.code}${String(y).slice(-1)}`
        if (!best || expiry < best.expiry) best = { expiry, contract }
      }
    }
  }
  return best?.contract ?? `${root}Z${String(now.getFullYear()).slice(-1)}`
}

/** 时间戳解析：毫秒 epoch 或 ISO 字符串 → 秒级时间戳（与前端 Kline 模型一致） */
function toSec(ts: string | number | undefined): number {
  if (ts === undefined) return 0
  const n = typeof ts === 'number' ? ts : Date.parse(String(ts))
  if (!Number.isFinite(n) || n <= 0) return 0
  return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

/** Tradovate 蜡烛 → 标准 Kline（volume 优先用总成交量，缺失时用 up+down） */
function toKline(c: TradovateCandle): Kline {
  const up = Number(c.upVolume ?? 0)
  const down = Number(c.downVolume ?? 0)
  const volume = Number(c.volume ?? (up + down))
  return {
    time: toSec(c.timestamp),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number.isFinite(volume) ? volume : 0,
  }
}

/** 按 time 去重 + 升序 + 截取末尾 limit 根 */
function collectLast(rows: Kline[], limit: number): Kline[] {
  const seen = new Map<number, Kline>()
  for (const k of rows) {
    if (k.time > 0) seen.set(k.time, k)
  }
  return [...seen.values()].sort((a, b) => a.time - b.time).slice(-limit)
}

/** 提取 chart 载荷中的蜡烛批次（兼容新/旧两种协议包裹方式） */
function extractChartBatches(payload: Record<string, unknown>): Array<{ type?: string; candles: TradovateCandle[] }> {
  if (Array.isArray(payload.charts)) {
    return (payload.charts as Array<Record<string, unknown>>).map((c) => ({
      type: typeof c.type === 'string' ? c.type : undefined,
      candles: Array.isArray(c.candles) ? c.candles as TradovateCandle[] : [],
    }))
  }
  if (Array.isArray(payload.candles)) {
    return [{ type: typeof payload.type === 'string' ? payload.type : undefined, candles: payload.candles as TradovateCandle[] }]
  }
  return []
}

/** 提取 quote 载荷条目（兼容新/旧两种协议包裹方式） */
function extractQuoteItems(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(payload.quotes)) return payload.quotes as Array<Record<string, unknown>>
  if (Array.isArray(payload.entries)) return payload.entries as Array<Record<string, unknown>>
  return []
}

/** 提取 DOM 载荷条目 */
function extractDomItems(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(payload.doms)) return payload.doms as Array<Record<string, unknown>>
  if (Array.isArray(payload.entries)) return payload.entries as Array<Record<string, unknown>>
  return []
}

/** 解析 quote 载荷 → 标准化报价 */
function parseQuotePayload(symbol: string, payload: Record<string, unknown>): QuoteData | null {
  const items = extractQuoteItems(payload)
  if (!items.length) return null
  let bid: number | null = null
  let ask: number | null = null
  let last: number | null = null
  let size = 0
  let ts = Date.now()
  for (const it of items) {
    if (typeof it.price === 'number' && Number.isFinite(it.price)) last = it.price
    if (typeof it.bid === 'number' && Number.isFinite(it.bid) && bid === null) bid = it.bid
    if (typeof it.ask === 'number' && Number.isFinite(it.ask) && ask === null) ask = it.ask
    if (typeof it.size === 'number' && Number.isFinite(it.size)) size = it.size
    const t = (it.timestamp ?? it.time) as string | number | undefined
    if (t !== undefined) {
      const parsed = typeof t === 'number' ? t : Date.parse(String(t))
      if (Number.isFinite(parsed) && parsed > 0) ts = parsed
    }
  }
  if (bid === null && ask === null && last === null) return null
  return { symbol, bid, ask, last, size, timestamp: ts }
}

/** 解析 quote/Trade 载荷 → 标准化逐笔成交 */
function parseTradePayload(symbol: string, payload: Record<string, unknown>): TradeData | null {
  const items = extractQuoteItems(payload)
  if (!items.length) return null
  // 逐笔成交通常只有一条：price + size，side 可由 bid/ask 相对关系推断
  const it = items[items.length - 1]
  const price = Number(it.price)
  if (!Number.isFinite(price)) return null
  let side: TradeData['side'] = ''
  if (typeof it.bid === 'number' && typeof it.ask === 'number') {
    if (price >= Number(it.ask)) side = 'Buy'
    else if (price <= Number(it.bid)) side = 'Sell'
  } else if (it.side === 'Bid' || it.side === 'Buy' || it.side === 'buy') {
    side = 'Buy'
  } else if (it.side === 'Ask' || it.side === 'Sell' || it.side === 'sell') {
    side = 'Sell'
  }
  const size = Number(it.size)
  return { symbol, price, size: Number.isFinite(size) ? size : 0, side, timestamp: toSec((it.timestamp ?? it.time) as string | number | undefined) * 1000 || Date.now() }
}

/** 时间间隔 → 毫秒（用于 REST 历史区间推算） */
function intervalMs(interval: Interval): number {
  return { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }[interval]
}

/** Date → yyyy-MM-dd（Tradovate REST 日期参数格式） */
function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10)
}



/**
 * Tradovate（demo / live）行情适配器。
 * - REST：鉴权 + /marketdata/query/candle 历史 K 线；
 * - WS：md/subscribequote（报价/成交）、md/subscribedom（盘口）、md/getchart（K 线），
 *   通过共享的 TradovateClient 维持单条 MD 长连接，数据清洗为项目标准 JSON。
 */
export class TradovateAdapter extends BaseAdapter implements MarketDataAdapter {
  /** 全局共享单例：与 MarketManager / 其他连接共用同一 Client，内存 Token 缓存整体复用 */
  readonly client = tradovateClient

  private symbolsCache: { data: Array<{ symbol: string; baseAsset: string; quoteAsset: string }>; at: number } | null = null
  private tickersCache: { data: Ticker[]; at: number } | null = null
  private quoteCache = new Map<string, { quote: QuoteData; at: number }>()
  /** 盘口簿（DOM 增量 → 完整快照）：symbol → 档位 */
  private domBooks = new Map<string, Map<string, DomLevel>>()

  /** 连通性预检：验证配置并完成鉴权（WS 连接前调用）。 */
  async ping(): Promise<void> {
    await this.client.ensureAuth()
  }

  async getKlines(symbol: string, interval: Interval, limit = 300): Promise<Kline[]> {
    const contract = resolveContract(symbol)
    const now = new Date()
    const start = new Date(now.getTime() - limit * intervalMs(interval) * 3) // 留 3 倍余量保证取满
    try {
      const rows = await this.client.restGet<TradovateCandle[]>('/marketdata/query/candle', {
        symbol: contract,
        chartType: 'Candlestick',
        interval,
        startDate: toDateStr(start),
        endDate: toDateStr(now),
        max: limit,
      })
      const klines = collectLast(rows.map(toKline), limit)
      if (klines.length) return klines
      logger.warn(`[Tradovate] REST 历史 K 线为空（${contract} ${interval}），改用 WS hist`)
    } catch (err) {
      // 鉴权/账号等致命错误直接抛出，让前端看到真实原因（如 Incorrect username or password）
      if (this.isFatalError(err)) throw err
      logger.warn(`[Tradovate] REST 历史 K 线失败，改用 WS hist: ${err instanceof Error ? err.message : String(err)}`)
    }
    return this.fetchChartHist(contract, interval, limit)
  }

  /** 鉴权/未配置等致命错误判断：此类错误无需降级到 WS，应直接上报。 */
  private isFatalError(err: unknown): boolean {
    if (!(err instanceof Error)) return false
    return /鉴权|Incorrect|badCredentials|unauthorized|not configured|未配置|401|403/i.test(err.message)
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const contract = resolveContract(symbol)
    // 优先返回最近缓存的实时报价（活动订阅期间价格始终更新）
    const cached = this.quoteCache.get(contract)
    if (cached && Date.now() - cached.at < 5_000 && cached.quote.last != null) {
      return { symbol: contract, price: cached.quote.last, change24h: 0, volume24h: 0, updatedAt: cached.quote.timestamp }
    }
    const quote = await this.fetchQuoteOnce(contract, 5_000)
    return { symbol: contract, price: quote?.last ?? 0, change24h: 0, volume24h: 0, updatedAt: Date.now() }
  }

  async getSymbols(): Promise<Array<{ symbol: string; baseAsset: string; quoteAsset: string }>> {
    if (this.symbolsCache && Date.now() - this.symbolsCache.at < 5 * 60_000) return this.symbolsCache.data
    const rows = CONTRACTS.map((c) => ({ symbol: resolveContract(c.root), baseAsset: c.baseAsset, quoteAsset: c.quoteAsset }))
    this.symbolsCache = { data: rows, at: Date.now() }
    return rows
  }

  /** 批量获取合约最新价（临时订阅全部合约的报价，12s 内收集首轮推送）。缓存 15s。 */
  async getAllTickers(): Promise<Ticker[]> {
    if (this.tickersCache && Date.now() - this.tickersCache.at < 15_000) return this.tickersCache.data
    const symbols = (await this.getSymbols()).map((s) => s.symbol)
    const prices = new Map<string, number>()
    let disposers: Array<() => Promise<void>> = []
    // 鉴权失败等直接抛出，让前端搜索列表显示真实错误而非全 0 价格
    await this.client.connect()
    const collect = async () => {
      disposers = []
      await Promise.allSettled(symbols.map(async (symbol) => {
        const unsub = await this.client.subscribe(
          [
            { operation: 'md/subscribequote', body: { symbol }, unsubOperation: 'md/unsubscribequote', unsubBody: { symbol } },
            { operation: 'md/subscribeQuote', body: { symbol }, unsubOperation: 'md/unsubscribeQuote', unsubBody: { symbol } },
          ],
          (payload) => {
            const q = parseQuotePayload(symbol, payload)
            if (q?.last != null) prices.set(symbol, q.last)
          },
        )
        disposers.push(unsub)
      }))
    }
    await Promise.race([collect(), new Promise((r) => setTimeout(r, 12_000))])
    for (const d of disposers) await d().catch(() => {})
    const tickers: Ticker[] = symbols.map((symbol) => ({
      symbol,
      price: prices.get(symbol) ?? 0,
      change24h: 0,
      volume24h: 0,
      updatedAt: Date.now(),
    }))
    this.tickersCache = { data: tickers, at: Date.now() }
    return tickers
  }

  /** 订阅 K 线增量：getchart 全量 hist → onHist（整表替换），增量 upd → onKline（逐根合并）。 */
  subscribe(symbol: string, interval: Interval, onKline: (kline: Kline) => void, onHist?: (klines: Kline[]) => void, onError?: (message: string) => void): () => void {
    const contract = resolveContract(symbol)
    const chartId = `${contract}.${interval}`
    let unsub: (() => Promise<void>) | null = null

    this.client.subscribe(this.chartVariants(contract, interval, chartId), (payload) => {
      for (const batch of extractChartBatches(payload)) {
        const candles = collectLast(batch.candles.map(toKline), 500)
        if (!candles.length) continue
        if (batch.type === 'hist' || batch.type === 'line') {
          if (onHist) onHist(candles)
          else candles.forEach(onKline)
        } else {
          candles.forEach(onKline)
        }
      }
    })
      .then((u) => { unsub = u })
      .catch((err) => {
        logger.error(`[Tradovate] K 线订阅失败: ${contract} ${interval}`, err)
        onError?.(err instanceof Error ? err.message : String(err))
      })

    return () => { void unsub?.().catch(() => {}) }
  }

  /** 实时报价流（BidAsk）。 */
  subscribeQuote(symbol: string, onQuote: (data: QuoteData) => void, onError?: (message: string) => void): () => void {
    const contract = resolveContract(symbol)
    let unsub: (() => Promise<void>) | null = null
    this.client.subscribe(
      [
        // 依次尝试：小写（新版）→ 驼峰（经典文档）→ 无 quotetype
        { operation: 'md/subscribequote', body: { symbol: contract, quotetype: 'BidAsk' }, unsubOperation: 'md/unsubscribequote', unsubBody: { symbol: contract } },
        { operation: 'md/subscribeQuote', body: { symbol: contract, quotetype: 'BidAsk' }, unsubOperation: 'md/unsubscribeQuote', unsubBody: { symbol: contract } },
        { operation: 'md/subscribequote', body: { symbol: contract }, unsubOperation: 'md/unsubscribequote', unsubBody: { symbol: contract } },
        { operation: 'md/subscribeQuote', body: { symbol: contract }, unsubOperation: 'md/unsubscribeQuote', unsubBody: { symbol: contract } },
      ],
      (payload) => {
        const q = parseQuotePayload(contract, payload)
        if (q) {
          this.quoteCache.set(contract, { quote: q, at: Date.now() })
          onQuote(q)
        }
      },
    )
      .then((u) => { unsub = u })
      .catch((err) => onError?.(err instanceof Error ? err.message : String(err)))
    return () => { void unsub?.().catch(() => {}) }
  }

  /** 盘口订单簿流（增量维护完整快照）。 */
  subscribeDOM(symbol: string, onDom: (data: DomData) => void, onError?: (message: string) => void): () => void {
    const contract = resolveContract(symbol)
    let unsub: (() => Promise<void>) | null = null
    this.client.subscribe(
      [
        { operation: 'md/subscribedom', body: { symbol: contract }, unsubOperation: 'md/unsubscribedom', unsubBody: { symbol: contract } },
        { operation: 'md/subscribeDOM', body: { symbol: contract }, unsubOperation: 'md/unsubscribeDOM', unsubBody: { symbol: contract } },
      ],
      (payload) => {
        const dom = this.updateDomBook(contract, payload)
        if (dom) onDom(dom)
      },
    )
      .then((u) => { unsub = u })
      .catch((err) => onError?.(err instanceof Error ? err.message : String(err)))
    return () => { void unsub?.().catch(() => {}) }
  }

  /** 逐笔成交流（quotetype=Trade，失败回退到普通报价流）。 */
  subscribeTick(symbol: string, onTick: (data: TradeData) => void, onError?: (message: string) => void): () => void {
    const contract = resolveContract(symbol)
    let unsub: (() => Promise<void>) | null = null
    this.client.subscribe(
      [
        { operation: 'md/subscribequote', body: { symbol: contract, quotetype: 'Trade' }, unsubOperation: 'md/unsubscribequote', unsubBody: { symbol: contract } },
        { operation: 'md/subscribeQuote', body: { symbol: contract, quotetype: 'Trade' }, unsubOperation: 'md/unsubscribeQuote', unsubBody: { symbol: contract } },
        { operation: 'md/subscribequote', body: { symbol: contract }, unsubOperation: 'md/unsubscribequote', unsubBody: { symbol: contract } },
        { operation: 'md/subscribeQuote', body: { symbol: contract }, unsubOperation: 'md/unsubscribeQuote', unsubBody: { symbol: contract } },
      ],
      (payload) => {
        const t = parseTradePayload(contract, payload)
        if (t) onTick(t)
      },
    )
      .then((u) => { unsub = u })
      .catch((err) => onError?.(err instanceof Error ? err.message : String(err)))
    return () => { void unsub?.().catch(() => {}) }
  }


  // ---------- 内部工具 ----------

  /** 构造 chart 订阅候选（优先经典驼峰 md/subscribeChart，失败回退新版 md/getchart）。 */
  private chartVariants(contract: string, interval: Interval, chartId: string): TradovateSubscribeVariant[] {
    const now = new Date()
    const from = new Date(now.getTime() - 3 * 24 * 3600 * 1000) // 预取最近 3 天
    const body = {
      symbol: contract,
      chartDescription: {
        chartId,
        chartType: 'Candlestick',
        interval,
        recalc: true,
        contracted: false,
        timeRange: {
          closestTimestamp: from.toISOString(),
          latestTimestamp: now.toISOString(),
        },
        revision: 0,
        newSession: false,
        refreshRate: 1000,
      },
    }
    return [
      { operation: 'md/subscribeChart', body, unsubOperation: 'md/unsubscribeChart', unsubBody: { chartId } },
      { operation: 'md/getchart', body, unsubOperation: 'md/cancelchart', unsubBody: { chartId } },
    ]
  }

  /** 临时订阅一次报价，收到首个有效报价后立即取消（限时 timeoutMs）。 */
  private fetchQuoteOnce(symbol: string, timeoutMs: number): Promise<QuoteData | null> {
    return new Promise((resolve) => {
      let unsubFn: (() => Promise<void>) | null = null
      const timer = setTimeout(() => {
        void unsubFn?.().catch(() => {})
        resolve(null)
      }, timeoutMs)
      this.client.subscribe(
        [
          { operation: 'md/subscribequote', body: { symbol }, unsubOperation: 'md/unsubscribequote', unsubBody: { symbol } },
          { operation: 'md/subscribeQuote', body: { symbol }, unsubOperation: 'md/unsubscribeQuote', unsubBody: { symbol } },
        ],
        (payload) => {
          const q = parseQuotePayload(symbol, payload)
          if (q) {
            clearTimeout(timer)
            this.quoteCache.set(symbol, { quote: q, at: Date.now() })
            void unsubFn?.().catch(() => {})
            resolve(q)
          }
        },
      )
        .then((u) => { unsubFn = u })
        .catch(() => {
          clearTimeout(timer)
          resolve(null)
        })
    })
  }

  /** 通过 getchart 一次性拉取历史 K 线（REST 失败时的兜底）。 */
  private fetchChartHist(contract: string, interval: Interval, limit: number): Promise<Kline[]> {
    return new Promise((resolve) => {
      const chartId = `${contract}.${interval}`
      const collected: Kline[] = []
      let unsubFn: (() => Promise<void>) | null = null
      const finish = (rows: Kline[]) => {
        clearTimeout(timer)
        void unsubFn?.().catch(() => {})
        resolve(collectLast(rows, limit))
      }
      const timer = setTimeout(() => finish(collected), 12_000)
      this.client.subscribe(this.chartVariants(contract, interval, chartId), (payload) => {
        for (const batch of extractChartBatches(payload)) {
          if (batch.type === 'hist') {
            collected.push(...batch.candles.map(toKline))
            finish(collected)
            return
          }
        }
      })
        .then((u) => { unsubFn = u })
        .catch(() => {
          clearTimeout(timer)
          resolve([])
        })
    })
  }

  /** DOM 增量 → 完整盘口快照（A=新增 U=更新 D=删除；同时接受全量 entries）。 */
  private updateDomBook(symbol: string, payload: Record<string, unknown>): DomData | null {
    const items = extractDomItems(payload)
    if (!items.length) return null
    let book = this.domBooks.get(symbol)
    if (!book) { book = new Map(); this.domBooks.set(symbol, book) }

    for (const it of items) {
      const price = Number(it.price)
      if (!Number.isFinite(price)) continue
      const side = it.side === 'Ask' ? 'Ask' : 'Bid'
      const size = Number(it.size ?? (side === 'Ask' ? it.askSize : it.bidSize))
      const key = `${side}:${price}`
      const action = String(it.action ?? '').toUpperCase()
      if (action === 'D' || (Number.isFinite(size) && size === 0)) {
        book.delete(key)
      } else if (Number.isFinite(size)) {
        book.set(key, { price, size, side })
      }
    }

    const bids: DomLevel[] = []
    const asks: DomLevel[] = []
    for (const lvl of book.values()) (lvl.side === 'Bid' ? bids : asks).push(lvl)
    bids.sort((a, b) => b.price - a.price) // 买盘：从最高价往下
    asks.sort((a, b) => a.price - b.price) // 卖盘：从最低价往上
    return { symbol, levels: [...asks, ...bids], timestamp: Date.now() }
  }

  /** 关闭底层连接（进程退出时调用）。 */
  close(): void {
    this.client.close()
  }
}
