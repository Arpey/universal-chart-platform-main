import type { Interval } from '../types'

/**
 * K 线周期映射表（前端唯一入口，与后端 `backend/src/core/intervals.ts` 一一对应）。
 *
 * 两边各写一份映射是「切换周期后 K 线数量/网格不一致」的常见根因，
 * 因此周期 → 秒数只在这里定义，其余模块（倒计时、网格对齐、历史请求）统一引用。
 */

/** 周期键（含预留 30m：映射表已支持，周期按钮暂未开放）。 */
export type IntervalKey = Interval | '30m'

/** 各周期对应的秒数（10 位 Unix 秒网格）。 */
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

/** 周期按钮 / 端到端已启用的周期（30m 暂未开放）。 */
export const SUPPORTED_INTERVALS: readonly Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d']

/** 周期（字符串）→ 秒数；未知周期回退 60s。 */
export function intervalSeconds(interval: string): number {
  return INTERVAL_SECONDS[interval as IntervalKey] ?? 60
}

/** 切换 symbol / interval 时预加载的历史 K 线根数（TradingView 风格：先铺满再衔接实时）。 */
export const HISTORY_BAR_LIMIT = 100
/** 历史根数上限（防止 ?limit=999999 打满后端 / 上游）。 */
export const HISTORY_BAR_LIMIT_MAX = 1000

/**
 * 解析历史 K 线根数：
 * - 显式传入（如设置项）优先；
 * - 否则读 URL 参数 `?limit=200`，便于临时调整 / 排查；
 * - 非法或缺失 → HISTORY_BAR_LIMIT（100）。
 */
export function resolveHistoryLimit(raw?: string | number | null): number {
  let candidate: unknown = raw
  if (candidate === undefined || candidate === null || candidate === '') {
    candidate = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('limit')
  }
  const n = Number(candidate)
  if (!Number.isFinite(n) || n <= 0) return HISTORY_BAR_LIMIT
  return Math.min(Math.floor(n), HISTORY_BAR_LIMIT_MAX)
}

/** 启动时解析一次（切换 symbol / interval 的历史预加载统一使用该值）。 */
export const HISTORY_BAR_LIMIT_RESOLVED = resolveHistoryLimit()
