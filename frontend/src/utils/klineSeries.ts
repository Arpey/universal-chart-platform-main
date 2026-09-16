import type { Kline } from '../types'
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
 * 归一化单根 K 线：
 * - 时间戳统一为 10 位 Unix 秒（毫秒自动换算）；
 * - OHLC 转有限数并保证 high ≥ open/close ≥ low；volume 不为负；
 * - 非法行（无时间 / OHLC 非正）返回 null，由调用方丢弃。
 */
export function normalizeKline(row: Kline | null | undefined): Kline | null {
  if (!row) return null
  const time = toEpochSeconds(row.time)
  const open = toFinite(row.open)
  const high = toFinite(row.high)
  const low = toFinite(row.low)
  const close = toFinite(row.close)
  if (!time || !(open > 0) || !(high > 0) || !(low > 0) || !(close > 0)) return null
  return {
    time,
    open,
    high: Math.max(high, open, close),
    low: Math.min(low, open, close),
    close,
    volume: Math.max(0, toFinite(row.volume)),
  }
}

/** 归一化整表：过滤非法行 → 同 time 去重（后者覆盖）→ 按 time 升序（满足 setData 的严格有序要求）。 */
export function normalizeKlines(rows: readonly Kline[] | null | undefined): Kline[] {
  if (!Array.isArray(rows)) return []
  const seen = new Map<number, Kline>()
  for (const row of rows) {
    const kline = normalizeKline(row)
    if (kline) seen.set(kline.time, kline)
  }
  return [...seen.values()].sort((a, b) => a.time - b.time)
}
