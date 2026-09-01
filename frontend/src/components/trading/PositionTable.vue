<script setup lang="ts">
import { ref } from 'vue'
import { useTradingStore } from '../../stores/tradingStore'
import type { Position } from '../../types/trading'

const trading = useTradingStore()
const errMsg = ref('')

const sideLabel = (p: Position) => (p.side === 'BUY' ? '多' : '空')
const sideClass = (p: Position) => (p.side === 'BUY' ? 'up' : 'down')
const pnlClass = (n: number) => (n >= 0 ? 'up' : 'down')
const fmt = (n?: number, digits = 2) =>
  n == null || !Number.isFinite(n) ? '--' : n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

async function close(symbol: string) {
  errMsg.value = ''
  try {
    await trading.closePosition(symbol)
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : String(e)
  }
}
</script>

<template>
  <section class="pos-table">
    <header class="pt-header">
      <b>持仓 · Positions</b>
      <span class="pt-count">{{ trading.positions.length }}</span>
    </header>
    <div v-if="trading.positions.length === 0" class="pt-empty">暂无持仓</div>
    <div v-else class="pt-body">
      <table>
        <thead>
          <tr><th>合约</th><th>方向</th><th>数量</th><th>开仓价</th><th>标记价</th><th>未实现盈亏</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="p in trading.positions" :key="p.symbol">
            <td class="mono">{{ p.symbol }}</td>
            <td :class="sideClass(p)">{{ sideLabel(p) }}</td>
            <td class="mono">{{ p.qty }}</td>
            <td class="mono">{{ fmt(p.entryPrice) }}</td>
            <td class="mono">{{ fmt(p.markPrice) }}</td>
            <td :class="pnlClass(p.pnl)">{{ p.pnl >= 0 ? '+' : '' }}{{ fmt(p.pnl) }}</td>
            <td><button type="button" class="close-btn" @click="close(p.symbol)">平仓</button></td>
          </tr>
        </tbody>
      </table>
      <div v-if="errMsg" class="pt-err">{{ errMsg }}</div>
    </div>
  </section>
</template>

<style scoped>
.pos-table { border-bottom: 1px solid var(--color-border, #1e293b); display: flex; flex-direction: column; }
.pt-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 9px 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.4px;
  color: var(--color-text, #e8edf3); border-bottom: 1px solid var(--color-border, #1e293b);
}
.pt-count { color: #8090a5; font-size: 11px; font-weight: 600; }
.pt-empty { padding: 16px 12px; text-align: center; color: var(--color-text-muted, #5b6470); font-size: 12px; }
.pt-body { overflow-x: auto; padding: 6px 0; }
.pos-table table { width: 100%; border-collapse: collapse; font-size: 11px; }
.pos-table th, .pos-table td { padding: 4px 6px; text-align: right; white-space: nowrap; }
.pos-table th { color: var(--color-text-muted, #8090a5); font-weight: 600; }
.pos-table td:first-child, .pos-table th:first-child { text-align: left; padding-left: 12px; }
.pos-table td:last-child, .pos-table th:last-child { padding-right: 12px; }
.mono { font-family: monospace; }
.up { color: #26a69a; }
.down { color: #ef534f; }
.close-btn {
  padding: 2px 8px; cursor: pointer; font-size: 11px; font-weight: 600;
  color: #f23645; background: rgba(242, 54, 69, 0.12);
  border: 1px solid rgba(242, 54, 69, 0.35); border-radius: 4px;
}
.close-btn:hover { background: rgba(242, 54, 69, 0.22); }
.pt-err { margin: 0 12px 8px; padding: 5px 8px; font-size: 11px; border-radius: 4px; background: rgba(127, 29, 29, 0.5); color: #fecaca; }
</style>
