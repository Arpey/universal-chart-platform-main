import type { Interval } from '../types'

/** 各 K 线周期对应的秒数。K 线边界严格对齐各数据源/交易所的真实结算点（epoch 网格），与浏览器本地时区无关。 */
export const INTERVAL_SECONDS: Record<Interval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
}

/** 北京时间（Asia/Shanghai，UTC+8，无夏令时）。仅用于墙钟文本的展示转换，不参与 K 线边界计算。 */
export const BEIJING_UTC_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * 时间戳统一归一化为「秒」：
 * - epoch 毫秒（>= 1e12，如 IBKR 实时/历史 K 线）→ 向下取整 ÷ 1000；
 * - epoch 秒（Binance / Tradovate 等）→ 原样取整。
 * 与 TradingChart.toUTCTime / DrawingPrimitive.setKlines 的既有归一逻辑保持一致，
 * 避免「毫秒 vs 秒」混用导致倒计时爆表或错位。
 */
export function toEpochSeconds(t: number): number {
  const n = Number(t)
  return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n)
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

/**
 * 将任意 epoch 时间戳渲染为北京时间墙钟 "HH:MM:SS"。
 * 通过显式的 +8h 固定偏移（Asia/Shanghai 无夏令时）在 UTC getter 上完成换算，
 * 与用户电脑/浏览器的本地时区设置完全无关。
 * @param epochSecOrMs 兼容秒 / 毫秒两种单位。
 */
export function formatBeijingClock(epochSecOrMs: number): string {
  if (!Number.isFinite(epochSecOrMs) || epochSecOrMs <= 0) return '--:--:--'
  const ms = epochSecOrMs < 1e12 ? epochSecOrMs * 1000 : epochSecOrMs
  const d = new Date(ms + BEIJING_UTC_OFFSET_MS)
  const p = (v: number) => String(v).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}
