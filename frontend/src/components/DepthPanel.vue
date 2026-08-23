<script setup lang="ts">
import { computed } from 'vue'
import type { Dom, Quote } from '../types'

const props = defineProps<{ dom?: Dom; quote?: Quote; symbol: string }>()

/** 买卖档位（各取前 12 档） */
const bids = computed(() => props.dom?.levels.filter((l) => l.side === 'Bid').sort((a, b) => b.price - a.price).slice(0, 12) ?? [])
const asks = computed(() => props.dom?.levels.filter((l) => l.side === 'Ask').sort((a, b) => a.price - b.price).slice(0, 12) ?? [])

/** 深度条缩放基准（档位量最大值） */
const maxSize = computed(() => {
  const all = [...bids.value, ...asks.value]
  let max = 1
  for (const l of all) if (l.size > max) max = l.size
  return max
})

const bestBid = computed(() => bids.value[0]?.price)
const bestAsk = computed(() => asks.value[0]?.price)
const spread = computed(() => (bestBid.value != null && bestAsk.value != null ? bestAsk.value - bestBid.value : null))
const last = computed(() => props.quote?.last ?? (props.dom ? props.dom.levels[0]?.price : undefined))
const mid = computed(() => {
  if (props.quote?.last != null) return props.quote.last
  if (bestBid.value != null && bestAsk.value != null) return (bestBid.value + bestAsk.value) / 2
  return undefined
})

const fmt = (v?: number | null, digits = 2) => (v == null ? '--' : v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }))
function barWidth(size: number): string {
  return `${Math.max(4, Math.round((size / maxSize.value) * 100))}%`
}
</script>

<template>
  <div class="depth-panel">
    <header class="dp-head">
      <b>{{ symbol }}</b>
      <span class="dp-mid" :class="quote?.last != null ? (quote.last >= (quote.bid ?? 0) ? 'up' : 'down') : ''">
        {{ fmt(mid, 2) }}
      </span>
      <span v-if="spread != null" class="dp-spread">点差 {{ fmt(spread, 2) }}</span>
    </header>

    <div class="dp-grid dp-head-row">
      <span>价格</span><span>挂单量</span>
    </div>

    <div class="dp-asks">
      <div
        v-for="lvl in [...asks].reverse()"
        :key="`a-${lvl.price}`"
        class="dp-row ask"
      >
        <span class="dp-bar ask" :style="{ width: barWidth(lvl.size) }"></span>
        <span class="dp-price">{{ fmt(lvl.price, 2) }}</span>
        <span class="dp-size">{{ lvl.size.toLocaleString() }}</span>
      </div>
    </div>

    <div class="dp-sep">
      <span v-if="bestBid != null && bestAsk != null" class="dp-spread-line">
        {{ fmt(bestAsk, 2) }} · 点差 {{ fmt(spread, 2) }} · {{ fmt(bestBid, 2) }}
      </span>
      <span v-else class="dp-empty">等待盘口数据…</span>
    </div>

    <div class="dp-bids">
      <div v-for="lvl in bids" :key="`b-${lvl.price}`" class="dp-row bid">
        <span class="dp-bar bid" :style="{ width: barWidth(lvl.size) }"></span>
        <span class="dp-price">{{ fmt(lvl.price, 2) }}</span>
        <span class="dp-size">{{ lvl.size.toLocaleString() }}</span>
      </div>
    </div>

    <footer class="dp-foot" v-if="last != null">最新成交价 {{ fmt(last, 2) }}</footer>
  </div>
</template>

<style scoped>
.depth-panel { display: flex; flex-direction: column; height: 100%; min-height: 300px; background: var(--color-bg-primary); font-size: 12px; }
.dp-head { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--color-border, #1e293b); }
.dp-head b { color: var(--color-text, #e8edf3); }
.dp-mid { font-family: monospace; font-size: 15px; font-weight: 700; }
.dp-spread { color: #8090a5; font-size: 11px; }
.dp-head-row { color: #8090a5; font-size: 10px; }
.dp-grid { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 4px 12px; }
.dp-asks, .dp-bids { flex: 1; min-height: 0; overflow-y: auto; padding: 0 12px; }
.dp-row { position: relative; display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px; padding: 1px 4px; font-family: monospace; }
.dp-row .dp-size { text-align: right; color: #8090a5; }
.dp-bar { position: absolute; left: 0; top: 50%; transform: translateY(-50%); height: 70%; border-radius: 2px; opacity: 0.22; pointer-events: none; }
.dp-bar.ask { background: #ef534f; }
.dp-bar.bid { background: #26a69a; }
.dp-price { position: relative; }
.dp-row.ask .dp-price { color: #ef534f; }
.dp-row.bid .dp-price { color: #26a69a; }
.dp-sep { display: flex; align-items: center; justify-content: center; padding: 5px 12px; border-top: 1px solid var(--color-border, #1e293b); border-bottom: 1px solid var(--color-border, #1e293b); }
.dp-spread-line { font-family: monospace; color: #7dd3fc; }
.dp-empty { color: #8090a5; font-size: 11px; }
.dp-foot { padding: 5px 12px; border-top: 1px solid var(--color-border, #1e293b); color: #8090a5; font-family: monospace; font-size: 11px; }
.up { color: #26a69a; }
.down { color: #ef534f; }
</style>
