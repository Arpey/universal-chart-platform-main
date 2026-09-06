<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { intervalToSeconds } from '../utils/candlestickCountdown'
import type { MarketView } from '../types'

const props = defineProps<{
  connected: boolean
  count: number
  datasource?: string
  view?: MarketView
  interval?: string
  /** 最近一次收到行情数据的时间（epoch ms）；0 表示尚无数据。 */
  lastDataAt?: number
}>()
const viewLabel = computed(() => ({ candlestick: 'K线', dom: '盘口', tick: 'Tick流' })[props.view ?? 'candlestick'])

// ---- 休市/低流动性静默检测：连接正常但长时间没有新行情时不显示"断开"，而是给出明确提示 ----
const nowMs = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => { timer = setInterval(() => { nowMs.value = Date.now() }, 10_000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

/** 判定"静默"的阈值：≥3 个 K 线周期且 ≥90s（防止活跃但稀疏的成交流被误判），上限 30 分钟（尽快识别休市）。 */
const idle = computed(() => {
  if (!props.connected || !props.lastDataAt) return false
  const sec = intervalToSeconds(props.interval ?? '1m')
  const thresholdMs = Math.min(Math.max(sec * 3, 90) * 1000, 30 * 60_000)
  return nowMs.value - props.lastDataAt > thresholdMs
})
</script>
<template>
  <footer><span class="dot" :class="{ online: connected }"></span>{{ connected ? '实时连接' : '连接中断' }}<span class="muted">· {{ viewLabel }} · {{ count }} 根 K 线</span><span class="muted source">数据源 {{ datasource ?? 'Binance' }}</span><span v-if="connected && idle" class="idle" title="连接与心跳正常，但近期没有收到新的行情推送（TradFi/大宗商品周末或夜间休市属正常现象，恢复交易后自动续推）">· 已连接 · 无新行情（可能休市）</span></footer></template>
