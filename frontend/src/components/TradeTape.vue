<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { TradeTick } from '../types'

const props = defineProps<{ trades: TradeTick[]; symbol: string }>()

const listRef = ref<HTMLElement>()
/** 最多展示 150 条，性能与可读性平衡 */
const rows = computed(() => props.trades.slice(0, 150))

/** 新数据到达时滚动到底部（最新成交） */
watch(rows, async () => {
  await nextTick()
  const el = listRef.value
  if (el) el.scrollTop = el.scrollHeight
})

const fmtPrice = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtTime = (t: number) => {
  const d = new Date(t)
  return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}
const sideClass = (s: TradeTick['side']) => (s === 'Buy' ? 'buy' : s === 'Sell' ? 'sell' : '')
</script>

<template>
  <div class="tape-panel">
    <header class="tp-head"><b>{{ symbol }}</b><span class="tp-count">最近 {{ rows.length }} 笔</span></header>
    <div class="tp-grid tp-head-row"><span>时间</span><span>价格</span><span>数量</span></div>
    <div ref="listRef" class="tp-list">
      <div v-for="(t, i) in rows" :key="t.timestamp + '-' + i" class="tp-row" :class="sideClass(t.side)">
        <span class="tp-time">{{ fmtTime(t.timestamp) }}</span>
        <span class="tp-price">{{ fmtPrice(t.price) }}</span>
        <span class="tp-size">{{ t.size.toLocaleString() }}</span>
      </div>
      <div v-if="!rows.length" class="tp-empty">等待逐笔成交数据…</div>
    </div>
  </div>
</template>

<style scoped>
.tape-panel { display: flex; flex-direction: column; height: 100%; min-height: 300px; background: var(--color-bg-primary); font-size: 12px; }
.tp-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--color-border, #1e293b); }
.tp-head b { color: var(--color-text, #e8edf3); }
.tp-count { color: #8090a5; font-size: 11px; }
.tp-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; padding: 4px 12px; }
.tp-head-row { color: #8090a5; font-size: 10px; }
.tp-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 12px; font-family: monospace; }
.tp-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; padding: 1px 4px; }
.tp-time { color: #8090a5; }
.tp-price { color: #e8edf3; }
.tp-size { text-align: right; color: #8090a5; }
.tp-row.buy .tp-price { color: #26a69a; }
.tp-row.sell .tp-price { color: #ef534f; }
.tp-empty { padding: 24px 0; text-align: center; color: #8090a5; font-family: sans-serif; }
</style>
