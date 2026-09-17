import type { MarketAdapter } from '../types/adapter'
import type { Interval, Kline } from '../types/kline'
import { normalizeBars } from '../core/KlineAggregator'
import { HISTORY_BAR_LIMIT } from '../core/intervals'
import { TtlCache } from '../core/HistoryCache'
import { logger } from '../utils/logger'

export abstract class BaseAdapter implements MarketAdapter {
  /**
   * 历史 K 线内存缓存（TTL 15s，key 含 symbol / interval / limit）：
   * 用户快速来回切换 symbol·interval 时避免反复打上游（IBKR 历史数据有 pacing 限制，
   * 短时间大量请求会被判为「请求过于频繁」直接失败）；并发同 key 请求共享同一 Promise。
   */
  private readonly historyCache = new TtlCache()

  abstract getKlines(symbol: string, interval: any, limit: number, endTime?: number): Promise<any[]>
  abstract getTicker(symbol: string): Promise<any>
  abstract subscribe(symbol: string, interval: any, onKline: (kline: any) => void): () => void

  /**
   * 历史 K 线（前端切换 symbol / interval 时经 REST 预加载；后端实时订阅的播种数据也走这里，
   * 因此两个调用方共享同一份缓存，不会对上游重复请求）。
   *
   * 归一化规则（见 normalizeBars）：时间戳 → 10 位 Unix 秒、按周期网格对齐、升序、
   * 同 time 去重（保留最后一条）、只返回**最近 limit 根**。
   * 不支持历史 / 上游暂无数据时返回空数组并记录 warn（前端按「先订阅实时、逐步补图」容错）。
   *
   * @param endTime 分页边界（10 位 Unix 秒，可选）：只返回**严格早于**该时间的最近 limit 根；
   *                缺省 = 最近 limit 根（首屏行为）。分页请求按 endTime 隔离缓存。
   */
  async fetchHistoricalBars(symbol: string, interval: Interval, limit = HISTORY_BAR_LIMIT, endTime?: number): Promise<Kline[]> {
    // 多取 50%：历史 bar 可能与周期网格不一致（IBKR 4h 按交易所会话时间对齐），
    // 网格对齐 + 去重会合并部分 bar，若只按 limit 根请求，对齐后可能不足 limit（实测 100 → 90）。
    const requested = Math.max(limit, Math.ceil(limit * 1.5))
    const boundary = Number.isFinite(endTime) && (endTime ?? 0) > 0 ? Math.floor(endTime as number) : null
    const key = `${symbol}|${interval}|${requested}|${boundary ?? ''}`
    const rows = await this.historyCache.get(key, () => this.loadHistoricalBars(symbol, interval, requested, boundary ?? undefined))
    const normalized = normalizeBars(rows, requested, interval)
    // 分页：丢弃边界之后的 bar（含边界本身），保证与上一页无重叠 → 再截取最近 limit 根
    const scoped = boundary === null ? normalized : normalized.filter((bar) => bar.time < boundary)
    const bars = limit > 0 ? scoped.slice(-limit) : scoped
    if (!bars.length) {
      logger.warn(`[history] ${symbol} ${interval}${boundary ? ` endTime=${boundary}` : ''} 未取得历史 K 线（数据源不支持历史或上游暂无数据），返回空数组`)
    }
    return bars
  }

  /**
   * 子类钩子：拉取**原始**历史 K 线（未归一化，时间戳单位随数据源）。
   * 默认复用 getKlines —— 各数据源既有的历史拉取实现（Binance REST / Tradovate REST+WS / IBKR reqHistoricalData）。
   * 需要更精确的上游参数（如 IBKR 的 durationStr）时在子类覆写。
   * @param endTime 10 位 Unix 秒（可选）：透传给上游作为「取这段之前的数据」的分页参数。
   */
  protected async loadHistoricalBars(symbol: string, interval: Interval, limit: number, endTime?: number): Promise<Kline[]> {
    return await this.getKlines(symbol, interval, limit, endTime)
  }
}

