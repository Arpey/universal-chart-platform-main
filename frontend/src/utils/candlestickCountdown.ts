import type { Interval } from '../types'
// 北京时间换算工具统一收敛在 utils/beijingTime.ts；此处仅做 API 兼容转发，
// 旧调用方（useCountdown 等）无需改动即可继续使用既有导出。
import { BEIJING_UTC_OFFSET_MS, formatBeijingClock, formatBeijingDate, formatBeijingDateTime, formatBeijingShort, toEpochMs, toEpochSeconds } from './beijingTime'
export { BEIJING_UTC_OFFSET_MS, toEpochSeconds } from './beijingTime'
export { formatBeijingClock, formatBeijingDate, formatBeijingDateTime, formatBeijingShort, toEpochMs } from './beijingTime'

/** 各 K 线周期对应的秒数。K 线边界严格对齐各数据源/交易所的真实结算点（epoch 网格），与浏览器本地时区无关。 */
export const INTERVAL_SECONDS: Record<Interval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
}

export function intervalToSeconds(interval: string): number {
  return INTERVAL_SECONDS[interval as Interval] ?? 60
}

/**
 * 计算下一根 K 线的开盘时间（epoch 秒）。
 * - 优先以服务器推送的最新 K 线开盘时间对齐（归一化为秒后 + 周期），
 *   与数据源/交易所真实边界天然一致，倒计时不受客户端时钟偏移或本地时区影响；
 * - 无数据或数据明显滞后（候选早于当前周期起点）时回退到客户端时钟对齐的 epoch 网格，
 *   保证倒计时不失效（真实数据到达后立即重新对齐）。
 */
export function computeNextCandleOpenSec(interval: string, nowMs: number, lastTimeSec?: number): number {
  const sec = intervalToSeconds(interval)
  const nowSec = nowMs / 1000
  if (lastTimeSec != null && Number.isFinite(lastTimeSec)) {
    // 兼容毫秒/秒两种时间戳单位（IBKR 下发毫秒、Binance 下发秒）
    const anchor = toEpochSeconds(lastTimeSec)
    const candidate = anchor + sec
    if (candidate > nowSec - sec) return candidate
  }
  return Math.ceil(nowSec / sec) * sec
}

/** 剩余毫秒 → "MM:SS"（<1h）或 "HH:MM:SS"（≥1h）。 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  if (h > 0) return `${String(h).padStart(2, '0')}:${mm}:${ss}`
  return `${mm}:${ss}`
}
