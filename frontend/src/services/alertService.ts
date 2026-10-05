import type { Interval } from '../types'

/**
 * H2/L2 实时信号邮件提醒（前端调用层）。
 *
 * - 触发时机：K 线**收盘**且该根产生 H2/L2 信号（由 TradingChart 在换线时判定）；
 * - 双重开关：`VITE_ALERT_EMAIL_ENABLED`（构建期总开关）+ 指标面板的「邮件提醒」（运行期，见 `SignalAlertOptions`）；
 * - 去重：以 `symbol|timeframe|signalType|timestamp` 为键，同一根 Bar 的同一信号在静默窗口内只发一次，
 *   避免「重连 / 重复推送 / 同一次信号被多次调用」造成邮件轰炸；
 * - 失败降级：请求异常只 `console.warn`，绝不打断图表渲染（后端 `/api/notify/email` 未启用时属预期）。
 */

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'

/** 是否启用邮件提醒（VITE_ALERT_EMAIL_ENABLED=false 可整体关闭）。 */
const enabled = import.meta.env.VITE_ALERT_EMAIL_ENABLED !== 'false'
/** 同一信号的静默窗口（毫秒），默认 5 分钟。 */
const silenceMs = Number(import.meta.env.VITE_ALERT_EMAIL_SILENCE_MS ?? 300_000)

export type SignalAlertType = 'H2' | 'L2'

/** 后端 `POST /api/notify/email` 的请求体（与后端 NotifyEmailRequest 契约一致）。 */
export interface SignalAlertPayload {
  /** 交易对 / 品种（如 BTCUSDT / MES） */
  symbol: string
  /** 周期（如 1m / 5m / 1h） */
  timeframe: Interval
  /** 信号类型 */
  signalType: SignalAlertType
  /** 突破价格（H2 用该根最高价，L2 用该根最低价） */
  price: number
  /** 信号所在 K 线的开盘时间（10 位 Unix 秒） */
  timestamp: number
}

/** 已发送信号键 → 发送时间（epoch ms）。 */
const sentKeys = new Map<string, number>()

const keyOf = (payload: SignalAlertPayload): string =>
  `${payload.symbol}|${payload.timeframe}|${payload.signalType}|${payload.timestamp}`

/** 清理超出静默窗口的旧键，避免长时间运行下 Map 无限增长。 */
function pruneSentKeys(now: number): void {
  if (sentKeys.size <= 512) return
  for (const [key, at] of sentKeys) {
    if (now - at >= silenceMs) sentKeys.delete(key)
  }
}

/** 判断该信号是否应当发送（并登记发送时间）。同一根 Bar 只会返回一次 true。 */
function shouldSend(payload: SignalAlertPayload): boolean {
  const now = Date.now()
  const key = keyOf(payload)
  const last = sentKeys.get(key)
  if (last !== undefined && now - last < silenceMs) return false
  sentKeys.set(key, now)
  pruneSentKeys(now)
  return true
}

/** 发送选项。 */
export interface SignalAlertOptions {
  /**
   * 面板级开关（指标面板中的「邮件提醒」）。
   * 显式传 `false` 时直接跳过；不提供则仅受 `VITE_ALERT_EMAIL_ENABLED` 控制。
   */
  enabled?: boolean
}

/**
 * 发送 H2/L2 邮件提醒。
 * @param options.enabled 指标面板的邮件提醒开关（false → 不发送）
 * @returns 是否真正发出了请求（被去重 / 未启用 / 请求失败均为 false）
 */
export async function sendSignalAlert(
  payload: SignalAlertPayload,
  options: SignalAlertOptions = {},
): Promise<boolean> {
  if (!enabled) return false // 环境变量总开关（构建期关闭）
  if (options.enabled === false) return false // 面板级开关（运行期关闭）
  if (!Number.isFinite(payload.price) || payload.price <= 0) return false
  if (!shouldSend(payload)) return false
  try {
    const response = await fetch(`${apiUrl}/api/notify/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      let message: string | undefined
      try {
        message = ((await response.json()) as { message?: string })?.message
      } catch {
        /* 非 JSON 响应（如后端尚未提供该接口时的 404 HTML） */
      }
      console.warn('[alertService] 邮件提醒发送失败', message ?? `HTTP ${response.status}`)
      return false
    }
    return true
  } catch (error) {
    // 后端未启动 / 未实现该接口时属预期情况：只提示，不抛错、不打断图表
    console.warn('[alertService] 邮件提醒请求异常', error)
    return false
  }
}

/** 清空去重登记（切换标的 / 手动重算时可选调用）。 */
export function resetAlertState(): void {
  sentKeys.clear()
}
