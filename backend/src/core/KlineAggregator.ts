import type { Interval, Kline } from '../types/kline'

/**
 * K 线时间戳 / 聚合工具（后端唯一入口）。
 *
 * 协议约定（与前端图表库 lightweight-charts 保持一致）：
 * - 所有对外输出的 K 线时间戳都是 **10 位 Unix 秒级时间戳**（毫秒输入会被换算）；
 * - 时间戳按当前 K 线周期 **向下取整对齐**（1m：floor(timeSec / 60) * 60），
 *   保证同一周期内到达的 Tick / 子周期 bar 都落在同一根 K 线上。
 */

/** 各 K 线周期对应的秒数（与前端 utils/candlestickCountdown.INTERVAL_SECONDS 对齐）。 */
export const INTERVAL_SECONDS: Record<Interval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
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
  const step = typeof interval === 'number' ? interval : (INTERVAL_SECONDS[interval] ?? 60)
  if (!Number.isFinite(epochSec) || epochSec <= 0 || step <= 0) return 0
  return Math.floor(epochSec / step) * step
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

/**
 * Tick / 子周期 bar → K 线实时聚合器（合成当前周期未收盘的那根 K 线）。
 *
 * 规则：
 * 1. **时间对齐**：毫秒级时间戳换算为秒，并按周期向下取整（1m：`floor(sec / 60) * 60`）；
 * 2. **同周期更新**：`high` 取最大、`low` 取最小、`close` 取最新价、`volume` 累加（`open` 保持首笔）；
 * 3. **跨周期开新根**：开启一根全新 K 线，`open/high/low/close` 均为新周期首笔价，`volume` 重新计数；
 * 4. **防乱序**：时间戳早于当前 K 线（周期已收盘）的迟到数据直接丢弃（返回 null），
 *    避免图表 `update()` 因时间回退报错，或旧数据覆盖新 K 线。
 */
export class KlineAggregator {
  private readonly step: number
  private bar: Kline | null = null
  /** 上一根子周期 bar（用于识别重复推送，避免 volume 重复累加）。 */
  private lastSubBar: SubBarInput | null = null

  constructor(readonly interval: Interval) {
    this.step = INTERVAL_SECONDS[interval] ?? 60
  }

  /** 当前未收盘 K 线快照（无则 null）。 */
  get current(): Kline | null {
    return this.bar ? { ...this.bar } : null
  }

  /** 清空状态（切换标的 / 上游数据源类型变化时调用）。 */
  reset(): void {
    this.bar = null
    this.lastSubBar = null
  }

  /**
   * 用历史 K 线播种，使实时首根与历史快照在同一周期时「续接」而不是「覆盖」：
   * - 尚无当前 K 线 → 直接采用该历史 K 线（后续数据在它基础上继续更新）；
   * - 已合成出同周期 K 线 → 合并（`open` 取历史、`high/low` 取极值、`close` 保留实时、`volume` 相加）；
   * - 历史与当前 K 线不同周期（更旧 / 更新）→ 忽略。
   * @returns 合并后的当前 K 线（调用方可补推一次给图表）；无需更新时返回 null。
   */
  seed(kline: Kline): Kline | null {
    const time = toEpochSeconds(kline.time)
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
      return { ...this.bar }
    }
    if (time !== bar.time) return null
    // 同周期：历史提供开盘价与前段成交量，实时数据提供最新收盘价
    if (open > 0) bar.open = open
    bar.high = Math.max(bar.high, high > 0 ? high : close, close)
    bar.low = Math.min(bar.low, low > 0 ? low : close, close)
    bar.volume += volume
    return { ...bar }
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

  /** 统一的「按周期落桶 + OHLCV 合并」：迟到数据返回 null。 */
  private apply(open: number, high: number, low: number, close: number, volume: number, epochSec: number): Kline | null {
    // 换线判定：tick 时间对齐后若落在更大周期 → bucket > 当前 K 线开盘时间（等价于 tickTime >= currentBar.time + interval）
    const bucket = alignToInterval(epochSec, this.step)
    if (!bucket) return null
    const bar = this.bar
    // 防乱序：属于已收盘周期的迟到数据 → 丢弃
    if (bar && bucket < bar.time) return null
    if (bar && bucket === bar.time) {
      // 当前周期：high 取最大、low 取最小、close 取最新价、volume 累加（open 保持首笔）
      bar.high = Math.max(bar.high, high, close)
      bar.low = Math.min(bar.low, low, close)
      bar.close = close
      bar.volume += volume
      return { ...bar }
    }
    // 跨入新周期（或首笔数据）：开启一根全新 K 线。
    // bucket 已按周期向下取整，理论上必然 ≥ 上一根 + 一个周期；这里再取 max 兜底，
    // 保证 newBar.time 严格大于上一根（图表 update() 依赖时间严格递增，否则换线处会卡住）。
    const newTime = bar ? Math.max(bucket, bar.time + this.step) : bucket
    const openPrice = open > 0 ? open : close
    this.bar = {
      time: newTime,
      open: openPrice,
      high: Math.max(high > 0 ? high : close, close, openPrice),
      low: Math.min(low > 0 ? low : close, close, openPrice),
      close,
      volume,
    }
    return { ...this.bar }
  }
}


