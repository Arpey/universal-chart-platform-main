import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { computeNextCandleOpenSec, formatBeijingClock, formatCountdown } from '../utils/candlestickCountdown'

/**
 * K 线收盘倒计时。
 * - 每秒刷新；定时器自校正并对齐整秒，避免固定 setInterval 累积漂移。
 * - interval / lastTimeSec 变化时立即重算（切换周期、新 K 线到达都会自动对齐）；
 *   回到前台（visibilitychange）时立即重算，避免后台节流造成显示滞后。
 * - 时间基准为 epoch（与数据源真实 K 线边界对齐），不受浏览器本地时区影响；
 *   targetClock 额外给出目标开盘时间的北京时间墙钟（Asia/Shanghai，UTC+8）用于展示。
 * - 组件卸载时自动清理定时器与监听，不留泄漏。
 */
export function useCountdown(interval: Ref<string>, lastTimeSec?: Ref<number | undefined>) {
  const remainingMs = ref(0)
  /** 目标边界（epoch 秒）：下一根 K 线开盘时间。 */
  const targetSec = ref(0)
  const countdown = computed(() => formatCountdown(remainingMs.value))
  /** 目标开盘时间的北京时间墙钟 "HH:MM:SS"（固定 +8h，与本地时区无关）。 */
  const targetClock = computed(() => formatBeijingClock(targetSec.value))

  let timer: ReturnType<typeof setTimeout> | null = null

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const tick = () => {
    const now = Date.now()
    const nextOpenSec = computeNextCandleOpenSec(interval.value, now, lastTimeSec?.value)
    targetSec.value = nextOpenSec
    remainingMs.value = Math.max(0, nextOpenSec * 1000 - now)
  }

  /** 自校正调度：每次 tick 后重新计算距下一个整秒的延迟，漂移不累积。 */
  const schedule = () => {
    const delay = 1000 - (Date.now() % 1000) + 1
    timer = setTimeout(() => {
      tick()
      schedule()
    }, delay)
  }

  const start = () => {
    clear()
    tick()
    schedule()
  }

  /** 浏览器在后台会节流/挂起 setTimeout：切回前台时立即校准一次，无需等下一个周期。 */
  const onVisibilityChange = () => {
    if (!document.hidden) tick()
  }

  const lastRef = lastTimeSec ?? ref<number | undefined>(undefined)
  watch([interval, lastRef], start, { immediate: true })

  onBeforeUnmount(() => {
    clear()
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange)

  return { remainingMs, targetSec, countdown, targetClock }
}
