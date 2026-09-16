import { BaseAdapter } from './BaseAdapter'
import { IBKRClient, IBKR_CME_SYMBOLS } from '../services/IBKRClient'
import type { IBKRStatus } from '../services/IBKRClient'
import { KlineAggregator, toEpochMs, toEpochSeconds } from '../core/KlineAggregator'
import type { MarketDataAdapter, SymbolInfo } from '../types/adapter'
import type { Interval, Kline, KlineSeed } from '../types/kline'
import type { Ticker } from '../types/market'
import type { TickerMessage } from '../types/market'
import { logger } from '../utils/logger'

/**
 * 实时 K 线合成的上游数据源：
 * - `bar`：权威 5 秒实时 bar（reqRealTimeBars，实时行情下可用）；
 * - `tick`：逐笔 tick 合成（延迟行情下拿不到 5 秒 bar 时的兜底，否则 K 线无法实时推进）。
 */
type KlineFeed = 'bar' | 'tick'

/** 订阅后多久收不到实时 bar 就退化为逐笔合成（3 根 5 秒 bar 的余量）。 */
const BAR_FEED_TIMEOUT_MS = 15_000
/** 退化看门狗轮询间隔。 */
const BAR_FEED_WATCH_INTERVAL_MS = 3_000

/**
 * IBKR（盈透证券）数据源适配器。
 *
 * 内部管理 IBKRClient 实例，将 IBKR 的行情统一转换为项目通用格式：
 * - tickPrice / tickSize / tickByTickAllLast → { type: 'ticker', source: 'IBKR', symbol, price, size, timestamp }
 * - reqHistoricalData 历史 K 线 → Kline[]（Unix 秒；REST / WS 全量快照）
 * - reqRealTimeBars 5 秒实时 bar / 逐笔 tick → 经 KlineAggregator 合成 interval 周期的 K 线
 *   （Unix 秒、按周期向下取整对齐，WS 增量广播）
 *
 * 通过 subscribeTick / subscribeBar 注册的回调实时输出（供 WebSocketServer 广播给前端）。
 * 行情类型（实时 / 延迟）由 backend/.env 的 IBKR_MARKET_DATA_TYPE 控制（默认实时），
 * 无实时权限时 IBKRClient 会自动回退延迟行情，并通过 onMarketDataType 通知前端展示。
 */
export class IBKRAdapter extends BaseAdapter implements MarketDataAdapter {
  private readonly client = new IBKRClient()

  /** 连通性预检：等待 IB Gateway / TWS 连接就绪。 */
  ping(): Promise<void> {
    return this.client.waitForConnection()
  }

  getSymbols(): Promise<SymbolInfo[]> {
    return Promise.resolve(IBKR_CME_SYMBOLS.map((s) => ({
      symbol: s.symbol,
      baseAsset: s.symbol,
      quoteAsset: 'USD',
      name: s.name,
      exchange: s.exchange,
      secType: s.secType,
    })))
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const tick = this.client.getLast(symbol)
    return { symbol, price: tick?.price ?? 0, change24h: 0, volume24h: 0, updatedAt: tick?.timestamp ?? Date.now() }
  }

  async getAllTickers(): Promise<Ticker[]> {
    return IBKR_CME_SYMBOLS.map((s) => {
      const tick = this.client.getLast(s.symbol)
      return { symbol: s.symbol, price: tick?.price ?? 0, change24h: 0, volume24h: 0, updatedAt: tick?.timestamp ?? Date.now() }
    })
  }

  async getKlines(symbol: string, interval: Interval, limit = 300, endDateTime?: number): Promise<Kline[]> {
    // reqHistoricalData：合约参数（Symbol/SecType/Exchange/Currency）由 IBKRClient.CONTRACTS 统一维护；
    // 内置默认超时（15s），防止前端无限等待。endDateTime 用于分页拉取更早数据。
    // 分页参数来自前端图表 bar 的**秒级**时间戳，而 IBKRClient 内部按毫秒解释 → 这里统一换算；
    // 返回侧再把 IBKR 的毫秒时间戳归一化为 10 位 Unix 秒（与 Binance / Tradovate 协议一致）。
    const endMs = endDateTime && endDateTime > 0 ? toEpochMs(endDateTime) : undefined
    const rows = await this.client.getHistoricalKlines(symbol, interval, limit, undefined, endMs)
    return rows.map((row) => ({ ...row, time: toEpochSeconds(row.time) }))
  }

  /**
   * K 线订阅（与 URL 参数流的 kline 协议兼容）：
   * - onHist：reqHistoricalData 一次性全量历史（300 根，时间戳为 Unix 秒）；
   * - onKline：实时增量 —— 由 subscribeBar 把 5 秒实时 bar / 逐笔 tick 聚合为当前周期 K 线（Unix 秒、按周期对齐）。
   * 历史快照与实时流并行请求（历史慢不会拖住实时 K 线），历史最后一根作为聚合器的播种数据。
   */
  subscribe(
    symbol: string,
    interval: Interval,
    onKline: (kline: Kline) => void,
    onHist?: (klines: Kline[]) => void,
    onError?: (message: string) => void,
  ): () => void {
    let disposed = false
    let cancel: (() => void) | null = null
    // 历史快照（内置超时，失败仅回调 onError）
    const history = this.getKlines(symbol, interval, 300)
    void history
      .then((rows) => { if (!disposed) onHist?.(rows) })
      .catch((err) => { if (!disposed) onError?.(err instanceof Error ? err.message : String(err)) })
    // 实时增量（subscribeBar 为异步，内部先解析合约）；历史最后一根作为聚合器播种数据，
    // 历史失败时吞掉拒绝（实时订阅仍继续，仅首根 K 线的 open/volume 完整性受影响）
    const seed = history.then((rows) => rows[rows.length - 1]).catch(() => undefined)
    void this.subscribeBar(symbol, interval, onKline, onError, seed)
      .then((unsub) => { if (disposed) unsub(); else cancel = unsub })
    return () => {
      disposed = true
      cancel?.()
    }
  }

  /**
   * 订阅 tick 行情：内部对 symbol 建立 IBKR 行情订阅，
   * 将统一格式的 TickerMessage 实时回调给调用方（WebSocketServer）。
   */
  async subscribeTick(
    symbol: string,
    onTick: (data: TickerMessage) => void,
    onError?: (message: string) => void,
  ): Promise<() => void> {
    let disposed = false
    let unsubscribeClient: (() => void) | null = null
    try {
      // 内部先解析真实近月合约（reqContractDetails），再 reqMktData / reqTickByTickData
      unsubscribeClient = await this.client.subscribeMarketData(symbol)
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err))
      return () => {}
    }
    const unsubscribeListener = this.client.onTick((tick) => {
      if (disposed || tick.symbol !== symbol) return
      onTick({ type: 'ticker', source: 'IBKR', ...tick })
    })
    return () => {
      disposed = true
      unsubscribeListener()
      unsubscribeClient?.()
    }
  }

  /**
   * 订阅实时 K 线，并把上游数据 **聚合为当前订阅周期** 的 K 线后回调（WebSocketServer）。
   *
   * 上游可能是两种粒度，两者都会先经 KlineAggregator 归一化：
   * - 权威 5 秒实时 bar（reqRealTimeBars，实时行情下唯一可用，`barSize` 参数被 TWS 忽略）；
   * - 逐笔 tick（reqMktData / reqTickByTickData）：延迟行情拿不到 5 秒 bar 时退化为逐笔合成。
   *
   * 聚合保证：毫秒时间戳 → 10 位 Unix 秒、按 interval 向下取整对齐、同周期 high=max / low=min /
   * close=最新 / volume 累加、跨周期开新根、迟到数据丢弃。
   * 两种数据源不会同时累加成交量：切回权威 bar 时会清空逐笔合成的未完成 K 线。
   *
   * @param seed 历史最后一根 K 线（可为异步 Promise）：与实时首根同周期时续接而非覆盖，
   *             否则该周期的 open 与前半段 volume 会缺失。
   */
  async subscribeBar(
    symbol: string,
    interval: Interval,
    onKline: (kline: Kline) => void,
    onError?: (message: string) => void,
    seed?: KlineSeed,
  ): Promise<() => void> {
    let disposed = false
    let unsubscribeClient: (() => void) | null = null
    try {
      // 内部先解析真实近月合约，再 reqMktData + reqRealTimeBars（TWS 固定 5 秒 bar）
      unsubscribeClient = await this.client.subscribeMarketData(symbol)
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err))
      return () => {}
    }

    const aggregator = new KlineAggregator(interval)
    // 已知当前拿不到实时行情（延迟 / 冻结）时直接走逐笔合成，避免白白等 15s 看门狗
    const marketDataType = this.client.getMarketDataType()
    let feed: KlineFeed = marketDataType != null && marketDataType !== 1 ? 'tick' : 'bar'
    let lastBarAt = Date.now()

    // 消费方（WebSocketServer 广播）异常不得反向影响上游 tick 循环与聚合状态机
    const emit = (kline: Kline | null) => {
      if (!kline || disposed) return
      try {
        onKline(kline)
      } catch (err) {
        logger.error(`[IBKR] ${symbol} ${interval} K 线回调异常`, err)
      }
    }

    // 历史播种：异步到达也不算晚 —— 与已合成的同周期 K 线合并（open 取历史、volume 相加）
    if (seed) {
      void Promise.resolve(seed)
        .then((row) => { if (row) emit(aggregator.seed(row)) })
        .catch(() => { /* 历史不可用：仅影响首根 K 线的 open / volume 完整性 */ })
    }

    const unsubscribeBar = this.client.onRealtimeBar((bar) => {
      if (disposed || bar.symbol !== symbol) return
      if (feed !== 'bar') {
        // 逐笔合成 → 权威 5 秒 bar：丢弃逐笔合成的未完成 K 线，避免 OHLCV 重复累加
        aggregator.reset()
        feed = 'bar'
      }
      lastBarAt = Date.now()
      emit(aggregator.pushBar({
        time: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      }))
    })

    const unsubscribeTick = this.client.onTick((tick) => {
      // 仅在权威 bar 不可用时用逐笔合成，避免与 5 秒 bar 的成交量重复累加。
      // 注意：逐笔时间戳为 IBKRClient 的接收时刻（毫秒），因此延迟行情下合成 K 线按「接收时刻」
      // 落桶 —— 延迟体现在价格上，而非把 K 线放到 10 分钟前的时间轴上。
      if (disposed || feed !== 'tick' || tick.symbol !== symbol) return
      emit(aggregator.push({ price: tick.price, size: tick.size, timestamp: tick.timestamp }))
    })

    // 看门狗：长时间收不到实时 bar（reqRealTimeBars 被跳过 / 被拒）→ 退化为逐笔合成，保证 K 线仍在推进。
    // 使用「一次性延时 + 按需重排」而非常驻 setInterval：每条订阅不再常驻定时器，且不会在
    // 已退化 / 已销毁后继续唤醒（避免定时器泄漏与状态被反复重置）。
    let watchdog: ReturnType<typeof setTimeout> | null = null
    const armWatchdog = () => {
      if (disposed || feed === 'tick' || watchdog) return
      watchdog = setTimeout(() => {
        watchdog = null
        if (disposed || feed === 'tick') return
        if (Date.now() - lastBarAt < BAR_FEED_TIMEOUT_MS) {
          armWatchdog() // 仍能收到 bar → 继续等待下一次检查
          return
        }
        feed = 'tick'
        aggregator.reset()
        logger.info(`[IBKR] ${symbol} ${interval} 已 ${BAR_FEED_TIMEOUT_MS / 1000}s 未收到实时 bar，退化为逐笔合成 K 线`)
      }, BAR_FEED_WATCH_INTERVAL_MS)
    }
    armWatchdog()

    return () => {
      disposed = true
      if (watchdog) {
        clearTimeout(watchdog)
        watchdog = null
      }
      unsubscribeBar()
      unsubscribeTick()
      unsubscribeClient?.()
    }
  }

  /** 监听底层 IB Gateway / TWS 连接状态（供 WebSocketServer 广播给客户端）。 */
  onStatus(listener: (connected: boolean, error?: Error) => void): () => void {
    return this.client.onStatus(listener)
  }

  /** 监听行情类型变更（1=实时 2=冻结 3=延迟 4=延迟冻结），供 WebSocketServer 广播给前端展示。 */
  onMarketDataType(listener: (marketDataType: number) => void): () => void {
    return this.client.onMarketDataType(listener)
  }

  /** 当前生效的行情类型（1=实时 3=延迟）；尚未收到 IB 通知时为 null。 */
  getMarketDataType(): number | null {
    return this.client.getMarketDataType()
  }

  /** 运行状态快照（GET /api/ibkr/status）。 */
  getStatus(): IBKRStatus {
    return this.client.getStatus()
  }

  /** 关闭底层连接（进程退出时调用）。 */
  close(): void {
    this.client.close()
  }
}
