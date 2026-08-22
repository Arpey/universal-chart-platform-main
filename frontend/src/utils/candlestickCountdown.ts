import type { Interval } from '../types'

/** 各 K 线周期对应的秒数。币安 K 线时间即 UTC 边界对齐（1d 为 UTC 0 点开盘）。 */
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
 * 计算下一根 K 线的开盘时间（UTC 秒）。
 * - 优先以服务器推送的最新 K 线开盘时间对齐（lastTimeSec + 周期），
 *   与币安 UTC 边界天然一致，不受客户端时钟偏移影响；
 * - 无数据或数据明显滞后（候选早于当前周期起点）时回退到客户端时钟对齐，保证倒计时不失效。
 */
export function computeNextCandleOpenSec(interval: string, nowMs: number, lastTimeSec?: number): number {
  const sec = intervalToSeconds(interval)
  const nowSec = nowMs / 1000
  if (lastTimeSec != null && Number.isFinite(lastTimeSec)) {
    const candidate = lastTimeSec + sec
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
