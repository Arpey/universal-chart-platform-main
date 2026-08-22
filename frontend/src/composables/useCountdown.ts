import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { computeNextCandleOpenSec, formatCountdown } from '../utils/candlestickCountdown'

/**
 * K 线收盘倒计时。
 * - 每秒刷新；定时器自校正并对齐整秒，避免固定 setInterval 累积漂移。
 * - interval / lastTimeSec 变化时立即重算（切换周期、新 K 线到达都会自动对齐）。
 * - 组件卸载时自动清理定时器，不留泄漏。
 */
export function useCountdown(interval: Ref<string>, lastTimeSec?: Ref<number | undefined>) {
  const remainingMs = ref(0)
  const countdown = computed(() => formatCountdown(remainingMs.value))

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

  const lastRef = lastTimeSec ?? ref<number | undefined>(undefined)
  watch([interval, lastRef], start, { immediate: true })

  onBeforeUnmount(clear)

  return { remainingMs, countdown }
}
