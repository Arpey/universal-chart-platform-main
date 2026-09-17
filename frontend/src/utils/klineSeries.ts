import type { Interval, Kline } from '../types'
import { intervalToSeconds } from './candlestickCountdown'
import { toEpochSeconds } from './beijingTime'

/**
 * K 线时间戳 / 数值归一化（进入 store 与图表前的唯一入口）。
 *
 * 图表库 lightweight-charts 的硬性要求：
 * - 时间戳必须是 **10 位 Unix 秒级时间戳**（`UTCTimestamp`），不能用毫秒；
 * - `setData()` 的 time 必须严格升序，`update()` 的 time 不得早于最后一根；
 * - 同一根 K 线的 OHLC 必须自洽（high ≥ open/close ≥ low），否则影线绘制异常。
 *
 * 后端各数据源时间戳单位并不统一（IBKR 历史/实时为毫秒，Binance / Tradovate / 聚合器为秒），
 * 因此所有进入前端的数据都先经本模块归一化，避免「毫秒与秒混排」导致排序错乱、
 * 图表把历史数据当成最新数据（update() 报 Cannot update oldest data）等问题。
 */

/** 兼容毫秒 / 秒 → 10 位 Unix 秒；非法 / 非正数返回 0。 */
export function toKlineSeconds(time: number): number {
  return toEpochSeconds(time)
}

/** 数值兜底：非有限值 → 0。 */
function toFinite(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 把 K 线时间戳对齐到「当前周期网格」：`floor(time / step) * step`（step = 周期秒数）。
 *
 * 为什么需要：后端各数据源的历史 bar 起点并不保证落在同一网格上（典型：IBKR 的 4h bar 按交易所
 * 会话时间对齐，与前端 UTC 4h 网格相差 2 小时），历史与实时混排时会出现「同周期却有两根 K 线」
 * 或间距不均 → 图表错位 / 断点。统一对齐后，同周期的历史与实时 K 线会归并到同一根。
 * 已对齐的数据是恒等变换（1m / 5m / 15m / 1h / 1d 不受影响）。
 */
export function alignKlineToInterval(kline: Kline, interval?: Interval | number): Kline {
  const step = typeof interval === 'number' ? Math.floor(interval) : intervalToSeconds(String(interval ?? '1m'))
  if (!Number.isFinite(step) || step < 1) return kline
  const aligned = Math.floor(kline.time / step) * step
  if (aligned <= 0 || aligned === kline.time) return kline
  return { ...kline, time: aligned }
}

/**
 * 归一化单根 K 线：
 * - 时间戳统一为 10 位 Unix 秒（毫秒自动换算，非数字 / <= 0 视为非法）；
 * - OHLC 转有限数并保证 high ≥ open/close ≥ low；volume 不为负；
 * - 传入 interval 时把时间戳对齐到周期网格（见 alignKlineToInterval）；
 * - 非法行（无时间 / OHLC 非正）返回 null，由调用方丢弃。
 */
export function normalizeKline(row: Kline | null | undefined, interval?: Interval | number): Kline | null {
  if (!row) return null
  const time = toEpochSeconds(row.time)
  const open = toFinite(row.open)
  const high = toFinite(row.high)
  const low = toFinite(row.low)
  const close = toFinite(row.close)
  if (!time || !(open > 0) || !(high > 0) || !(low > 0) || !(close > 0)) return null
  const bar: Kline = {
    time,
    open,
    high: Math.max(high, open, close),
    low: Math.min(low, open, close),
    close,
    volume: Math.max(0, toFinite(row.volume)),
  }
  return interval === undefined ? bar : alignKlineToInterval(bar, interval)
}

/**
 * 归一化整表（图表 `setData()` 的唯一数据来源）：
 * 1. 过滤非法行（time 非数字 / <= 0、OHLC 不合法）；
 * 2. 相同 time 去重 —— **保留最后一条**（Map.set 按输入顺序覆盖），保证与后端最新快照一致；
 * 3. 按 time 升序排序 —— 输出无重复、无乱序（lightweight-charts 要求严格升序）；
 * 4. 传入 interval 时统一按周期网格对齐（避免历史 / 实时网格不一致导致的错位与断点）。
 */
export function normalizeKlines(rows: readonly Kline[] | null | undefined, interval?: Interval | number): Kline[] {
  if (!Array.isArray(rows)) return []
  const seen = new Map<number, Kline>()
  for (const row of rows) {
    const kline = normalizeKline(row, interval)
    if (kline) seen.set(kline.time, kline) // 后者覆盖前者：同 time 保留最后一条
  }
  return [...seen.values()].sort((a, b) => a.time - b.time)
}
