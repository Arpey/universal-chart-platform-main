<script setup lang="ts">
import { useMarketStore } from '../stores/marketStore'
import type { Source } from '../types'

const market = useMarketStore()

/** 切换分类：全部合约 / Tradefi。 */
function pick(id: Source) {
  market.switchSource(id)
}
</script>

<template>
  <div class="src-switch" title="数据源分类：全部合约（Binance U 本位全量） / Tradefi（白名单品种）">
    <button
      v-for="s in market.availableSources"
      :key="s.id"
      class="src-btn"
      :class="{ active: market.currentSource === s.id }"
      @click="pick(s.id)"
    >{{ s.label }}</button>
  </div>
</template>

<style scoped>
.src-switch { display: flex; gap: 2px; }
.src-btn {
  padding: 4px 8px; background: transparent; color: var(--color-text-muted, #8090a5);
  border: 1px solid var(--color-border, #1e293b); border-radius: 4px;
  font-size: 10px; font-weight: 700; cursor: pointer; text-transform: uppercase;
  white-space: nowrap;
}
.src-btn:hover { color: var(--color-text, #e8edf3); border-color: #3b82f6; }
.src-btn.active { background: rgba(59, 130, 246, 0.14); color: #3b82f6; border-color: #3b82f6; }
</style>