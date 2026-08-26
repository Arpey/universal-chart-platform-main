<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useMarketStore } from '../stores/marketStore'
import { useSymbolRows } from '../composables/useSymbolRows'
import type { SymbolRow } from '../types'

type SourceTabId = 'all' | 'binance' | 'tradovate' | 'ibkr' | 'stocks' | 'forex'

/** 数据源/分类 Tab：Binance / Tradovate / IBKR 为真实数据源，其余为占位（空状态提示）。 */
const TABS: { id: SourceTabId; label: string; hint?: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'binance', label: 'Binance' },
  { id: 'tradovate', label: 'Tradovate' },
  { id: 'ibkr', label: 'IBKR' },
  { id: 'stocks', label: 'Stocks', hint: '暂无股票数据源接入' },
  { id: 'forex', label: 'Forex', hint: '暂无外汇数据源接入' },
]

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ close: [] }>()

const market = useMarketStore()
const { rows } = useSymbolRows()

const query = ref('')
const activeTab = ref<SourceTabId>('all')
const highlightIndex = ref(0)
const inputRef = ref<HTMLInputElement>()
const listRef = ref<HTMLElement>()

const isEmptyTab = computed(() => activeTab.value === 'stocks' || activeTab.value === 'forex')

/** 点击数据源 Tab：切换当前数据源（触发列表重新加载），保持 Tab 高亮同步。 */
function pickTab(id: SourceTabId) {
  activeTab.value = id
  if (id === 'tradovate' && market.datasource !== 'tradovate') market.setDatasource('tradovate')
  else if (id === 'binance' && market.datasource !== 'binance') market.switchSource('binance')
  else if (id === 'ibkr' && market.datasource !== 'ibkr') market.setDatasource('ibkr')
}

/** 按 Tab + 关键字（代码 symbol / 名称 baseAsset / 全名 name）过滤。 */
const filtered = computed<SymbolRow[]>(() => {
  if (isEmptyTab.value) return []
  let list = rows.value
  if (activeTab.value === 'binance') list = list.filter((r) => r.source === 'binance')
  if (activeTab.value === 'tradovate') list = list.filter((r) => r.source === 'tradovate')
  if (activeTab.value === 'ibkr') list = list.filter((r) => r.source === 'ibkr')
  const q = query.value.trim().toUpperCase()
  if (q) list = list.filter((r) => r.symbol.includes(q) || r.baseAsset.includes(q) || (r.name ?? '').toUpperCase().includes(q))
  return list
})

const sorted = computed(() => [...filtered.value].sort((a, b) => b.volume24h - a.volume24h).slice(0, 100))

watch(sorted, (list) => {
  if (highlightIndex.value >= list.length) highlightIndex.value = Math.max(0, list.length - 1)
})

const priceClass = (r: SymbolRow) => (r.change24h >= 0 ? 'up' : 'down')

function close() {
  open.value = false
  emit('close')
}

function select(row: SymbolRow) {
  market.setSymbol(row.symbol)
  close()
}

/** 键盘高亮移动（循环），并滚动到可见区域。 */
function move(dir: number) {
  const len = sorted.value.length
  if (!len) return
  highlightIndex.value = (highlightIndex.value + dir + len) % len
  nextTick(() => {
    const el = listRef.value?.querySelectorAll<HTMLElement>('.symbol-row')[highlightIndex.value]
    el?.scrollIntoView({ block: 'nearest' })
  })
}

/** 文档级键盘监听：仅在弹窗打开时挂载，关闭/卸载时移除，避免泄漏。 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    move(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    move(-1)
  } else if (e.key === 'Enter') {
    const row = sorted.value[highlightIndex.value]
    if (row) {
      e.preventDefault()
      select(row)
    }
  }
}

watch(open, (o) => {
  if (o) {
    highlightIndex.value = 0
    if (!market.symbols.length && !market.universeLoading) market.loadUniverse()
    nextTick(() => inputRef.value?.focus())
    window.addEventListener('keydown', onKeydown)
  } else {
    window.removeEventListener('keydown', onKeydown)
  }
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div v-show="open" class="symbol-modal">
    <div class="symbol-overlay" @click="close"></div>

    <div class="symbol-dialog" role="dialog" aria-modal="true">
      <header class="dlg-header">
        <div class="search-wrap">
          <span class="search-icon">⌕</span>
          <input
            ref="inputRef"
            v-model="query"
            class="search-input"
            type="text"
            placeholder="搜索代码 / 名称 (如 BTC, ETH)..."
            spellcheck="false"
          />
          <button class="close" title="关闭 (Esc)" @click="close">✕</button>
        </div>
        <div class="tabs">
          <button
            v-for="tab in TABS"
            :key="tab.id"
            class="tab"
            :class="{ active: activeTab === tab.id }"
            @click="pickTab(tab.id)"
          >{{ tab.label }}</button>
        </div>
      </header>

      <div class="dlg-body">
        <div class="list-head">
          <span class="count">{{ isEmptyTab ? activeTab : sorted.length }} 个标的</span>
          <span>现价</span>
          <span>24H 涨跌</span>
          <span>成交额</span>
        </div>

        <div v-if="market.universeError" class="list-state error">⚠️ {{ market.universeError }}</div>
        <div v-else-if="market.universeLoading && !rows.length" class="list-state loading">加载标的…</div>
        <div v-else-if="activeTab === 'ibkr' && !sorted.length" class="list-state muted">正在加载 IBKR CME 期货标的…</div>
        <div v-else-if="isEmptyTab" class="list-state muted">{{ TABS.find((t) => t.id === activeTab)?.hint }}</div>
        <div v-else-if="!sorted.length" class="list-state muted">没有匹配的标的</div>
        <ul v-else ref="listRef" class="symbol-list">
          <li
            v-for="(row, idx) in sorted"
            :key="row.symbol"
            class="symbol-row"
            :class="{ current: row.symbol === market.symbol, highlight: idx === highlightIndex }"
            @click="select(row)"
            @mousemove="highlightIndex = idx"
          >
            <span class="sym-name">
              <em>{{ row.baseAsset.slice(0, 4).toUpperCase() }}</em>
              <span class="sym-text">
                <b>{{ row.symbol }}</b>
                <small>{{ row.name ?? row.baseAsset }}</small>
              </span>
            </span>
            <span class="sym-badge">{{ row.source.toUpperCase() }}</span>
            <span class="sym-price" :class="priceClass(row)">{{ row.price ? row.price.toFixed(row.price < 0.01 ? 6 : 2) : '--' }}</span>
            <span class="sym-change" :class="priceClass(row)">{{ row.change24h >= 0 ? '+' : '' }}{{ row.change24h.toFixed(2) }}%</span>
            <span class="sym-vol">{{ (row.volume24h / 1000000).toFixed(1) }}M</span>
          </li>
        </ul>
      </div>

      <footer class="dlg-footer">
        <span>↑↓ 选择</span>
        <span>Enter 确认</span>
        <span>Esc 关闭</span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.symbol-modal { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
.symbol-overlay { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.55); }
.symbol-dialog {
  position: relative;
  width: 640px; max-width: 92vw; max-height: 74vh;
  display: flex; flex-direction: column;
  background: var(--color-bg-secondary, #141925);
  border: 1px solid var(--color-border, #1e293b);
  border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.dlg-header { padding: 12px 14px 0; border-bottom: 1px solid var(--color-border, #1e293b); }
.search-wrap { position: relative; display: flex; align-items: center; }
.search-icon { position: absolute; left: 12px; color: #8090a5; font-size: 15px; pointer-events: none; }
.search-input {
  flex: 1; height: 40px; padding: 0 40px 0 36px;
  background: var(--color-bg-tertiary, #242b34);
  border: 1px solid var(--color-border, #1e293b); border-radius: 8px;
  color: #e8edf3; font-size: 14px; outline: none;
}
.search-input:focus { border-color: #3b82f6; }
.close { position: absolute; right: 8px; background: none; border: none; color: #8090a5; font-size: 14px; cursor: pointer; }
.close:hover { color: #e8edf3; }

.tabs { display: flex; gap: 4px; padding: 10px 0 0; overflow-x: auto; }
.tab {
  padding: 6px 13px; font-size: 12px; font-weight: 700; letter-spacing: 0.3px; text-transform: uppercase;
  color: var(--color-text-muted, #8090a5); background: transparent;
  border: 1px solid transparent; border-bottom: none; border-radius: 7px 7px 0 0;
  cursor: pointer; white-space: nowrap;
}
.tab:hover { color: var(--color-text, #e8edf3); background: rgba(59, 130, 246, 0.06); }
.tab.active { color: #3b82f6; background: rgba(59, 130, 246, 0.12); border-color: var(--color-border, #1e293b); }

.dlg-body { flex: 1; min-height: 0; overflow-y: auto; }
.list-head {
  display: flex; gap: 14px; padding: 8px 14px; font-size: 11px; color: #8090a5;
  border-bottom: 1px solid var(--color-border, #1e293b);
}
.list-head .count { flex: 1; }
.list-head > span:not(.count) { width: 72px; text-align: right; }

.symbol-list { list-style: none; margin: 0; padding: 4px 0; }
.symbol-row { display: flex; gap: 14px; align-items: center; padding: 7px 14px; cursor: pointer; font-size: 13px; }
.symbol-row:hover { background: rgba(59, 130, 246, 0.06); }
.symbol-row.highlight { background: rgba(59, 130, 246, 0.14); }
.symbol-row.current .sym-text b { color: #3b82f6; }

.sym-name { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; }
.sym-name em {
  font-style: normal; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: 6px; background: var(--color-bg-tertiary, #242b34);
  color: #f0b90b; font-size: 10px; font-weight: 800; letter-spacing: 0.3px;
}
.sym-text { display: flex; flex-direction: column; line-height: 1.25; min-width: 0; }
.sym-text b { color: #e8edf3; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sym-text small { color: #8090a5; font-size: 11px; }
.sym-badge { flex-shrink: 0; width: 58px; font-size: 10px; font-weight: 700; color: #f0b90b; letter-spacing: 0.3px; }
.sym-price { flex-shrink: 0; width: 72px; text-align: right; font-family: monospace; color: #d1d5db; }
.sym-change { flex-shrink: 0; width: 66px; text-align: right; font-family: monospace; font-size: 12px; }
.sym-vol { flex-shrink: 0; width: 62px; text-align: right; font-family: monospace; color: #8090a5; font-size: 12px; }
.up { color: #26a69a; }
.down { color: #ef534f; }

.list-state { padding: 24px 14px; font-size: 13px; text-align: center; }
.list-state.error { color: #fecaca; }
.list-state.loading { color: #8090a5; }
.list-state.muted { color: #8090a5; }

.dlg-footer {
  display: flex; gap: 18px; padding: 8px 14px; font-size: 11px; color: #8090a5;
  border-top: 1px solid var(--color-border, #1e293b); background: var(--color-bg-secondary, #141925);
}
</style>
