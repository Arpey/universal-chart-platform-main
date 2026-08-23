<script setup lang="ts">
import { computed } from 'vue'
import type { MarketView } from '../types'

const props = defineProps<{ connected: boolean; count: number; datasource?: string; view?: MarketView }>()
const viewLabel = computed(() => ({ candlestick: 'K线', dom: '盘口', tick: 'Tick流' })[props.view ?? 'candlestick'])
</script>
<template><footer><span class="dot" :class="{ online: connected }"></span>{{ connected ? '实时连接' : '连接中断' }}<span class="muted">· {{ viewLabel }} · {{ count }} 根 K 线</span><span class="muted source">数据源 {{ datasource ?? 'Binance' }}</span></footer></template>
