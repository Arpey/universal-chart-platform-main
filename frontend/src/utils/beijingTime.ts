/**
 * 北京时间（Asia/Shanghai，UTC+8，无夏令时）时间渲染工具。
 *
 * 所有「人眼可读」的时间戳（K 线 X 轴刻度、十字光标时间、vline 时间轴标签、
 * Tick 流成交时间、K 线收盘倒计时目标墙钟等）都必须经本模块统一换算，
 * 通过显式 +8h 固定偏移后在 UTC getter 上读取墙钟，与浏览器/客户端本地时区完全无关。
 *
 * 换算原则：不修改数据源时间戳本身（K 线边界永远以交易所 epoch 网格为准），
 * 仅在「渲染展示」环节把 epoch 时间戳转成北京时间墙钟字符串。
 */

/** 北京时间固定偏移：+8 小时（毫秒）。Asia/Shanghai 无夏令时。 */
export const BEIJING_UTC_OFFSET_MS = 8 * 60 * 60 * 1000
/** 北京时间固定偏移：+8 小时（秒）。 */
export const BEIJING_UTC_OFFSET_SEC = 8 * 60 * 60

/**
 * 兼容 epoch 毫秒（>= 1e12）与 epoch 秒两种单位 → epoch 秒。
 * 与 TradingChart / DrawingPrimitive 的既有归一化逻辑保持一致。
 */
export function toEpochSeconds(t: number): number {
  const n = Number(t)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

/**
 * 兼容 epoch 毫秒 / 秒两种单位 → epoch 毫秒。
 */
export function toEpochMs(t: number): number {
  const n = Number(t)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n >= 1e12 ? Math.floor(n) : Math.floor(n * 1000)
}

/**
 * 将 epoch 时间戳平移 +8h，得到「读 UTC getter 即北京时间墙钟」的 Date 对象。
 * 兼容秒 / 毫秒两种输入单位。
 */
export function beijingDateOf(epochSecOrMs: number): Date | null {
  const ms = toEpochMs(epochSecOrMs)
  if (ms <= 0) return null
  return new Date(ms + BEIJING_UTC_OFFSET_MS)
}

/** 兼容 lightweight-charts 的 Time（number 秒 | BusinessDay | ISO 字符串）→ epoch 秒。 */
export function timeLikeToEpochSec(time: unknown): number | null {
  if (typeof time === 'number') {
    if (!Number.isFinite(time) || time <= 0) return null
    return time >= 1e12 ? Math.floor(time / 1000) : Math.floor(time)
  }
  if (typeof time === 'string') {
    const n = Date.parse(time) / 1000
    return Number.isNaN(n) ? null : n
  }
  if (time && typeof time === 'object') {
    const bd = time as { year?: number; month?: number; day?: number }
    if (bd.year != null && bd.month != null && bd.day != null) {
      return Math.floor(Date.UTC(bd.year, bd.month - 1, bd.day) / 1000)
    }
  }
  return null
}

const pad = (v: number) => String(v).padStart(2, '0')

/**
 * 北京时间墙钟 "HH:MM:SS"。非法输入返回 "--:--:--"。
 * @param epochSecOrMs 兼容秒 / 毫秒。
 */
export function formatBeijingClock(epochSecOrMs: number): string {
  const d = beijingDateOf(epochSecOrMs)
  if (!d) return '--:--:--'
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/**
 * 北京时间日期 "YYYY-MM-DD"。
 */
export function formatBeijingDate(epochSecOrMs: number): string {
  const d = beijingDateOf(epochSecOrMs)
  if (!d) return '----'
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/**
 * 北京时间日期+时间 "YYYY-MM-DD HH:mm"（可带秒）。
 */
export function formatBeijingDateTime(epochSecOrMs: number, withSeconds = false): string {
  const d = beijingDateOf(epochSecOrMs)
  if (!d) return '----'
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  return withSeconds ? `${base}:${pad(d.getUTCSeconds())}` : base
}

/** 紧凑 "MM-DD HH:mm"（用于图表时间轴 / vline 标签，与既有视觉宽度一致）。 */
export function formatBeijingShort(epochSecOrMs: number): string {
  const d = beijingDateOf(epochSecOrMs)
  if (!d) return '--:--'
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}
