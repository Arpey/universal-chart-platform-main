<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMarketStore } from '../stores/marketStore'
import { useSymbolRows } from '../composables/useSymbolRows'
import type { SymbolRow } from '../types'

const market = useMarketStore()
const { rows } = useSymbolRows()
const query = ref('')

/** 常驻右侧 Watchlist：与弹窗共用同一数据源；高亮当前标的，点击即切换图表。 */
const list = computed(() => {
  let items = rows.value
  const q = query.value.trim().toUpperCase()
  if (q) items = items.filter((r) => r.symbol.includes(q) || r.baseAsset.includes(q))
  return [...items].sort((a, b) => b.volume24h - a.volume24h)
})

const priceClass = (r: SymbolRow) => (r.change24h >= 0 ? 'up' : 'down')
</script>

<template>
  <aside class="watchlist">
    <header class="wl-header">
      <b>自选 · Watchlist</b>
      <span class="wl-count">{{ list.length }}</span>
    </header>
    <div class="wl-search">
      <input v-model="query" type="text" placeholder="过滤代码 / 名称..." spellcheck="false" />
    </div>
    <ul class="wl-list">
      <li
        v-for="row in list"
        :key="row.symbol"
        class="wl-row"
        :class="{ active: row.symbol === market.symbol }"
        @click="market.setSymbol(row.symbol)"
      >
        <em>{{ row.baseAsset.slice(0, 4).toUpperCase() }}</em>
        <span class="wl-name">
          <b>{{ row.symbol }}</b>
          <small>{{ row.baseAsset }}</small>
        </span>
        <span class="wl-price" :class="priceClass(row)">{{ row.price ? row.price.toFixed(row.price < 1 ? 4 : 2) : '--' }}</span>
        <span class="wl-change" :class="priceClass(row)">{{ row.change24h >= 0 ? '+' : '' }}{{ row.change24h.toFixed(2) }}%</span>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.watchlist {
  width: 250px; flex-shrink: 0; min-height: 0; display: flex; flex-direction: column;
  background: var(--color-bg-secondary, #141925);
  border-left: 1px solid var(--color-border, #1e293b);
}
.wl-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.4px;
  color: var(--color-text, #e8edf3); border-bottom: 1px solid var(--color-border, #1e293b);
}
.wl-count { color: #8090a5; font-size: 11px; font-weight: 600; }
.wl-search { padding: 8px 10px; border-bottom: 1px solid var(--color-border, #1e293b); }
.wl-search input {
  width: 100%; height: 30px; padding: 0 10px;
  background: var(--color-bg-tertiary, #242b34);
  border: 1px solid var(--color-border, #1e293b); border-radius: 6px;
  color: #e8edf3; font-size: 12px; outline: none;
}
.wl-search input:focus { border-color: #3b82f6; }
.wl-list { flex: 1; min-height: 0; overflow-y: auto; list-style: none; margin: 0; padding: 4px 0; }
.wl-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; font-size: 12px; }
.wl-row:hover { background: rgba(59, 130, 246, 0.06); }
.wl-row.active { background: rgba(59, 130, 246, 0.14); }
.wl-row em {
  font-style: normal; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 5px; background: var(--color-bg-tertiary, #242b34);
  color: #f0b90b; font-size: 9px; font-weight: 800; letter-spacing: 0.3px;
}
.wl-name { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
.wl-name b { color: #e8edf3; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wl-name small { color: #8090a5; font-size: 10px; }
.wl-price { flex-shrink: 0; font-family: monospace; font-size: 11px; }
.wl-change { flex-shrink: 0; min-width: 52px; text-align: right; font-family: monospace; font-size: 11px; }
.up { color: #26a69a; }
.down { color: #ef534f; }
</style>
