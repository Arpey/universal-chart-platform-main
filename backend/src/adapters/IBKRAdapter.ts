import { BaseAdapter } from './BaseAdapter'
import { getIBKRClient, IBKR_CME_SYMBOLS } from '../services/IBKRClient'
import type { IBKRClient, IBKRStatus } from '../services/IBKRClient'
import { KlineAggregator, toEpochMs, toEpochSeconds } from '../core/KlineAggregator'
import type { MarketDataAdapter, SymbolInfo } from '../types/adapter'
import type { Interval, Kline, KlineSeed } from '../types/kline'
import type { Ticker } from '../types/market'
import type { TickerMessage } from '../types/market'
import { logger } from '../utils/logger'

/**
 * 实时 K 线合成的上游数据源：
 * - `tick`：reqMktData / reqTickByTickData 的逐笔 tick 经 KlineAggregator 聚合（当前唯一启用路径，刷新粒度跟随 tick）；
 * - `bar`：上游 bar 粒度源（已停用，保留类型以便后续接入其它 bar 粒度数据源时复用）。
 */
type KlineFeed = 'bar' | 'tick'

/**
 * IBKR（盈透证券）数据源适配器。
 *
 * 复用**全局唯一**的 IBKRClient 实例（getIBKRClient 单例）：本适配器只做协议转换
 * （tick → TickerMessage、历史 / 实时 tick → Kline），不会创建第二个连接 ——
 * 所有 subscribeTick / subscribeBar / getKlines 都落在同一条到 TWS / IB Gateway 的连接上。
 * 将 IBKR 的行情统一转换为项目通用格式：
 * - tickPrice / tickSize / tickByTickAllLast → { type: 'ticker', source: 'IBKR', symbol, price, size, timestamp }
 * - reqHistoricalData 历史 K 线 → Kline[]（Unix 秒；REST / WS 全量快照）
 * - reqMktData / reqTickByTickData 的逐笔 tick → 经 KlineAggregator 合成 interval 周期的 K 线
 *   （Unix 秒、按周期向下取整对齐，WS 增量广播；不再依赖上游 5 秒 bar 接口）
 *
 * 通过 subscribeTick / subscribeBar 注册的回调实时输出（供 WebSocketServer 广播给前端）。
 * 行情类型（实时 / 延迟）由 backend/.env 的 IBKR_MARKET_DATA_TYPE 控制（默认实时），
 * 无实时权限时 IBKRClient 会自动回退延迟行情，并通过 onMarketDataType 通知前端展示。
 */
export class IBKRAdapter extends BaseAdapter implements MarketDataAdapter {
  /** 全局唯一 IBKRClient（单例）：绝不在此 new，避免向 TWS 注册额外的 API 客户端 */
  private readonly client: IBKRClient = getIBKRClient()

  /** 连通性预检：等待 IB Gateway / TWS 连接就绪（复用全局唯一连接，不会新建连接）。 */
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
      // 复用全局唯一连接：内部先解析真实近月合约（reqContractDetails），再 reqMktData / reqTickByTickData；
      // 已有连接时只增加订阅（引用计数），不会重新 connect
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
   * 订阅实时 K 线：上游 **只用逐笔 tick**（reqMktData / reqTickByTickData），
   * 经 KlineAggregator 聚合为当前订阅周期 的 K 线后回调（WebSocketServer）。
   *
   * IBKR 的 5 秒实时 bar 接口已停用 —— 其粒度固定 5 秒且受 TWS「10 分钟最多 60 次新请求」的
   * pacing 限制，无法满足 250ms 级实时刷新。逐笔来源：
   * - 实时行情：reqTickByTickData(AllLast) 提供真实逐笔成交；
   * - 延迟行情：reqTickByTickData 被 IB 拒绝，但 reqMktData 的 tickPrice / tickSize 仍在推送 →
   *   由 IBKRClient 合并后同样通过 onTick 输出。
   * 两条路径都落在同一个 onTick 上，K 线刷新粒度因此完全跟随 tick（有 tick 即推进当前 K 线）。
   *
   * 聚合保证：毫秒时间戳 → 10 位 Unix 秒、按 interval 向下取整对齐、同周期 high=max / low=min /
   * close=最新 / volume 累加、跨周期开新根、迟到数据丢弃。
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
      // 内部先解析真实近月合约，再 reqMktData（实时行情下另发 reqTickByTickData）
      unsubscribeClient = await this.client.subscribeMarketData(symbol)
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err))
      return () => {}
    }

    const aggregator = new KlineAggregator(interval)
    // 上游数据源恒为逐笔 tick：不再根据 marketDataType 分流到 5 秒 bar 通路
    let feed: KlineFeed = 'tick'

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

    // 逐笔 → K 线聚合：每来一个 tick 即推进当前 K 线（同周期高/低/收/量更新，跨周期开新根）。
    // 聚合器内部完成「毫秒 → 10 位 Unix 秒 + 按周期向下取整对齐 + 乱序/迟到丢弃」，
    // 因此前端收到 kline 后可立即 series.update()，刷新粒度跟随 tick（无 5 秒 bar 的粒度上限）。
    const unsubscribeTick = this.client.onTick((tick) => {
      if (disposed || feed !== 'tick' || tick.symbol !== symbol) return
      emit(aggregator.push({ price: tick.price, size: tick.size, timestamp: tick.timestamp }))
    })

    // 取消订阅：只清理 tick 监听 + 上游行情订阅（5 秒 bar 通路已移除，无任何定时器/看门狗残留）
    return () => {
      disposed = true
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
