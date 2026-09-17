import type { Interval } from '../types/kline'

/**
 * K 线周期映射表（后端唯一入口，与前端 `src/constants/intervals.ts` 一一对应）。
 *
 * 放在共享文件里的原因：周期 → 秒数 / IBKR barSizeSetting / IBKR durationStr 三张表
 * 一旦两边（或两处）各写一份，切换周期时就会出现「请求的周期与实际拉取的周期不一致」，
 * 表现为 K 线断点、错位或数量不足。
 */

/** 周期键（含预留 30m：映射表已支持，前端周期按钮暂未开放）。 */
export type IntervalKey = Interval | '30m'

/** 各周期对应的秒数（10 位 Unix 秒网格；与前端 INTERVAL_SECONDS 保持一致）。 */
export const INTERVAL_SECONDS: Record<IntervalKey, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
}

/** 映射表支持的全部周期（含 30m）。 */
export const INTERVAL_KEYS: readonly IntervalKey[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d']

/** 当前端到端已启用的周期（30m 暂未开放：前端周期按钮 / 聚合器均未启用）。 */
export const SUPPORTED_INTERVALS: readonly Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d']

/** 周期（字符串）→ 秒数；未知周期回退 60s。 */
export function intervalSeconds(interval: string): number {
  return INTERVAL_SECONDS[interval as IntervalKey] ?? 60
}

/** 周期字符串是否为当前端到端支持的周期（REST / WS 参数校验用）。 */
export function isInterval(value: string): value is Interval {
  return (SUPPORTED_INTERVALS as readonly string[]).includes(value)
}

/** 各周期对应的 IBKR barSizeSetting（reqHistoricalData 的 barSize 参数原文）。 */
export const IBKR_BAR_SIZE: Record<IntervalKey, string> = {
  '1m': '1 min',
  '5m': '5 mins',
  '15m': '15 mins',
  '30m': '30 mins',
  '1h': '1 hour',
  '4h': '4 hours',
  '1d': '1 day',
}

/**
 * IBKR durationStr 下限（按周期）：保证即使上游有休市 / 缺口也能取满 HISTORY_BAR_LIMIT 根。
 * 1m/5m → 2 D；15m/30m → 5 D；1h → 1 W；4h → 1 M；1d → 1 Y。
 */
export const IBKR_HISTORY_DURATION: Record<IntervalKey, string> = {
  '1m': '2 D',
  '5m': '2 D',
  '15m': '5 D',
  '30m': '5 D',
  '1h': '1 W',
  '4h': '1 M',
  '1d': '1 Y',
}

/**
 * IBKR durationStr 上限（按周期）：IBKR 对每个 barSize 的回看窗口有硬上限，
 * 超出会直接报错（历史数据请求失败），因此放大窗口时必须封顶。
 */
export const IBKR_HISTORY_MAX_SECONDS: Record<IntervalKey, number> = {
  '1m': 2 * 86400,
  '5m': 2 * 86400,
  '15m': 7 * 86400,
  '30m': 7 * 86400,
  '1h': 30 * 86400,
  '4h': 30 * 86400,
  '1d': 365 * 86400,
}

/** 秒数 → IBKR durationStr 文本（按 D / W / M / Y 取最贴切单位并向上取整）。 */
function formatIbkrDuration(seconds: number): string {
  const day = 86400
  if (seconds >= 360 * day) return `${Math.ceil(seconds / (360 * day))} Y`
  if (seconds >= 28 * day) return `${Math.ceil(seconds / (30 * day))} M`
  if (seconds >= 7 * day) return `${Math.ceil(seconds / (7 * day))} W`
  return `${Math.max(1, Math.ceil(seconds / day))} D`
}

/**
 * 按周期 + 需要的根数计算 IBKR durationStr：
 * - 下限取 {@link IBKR_HISTORY_DURATION}（保证 ≥ HISTORY_BAR_LIMIT 根）；
 * - 需要的根数更多时按 `limit × step × 1.5`（含休市/缺口余量）放大；
 * - 上限封顶在 {@link IBKR_HISTORY_MAX_SECONDS}，避免触发 IBKR「duration 超出 barSize 上限」报错。
 */
export function ibkrHistoryDuration(interval: string, limit: number): string {
  const key = interval as IntervalKey
  const step = intervalSeconds(interval)
  const minSeconds = parseIbkrDurationSeconds(IBKR_HISTORY_DURATION[key] ?? '2 D')
  const needed = Math.max(1, limit) * step * 1.5
  const ceiling = IBKR_HISTORY_MAX_SECONDS[key] ?? 2 * 86400
  const seconds = Math.min(Math.max(minSeconds, needed), Math.max(minSeconds, ceiling))
  return formatIbkrDuration(seconds)
}

/** IBKR durationStr（如 '2 D' / '1 W' / '1 M' / '1 Y'）→ 秒数；无法解析时回退 2 D。 */
export function parseIbkrDurationSeconds(duration: string): number {
  const m = /^(\d+)\s*([SMWDY])$/i.exec(duration.trim())
  if (!m) return 2 * 86400
  const value = Number(m[1])
  const unit = m[2].toUpperCase()
  // Y 按 360 天（与 formatIbkrDuration 的换算保持一致），M 按 30 天
  const unitSeconds =
    unit === 'S' ? 1
      : unit === 'D' ? 86400
        : unit === 'W' ? 7 * 86400
          : unit === 'M' ? 30 * 86400
            : 360 * 86400
  return Number.isFinite(value) && value > 0 ? value * unitSeconds : 2 * 86400
}

/** 切换 symbol / interval 时预加载的历史 K 线根数（TradingView 风格：先铺满再衔接实时）。 */
export const HISTORY_BAR_LIMIT = 100
/** 历史 K 线根数上限（避免恶意构造 limit=999999 打满上游）。 */
export const HISTORY_BAR_LIMIT_MAX = 1000

/** 解析并夹取历史 K 线根数（缺省 / 非法 → HISTORY_BAR_LIMIT）。 */
export function resolveHistoryLimit(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return HISTORY_BAR_LIMIT
  return Math.min(Math.floor(n), HISTORY_BAR_LIMIT_MAX)
}
