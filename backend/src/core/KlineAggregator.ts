import type { Interval, Kline } from '../types/kline'
import { logger } from '../utils/logger'
import { INTERVAL_SECONDS as SHARED_INTERVAL_SECONDS, intervalSeconds } from './intervals'

/**
 * K 线时间戳 / 聚合工具（后端唯一入口）。
 *
 * 协议约定（与前端图表库 lightweight-charts 保持一致）：
 * - 所有对外输出的 K 线时间戳都是 **10 位 Unix 秒级时间戳**（毫秒输入会被换算）；
 * - 时间戳按当前 K 线周期 **向下取整对齐**（1m：floor(timeSec / 60) * 60），
 *   保证同一周期内到达的 Tick / 子周期 bar 都落在同一根 K 线上。
 */

/**
 * 各 K 线周期对应的秒数（与前端 `constants/intervals.INTERVAL_SECONDS` 对齐）。
 * 唯一来源：`core/intervals.ts`（含 IBKR barSizeSetting / durationStr 映射），此处仅再导出以兼容既有引用。
 */
export const INTERVAL_SECONDS: Record<Interval, number> = {
  '1m': SHARED_INTERVAL_SECONDS['1m'],
  '5m': SHARED_INTERVAL_SECONDS['5m'],
  '15m': SHARED_INTERVAL_SECONDS['15m'],
  '1h': SHARED_INTERVAL_SECONDS['1h'],
  '4h': SHARED_INTERVAL_SECONDS['4h'],
  '1d': SHARED_INTERVAL_SECONDS['1d'],
}

/** 归一化时间戳为 Unix 秒：>= 1e12 视为毫秒（IBKR 上游）→ 向下取整为秒；非法 / 非正数返回 0。 */
export function toEpochSeconds(timestamp: number): number {
  const n = Number(timestamp)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

/** 归一化时间戳为 Unix 毫秒：< 1e12 视为秒（前端图表分页参数）→ 乘 1000；非法 / 非正数返回 0。 */
export function toEpochMs(timestamp: number): number {
  const n = Number(timestamp)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n >= 1e12 ? Math.floor(n) : Math.floor(n * 1000)
}

/** 周期对齐：向下取整到所属 K 线的开盘时间（1m 周期：`Math.floor(sec / 60) * 60`）。 */
export function alignToInterval(epochSec: number, interval: Interval | number): number {
  const step = typeof interval === 'number' ? interval : intervalSeconds(interval)
  if (!Number.isFinite(epochSec) || epochSec <= 0 || step <= 0) return 0
  return Math.floor(epochSec / step) * step
}

/**
 * 历史 K 线归一化（REST 历史接口 / 适配器层统一入口）：
 * 1. 时间戳统一为 **10 位 Unix 秒**（毫秒自动除以 1000 取整），非数字 / <= 0 的行丢弃；
 * 2. 数值兜底：OHLC 必须为正有限数，volume 不为负（否则该行丢弃）；
 * 3. 相同 time 去重 —— **保留最后一条**；
 * 4. 按 time 升序排序（图表 setData 要求严格升序）；
 * 5. 传入 interval 时按周期网格对齐（历史 / 实时同网格，避免错位）；
 * 6. 截取**最后 limit 根**（最近 limit 根，不多不少）。
 */
export function normalizeBars(
  rows: readonly Kline[] | null | undefined,
  limit: number,
  interval?: Interval | number,
): Kline[] {
  if (!Array.isArray(rows) || rows.length === 0) return []
  const byTime = new Map<number, Kline>()
  for (const row of rows) {
    if (!row) continue
    const rawTime = toEpochSeconds(row.time)
    if (!rawTime) continue
    const time = interval === undefined ? rawTime : alignToInterval(rawTime, interval)
    if (!time) continue
    const close = num(row.close)
    const open = num(row.open, close)
    const high = num(row.high, close)
    const low = num(row.low, close)
    if (!(close > 0) || !(open > 0) || !(high > 0) || !(low > 0)) continue
    byTime.set(time, {
      time,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      volume: Math.max(0, num(row.volume)),
    })
  }
  if (byTime.size === 0) return []
  const ordered = [...byTime.values()].sort((a, b) => a.time - b.time)
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : ordered.length
  return ordered.length > cap ? ordered.slice(ordered.length - cap) : ordered
}

/**
 * 把小周期 K 线聚合为大周期（历史补齐用；与实时聚合器使用同一套周期网格）。
 *
 * 使用场景：IBKR 对 4h bar 的单次历史请求上限较小（实测约 90 根），不足 limit 根时用 1h 数据
 * 按 UTC 4h 网格聚合补齐 —— 聚合网格与实时 KlineAggregator 完全一致，因此历史最后一根与
 * 实时第一根仍然同网格、可无缝衔接。
 * 规则：同一桶内 open 取首根、high/low 取极值、close 取末根、volume 累加；最后只保留最近 limit 根。
 */
export function aggregateBars(rows: readonly Kline[] | null | undefined, interval: Interval | number, limit: number): Kline[] {
  const step = typeof interval === 'number' ? Math.floor(interval) : intervalSeconds(interval)
  if (!Number.isFinite(step) || step < 1) return []
  const source = normalizeBars(rows, Number.MAX_SAFE_INTEGER)
  if (source.length === 0) return []
  const buckets = new Map<number, Kline>()
  for (const row of source) {
    const bucket = alignToInterval(row.time, step)
    if (!bucket) continue
    const current = buckets.get(bucket)
    if (!current) {
      buckets.set(bucket, { time: bucket, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume })
      continue
    }
    current.high = Math.max(current.high, row.high)
    current.low = Math.min(current.low, row.low)
    current.close = row.close
    current.volume += row.volume
  }
  const bars = [...buckets.values()].sort((a, b) => a.time - b.time)
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : bars.length
  return bars.length > cap ? bars.slice(bars.length - cap) : bars
}

/** 逐笔成交输入（时间戳毫秒 / 秒均可，内部统一为秒并按周期对齐）。 */
export interface TickInput {
  price: number
  /** 成交量（缺失 / 非法按 0 累加）。 */
  size?: number
  timestamp: number
}

/** 子周期 bar 输入（如 IBKR reqRealTimeBars 的固定 5 秒 bar；时间戳毫秒 / 秒均可）。 */
export interface SubBarInput {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
}
/** 数值兜底：非有限值 → fallback。 */
function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 聚合器可选上下文（仅用于诊断日志与降级回调，不影响聚合结果）。 */
export interface KlineAggregatorOptions {
  /** 标的（如 MES / BTCUSDT）：写入 warn 日志，便于定位是哪个流出现问题。 */
  symbol?: string
}

/** 诊断日志节流窗口（同一实例 5s 内最多一条 warn），避免异常数据高频刷屏。 */
const WARN_THROTTLE_MS = 5_000

/**
 * Tick / 子周期 bar → K 线实时聚合器（合成当前周期未收盘的那根 K 线）。
 *
 * 规则：
 * 1. **时间对齐**：毫秒级时间戳先换算为**整数秒**，再按周期向下取整
 *    （`bucket = floor(sec / step) * step`，1m：`floor(sec / 60) * 60`）；
 * 2. **同周期更新**：`high` 取最大、`low` 取最小、`close` 取最新价、`volume` 累加（`open` 保持首笔）；
 * 3. **跨周期开新根**：新根开盘时间 = `上一根 + 一个周期`（缺口时也只推进一步，保持时间戳连续），
 *    `open/high/low/close` 均为新周期首笔价，`volume` 重新计数；
 * 4. **防乱序**：时间戳早于当前 K 线（周期已收盘）的迟到数据直接丢弃（返回 null）；
 * 5. **严格升序**：产出前用 `lastEmittedTime` 校验，时间回退的 K 线一律丢弃，
 *    避免图表 `update()` 因时间回退报错并停止刷新；
 * 6. **状态隔离**：`reset()` / `dispose()` 会清空 `bar`、`lastSubBar`、`lastEmittedTime` ——
 *    切换标的 / 周期时必须重建（或 dispose 后重建）聚合器，否则旧周期步长会污染新周期。
 */
export class KlineAggregator {
  private readonly step: number
  private bar: Kline | null = null
  /** 上一根子周期 bar（用于识别重复推送，避免 volume 重复累加）。 */
  private lastSubBar: SubBarInput | null = null
  /**
   * 最近一次成功产出（emit）的 K 线时间戳（Unix 秒）；null = 尚未产出任何 K 线。
   *
   * 用途：产出前的**严格升序校验** —— 时间早于该值的 K 线一律丢弃，
   * 否则图表 `setData() / update()` 会因时间乱序抛错并停止刷新（表现为 K 线卡住 / 错位）。
   * 注意：`time === lastEmittedTime` 属于「同一根 K 线的实时刷新」，必须放行
   * （前端依赖它覆盖当前蜡烛），只有 `time < lastEmittedTime` 才是需要丢弃的回退。
   */
  private lastEmittedTime: number | null = null
  /** 是否已 dispose（归属订阅已结束）：置位后丢弃一切输入，防止旧周期实例继续向图表推送。 */
  private disposed = false
  /** 最近一次 warn 时间（日志节流用）。 */
  private lastWarnAt = 0

  constructor(readonly interval: Interval, private readonly options: KlineAggregatorOptions = {}) {
    const configured = INTERVAL_SECONDS[interval] ?? 60
    // 周期步长兜底：必须是 >= 1 的整数秒（与数据源时间戳单位「秒」一致）
    this.step = Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 60
  }

  /** 当前未收盘 K 线快照（无则 null）。 */
  get current(): Kline | null {
    return this.bar ? { ...this.bar } : null
  }

  /** 最近一次产出的 K 线时间戳（Unix 秒）；尚未产出返回 null。 */
  get lastEmitted(): number | null {
    return this.lastEmittedTime
  }

  /** 当前周期步长（秒）。 */
  get stepSeconds(): number {
    return this.step
  }

  /** 是否已 dispose。 */
  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * 清空全部内部状态（切换标的 / 周期 / 上游数据源类型变化时调用）：
   * `bar`、`lastSubBar`、`lastEmittedTime` 必须一起清空 ——
   * 否则新周期的第一根 K 线会被旧周期的 `lastEmittedTime` 判为回退而丢弃。
   */
  reset(): void {
    this.bar = null
    this.lastSubBar = null
    this.lastEmittedTime = null
  }

  /**
   * 释放聚合器（取消订阅 / 周期切换时调用）：清空状态并拒绝后续输入。
   * 归属订阅结束后，为避免「旧周期聚合器仍持有旧步长并把旧周期 K 线推给图表」，
   * 调用方必须在删除缓存实例前先 dispose()。
   */
  dispose(): void {
    this.reset()
    this.disposed = true
  }

  /**
   * 用历史 K 线播种，使实时首根与历史快照在同一周期时「续接」而不是「覆盖」：
   * - 尚无当前 K 线 → 直接采用该历史 K 线（后续数据在它基础上继续更新）；
   * - 已合成出同周期 K 线 → 合并（`open` 取历史、`high/low` 取极值、`close` 保留实时、`volume` 相加）；
   * - 历史与当前 K 线不同周期（更旧 / 更新）→ 忽略。
   *
   * 时间戳对齐：历史 bar 的 open time 并不保证落在本周期网格上（典型：IBKR 4h bar 按交易所
   * 会话时间对齐，与 UTC 4h 网格相差 2 小时），这里统一向下取整到本周期网格后再播种 ——
   * 否则实时 tick 的 bucket 会永久小于 bar.time 而被判为「迟到」整段丢弃（图表数小时不刷新）。
   * 对已对齐的数据（1m / 5m / 15m / 1h / 1d）该操作是恒等变换。
   *
   * @returns 合并后的当前 K 线（调用方可补推一次给图表）；无需更新时返回 null。
   */
  seed(kline: Kline): Kline | null {
    if (this.disposed) return null
    const time = alignToInterval(toEpochSeconds(kline.time), this.step)
    const close = num(kline.close)
    const open = num(kline.open, close)
    const high = num(kline.high, close)
    const low = num(kline.low, close)
    const volume = Math.max(0, num(kline.volume))
    if (!time || !(close > 0)) return null

    const bar = this.bar
    if (!bar) {
      const openPrice = open > 0 ? open : close
      this.bar = {
        time,
        open: openPrice,
        high: Math.max(high > 0 ? high : close, close, openPrice),
        low: Math.min(low > 0 ? low : close, close, openPrice),
        close,
        volume,
      }
      return this.commit(this.bar)
    }
    if (time !== bar.time) return null
    // 同周期：历史提供开盘价与前段成交量，实时数据提供最新收盘价
    if (open > 0) bar.open = open
    bar.high = Math.max(bar.high, high > 0 ? high : close, close)
    bar.low = Math.min(bar.low, low > 0 ? low : close, close)
    bar.volume += volume
    return this.commit(bar)
  }

  /**
   * 喂入一笔逐笔成交。
   * @returns 需要推送给图表的 K 线（同周期更新同样返回）；乱序 / 非法数据返回 null。
   */
  push(tick: TickInput): Kline | null {
    const price = num(tick.price)
    if (!(price > 0)) return null
    const sec = toEpochSeconds(tick.timestamp)
    if (!sec) return null
    return this.apply(price, price, price, price, Math.max(0, num(tick.size)), sec)
  }

  /**
   * 喂入一根子周期 bar（如 IBKR 5 秒实时 bar），按目标周期合并 OHLCV。
   * @returns 需要推送给图表的 K 线；乱序 / 重复 / 非法数据返回 null。
   */
  pushBar(input: SubBarInput): Kline | null {
    const sec = toEpochSeconds(input.time)
    const close = num(input.close)
    if (!sec || !(close > 0)) return null
    const open = num(input.open, close) || close
    const high = num(input.high, close) || close
    const low = num(input.low, close) || close
    const volume = Math.max(0, num(input.volume))
    // 上游重复推送同一根子周期 bar：不重复累加成交量（5 秒 bar 正常只在收盘后推送一次）
    const prev = this.lastSubBar
    if (prev
      && prev.time === input.time && prev.open === open && prev.high === high
      && prev.low === low && prev.close === close && num(prev.volume) === volume) {
      return null
    }
    const result = this.apply(open, high, low, close, volume, sec)
    if (result) this.lastSubBar = { ...input }
    return result
  }

  /**
   * 统一的「按周期落桶 + OHLCV 合并」。
   *
   * 时间戳规则（保证交给图表的数据**严格升序且逐周期连续**）：
   * 1. `bucket = floor(ts / step) * step`：先把时间戳统一为**整数秒**（毫秒输入已在 push / pushBar 换算），
   *    再按当前周期网格向下取整对齐 —— 这一步是本模块唯一的对齐入口，单位与 step（秒）完全一致；
   * 2. `bucket < 当前根开盘时间` → 属于已收盘周期的迟到数据，丢弃并 warn；
   * 3. `bucket === 当前根开盘时间` → 同周期合并（open 保持首笔、high/low 取极值、close 取最新、volume 累加）；
   * 4. 新根开盘时间只在三种取值中产生，绝不直接使用 bucket 之外的值：
   *    - `bucket < 当前根 + step`（上游时间戳与周期网格不一致）→ 归入**当前根**，不新建 K 线；
   *    - `bucket === 当前根 + step` → 正好进入下一根，使用 bucket；
   *    - `bucket > 当前根 + step`（数据源缺口）→ 仍只推进**一个 step**（保持时间戳连续，避免图表断裂/跳跃）。
   *
   * 旧实现把新根时间戳写成「bucket 与 bar.time + step 的较大值」，在数据源存在跳变 / 缺口 /
   * 网格不一致时会把时间戳强推到网格外的未来位置，导致后续数据被判为迟到而被丢弃 →
   * 图表出现断点、不连续与时间戳跳跃（1m 因网格天然一致所以看不出问题）。
   */
  private apply(open: number, high: number, low: number, close: number, volume: number, epochSec: number): Kline | null {
    if (this.disposed) return null
    const ts = Math.floor(epochSec) // 统一为整数秒（10 位 Unix 秒，图表唯一可接受的单位）
    const bucket = alignToInterval(ts, this.step)
    if (!bucket) return null
    const bar = this.bar
    if (bar) {
      // 防乱序：属于已收盘周期的迟到数据 → 丢弃（并输出诊断日志）
      if (bucket < bar.time) {
        this.warn(`丢弃迟到数据（时间回退）: bucket=${bucket} < bar.time=${bar.time}`, ts)
        return null
      }
      // 当前周期：high 取最大、low 取最小、close 取最新价、volume 累加（open 保持首笔）
      if (bucket === bar.time) return this.mergeCurrent(bar, high, low, close, volume)
    }
    // 跨入新周期（或首笔数据）：计算新根开盘时间，保证「严格递增 + 逐周期连续」
    let newTime: number
    if (!bar) {
      newTime = bucket
    } else {
      const expectedNext = bar.time + this.step
      if (bucket < expectedNext) {
        // 上游时间戳与周期网格不一致（例：历史播种后上游 bar 起点偏移）→ 归入当前根，
        // 避免产生网格外的跳跃时间戳（这也是「其他周期显示异常」的直接根因之一）
        return this.mergeCurrent(bar, high, low, close, volume)
      }
      if (bucket > expectedNext) {
        const gap = Math.floor((bucket - expectedNext) / this.step) + 1
        this.warn(`检测到周期缺口（跳空 ${gap} 根）: bucket=${bucket} > bar.time+step=${expectedNext}（按 expectedNext 推进，保持连续）`, ts)
      }
      // bucket === expectedNext：正好进入下一根；bucket > expectedNext：缺口 → 只推进一个 step
      newTime = expectedNext
    }
    const openPrice = open > 0 ? open : close
    this.bar = {
      time: newTime,
      open: openPrice,
      high: Math.max(high > 0 ? high : close, close, openPrice),
      low: Math.min(low > 0 ? low : close, close, openPrice),
      close,
      volume,
    }
    return this.commit(this.bar)
  }

  /** 同周期合并并产出（open 保持首笔；high/low 取极值，close 取最新，volume 累加）。 */
  private mergeCurrent(bar: Kline, high: number, low: number, close: number, volume: number): Kline | null {
    bar.high = Math.max(bar.high, high, close)
    bar.low = Math.min(bar.low, low, close)
    bar.close = close
    bar.volume += volume
    return this.commit(bar)
  }

  /**
   * 产出前的严格升序校验（并记录 `lastEmittedTime`）：
   * - `time > lastEmittedTime`：新根，正常产出；
   * - `time === lastEmittedTime`：同一根 K 线的实时刷新（前端 `series.update()` 依赖它覆盖当前蜡烛），正常产出；
   * - `time < lastEmittedTime`：时间回退（旧周期残留 / 上游乱序）→ 丢弃并 warn，避免图表停止刷新。
   */
  private commit(bar: Kline): Kline | null {
    const last = this.lastEmittedTime
    if (last !== null && bar.time < last) {
      this.warn(`丢弃时间回退 K 线（会破坏图表严格升序要求）: bar.time=${bar.time} < lastEmitted=${last}`, bar.time)
      return null
    }
    this.lastEmittedTime = bar.time
    return { ...bar }
  }

  /** 诊断日志（带节流）：统一输出 symbol / interval / step / 输入时间戳，便于定位是哪个数据流异常。 */
  private warn(message: string, timestamp: number): void {
    const now = Date.now()
    if (now - this.lastWarnAt < WARN_THROTTLE_MS) return
    this.lastWarnAt = now
    logger.warn(`[KlineAggregator] ${this.options.symbol ?? '-'} ${this.interval} (step=${this.step}s, ts=${timestamp}) ${message}`)
  }
}


