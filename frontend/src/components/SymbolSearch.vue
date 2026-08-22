<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useMarketStore } from '../stores/marketStore'
import type { SymbolRow } from '../types'

const emit = defineEmits<{ close: [] }>()
const market = useMarketStore()

const query = ref('')
const open = defineModel<boolean>('open', { default: false })

/** 合并交易对基础信息与实时行情 */
const rows = computed<SymbolRow[]>(() => {
  const t = new Map(market.tickers.map((x) => [x.symbol, x]))
  return market.symbols.map((s) => {
    const tick = t.get(s.symbol)
    return { ...s, price: tick?.price ?? 0, change24h: tick?.change24h ?? 0, volume24h: tick?.volume24h ?? 0 }
  })
})

const filtered = computed(() => {
  const q = query.value.trim().toUpperCase()
  if (!q) return rows.value
  return rows.value.filter((r) => r.symbol.includes(q) || r.baseAsset.includes(q))
})

const sorted = computed(() => {
  // TradingView 风格：按 24h 成交额降序（活跃合约靠前）
  return [...filtered.value].sort((a, b) => b.volume24h - a.volume24h).slice(0, 100)
})

const priceClass = (r: SymbolRow) => r.change24h >= 0 ? 'up' : 'down'

function select(row: SymbolRow) {
  market.setSymbol(row.symbol)
  open.value = false
  emit('close')
}

function handleKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { open.value = false; emit('close') }
}

onMounted(() => { if (!market.symbols.length) market.loadUniverse() })
</script>

<template>
  <div v-show="open" class="symbol-search" @keydown="handleKey">
    <div class="search-overlay" @click="open = false; emit('close')"></div>
    <aside class="search-panel">
      <header class="search-header">
        <div class="search-input-wrap">
          <span class="search-icon">⌕</span>
          <input
            v-model="query"
            class="search-input"
            placeholder="搜索交易对 (如 BTC, ETH)..."
            autofocus
            spellcheck="false"
          />
          <button class="close" @click="open = false; emit('close')">✕</button>
        </div>
      </header>

      <div class="search-body">
        <div class="search-tabs">
          <span class="tab active">永续合约 · USDT</span>
        </div>

        <div class="list-head">
          <span><b @click="query=''">全部交易对</b>（{{ filtered.length }}）</span>
          <span>24H 涨跌</span>
          <span>成交额</span>
        </div>

        <div v-if="market.universeError" class="list-error">⚠️ {{ market.universeError }}</div>
        <div v-else-if="market.universeLoading && !rows.length" class="list-loading">加载交易对…</div>
        <ul v-else class="symbol-list">
          <li
            v-for="row in sorted"
            :key="row.symbol"
            class="symbol-row"
            :class="{ active: row.symbol === market.symbol }"
            @click="select(row)"
          >
            <span class="sym-name">
              <em>{{ row.baseAsset.slice(0, 4).toUpperCase() }}</em>
              <b>{{ row.symbol }}</b>
            </span>
            <span class="sym-price" :class="priceClass(row)">{{ row.price ? row.price.toFixed(row.price < 0.01 ? 6 : 2) : '--' }}</span>
            <span class="sym-change" :class="priceClass(row)">{{ row.change24h >= 0 ? '+' : '' }}{{ row.change24h.toFixed(2) }}%</span>
            <span class="sym-vol">{{ (row.volume24h / 1000000).toFixed(1) }}M</span>
          </li>
        </ul>
      </div>
    </aside>
  </div>
</template>


<style scoped>
.symbol-search { position: fixed; inset: 0; z-index: 100; display: flex; justify-content: flex-end; }
.search-overlay { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.5); }
.search-panel {
  position: relative; width: 420px; max-width: 90vw; height: 100%;
  background: var(--color-bg-secondary, #141925);
  border-left: 1px solid var(--color-border, #1e293b);
  display: flex; flex-direction: column;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.4);
}
.search-header { padding: 14px; border-bottom: 1px solid var(--color-border, #1e293b); }
.search-input-wrap { position: relative; display: flex; align-items: center; }
.search-icon { position: absolute; left: 12px; color: #8090a5; font-size: 16px; }
.search-input {
  flex: 1; height: 38px; padding: 0 40px 0 34px;
  background: var(--color-bg-tertiary, #242b34);
  border: 1px solid var(--color-border, #1e293b); border-radius: 6px;
  color: #e8edf3; font-size: 13px; outline: none;
}
.search-input:focus { border-color: #3b82f6; }
.search-input::placeholder { color: #8090a5; }
.close { position: absolute; right: 8px; background: none; border: none; color: #8090a5; font-size: 14px; cursor: pointer; }
.search-body { flex: 1; overflow-y: auto; }
.search-tabs { padding: 12px 14px 8px; }
.tab { font-size: 11px; font-weight: 700; color: #8090a5; text-transform: uppercase; letter-spacing: 0.5px; }
.tab.active { color: #3b82f6; }
.list-head {
  display: grid; grid-template-columns: 1fr auto auto; gap: 12px;
  padding: 8px 14px; font-size: 11px; color: #8090a5; border-bottom: 1px solid var(--color-border, #1e293b);
}
.list-head b { cursor: pointer; color: #8090a5; }
.list-error, .list-loading { padding: 20px 14px; font-size: 12px; color: #fecaca; }
.list-loading { color: #8090a5; }
.symbol-list { list-style: none; margin: 0; padding: 6px 0; }
.symbol-row {
  display: grid; grid-template-columns: 1fr auto auto auto; gap: 12px; align-items: center;
  padding: 9px 14px; cursor: pointer; font-size: 13px;
}
.symbol-row:hover { background: rgba(59, 130, 246, 0.08); }
.symbol-row.active { background: rgba(59, 130, 246, 0.14); }
.sym-name { display: flex; align-items: center; gap: 8px; }
.sym-name em {
  font-style: normal; display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: 6px; background: var(--color-bg-tertiary, #242b34);
  color: #3b82f6; font-size: 10px; font-weight: 800; letter-spacing: 0.5px;
}
.sym-price { font-family: monospace; color: #d1d5db; font-size: 13px; }
.sym-change { font-family: monospace; font-size: 12px; min-width: 58px; text-align: right; }
.sym-vol { font-family: monospace; color: #8090a5; font-size: 12px; min-width: 62px; text-align: right; }
.up { color: #26a69a; }
.down { color: #ef534f; }
</style>
