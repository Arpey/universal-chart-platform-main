<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTradingStore } from '../../stores/tradingStore'
import type { Order } from '../../types/trading'

const trading = useTradingStore()
const errMsg = ref('')

/** 仅展示活跃挂单（PENDING）。 */
const activeOrders = computed(() => trading.orders.filter((o) => o.status === 'PENDING'))

const typeLabel: Record<Order['type'], string> = { MARKET: '市价', LIMIT: '限价', STOP: '止损' }
const sideLabel = (o: Order) => (o.side === 'BUY' ? '买' : '卖')
const sideClass = (o: Order) => (o.side === 'BUY' ? 'up' : 'down')
const fmt = (n: number | null | undefined) => (n == null ? '--' : String(n))

async function cancel(orderId: string) {
  errMsg.value = ''
  try {
    await trading.cancelOrder(orderId)
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : String(e)
  }
}
</script>

<template>
  <section class="order-table">
    <header class="ot-header">
      <b>挂单 · Orders</b>
      <span class="ot-count">{{ activeOrders.length }}</span>
    </header>
    <div v-if="activeOrders.length === 0" class="ot-empty">暂无活跃挂单</div>
    <div v-else class="ot-body">
      <table>
        <thead>
          <tr><th>合约</th><th>方向</th><th>类型</th><th>数量</th><th>价格</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="o in activeOrders" :key="o.orderId">
            <td class="mono">{{ o.symbol }}</td>
            <td :class="sideClass(o)">{{ sideLabel(o) }}</td>
            <td>{{ typeLabel[o.type] }}</td>
            <td class="mono">{{ o.qty }}</td>
            <td class="mono">{{ fmt(o.price) }}</td>
            <td><button type="button" class="cancel-btn" @click="cancel(o.orderId)">撤单</button></td>
          </tr>
        </tbody>
      </table>
      <div v-if="errMsg" class="ot-err">{{ errMsg }}</div>
    </div>
  </section>
</template>

<style scoped>
.order-table { display: flex; flex-direction: column; }
.ot-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 9px 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.4px;
  color: var(--color-text, #e8edf3); border-bottom: 1px solid var(--color-border, #1e293b);
}
.ot-count { color: #8090a5; font-size: 11px; font-weight: 600; }
.ot-empty { padding: 16px 12px; text-align: center; color: var(--color-text-muted, #5b6470); font-size: 12px; }
.ot-body { overflow-x: auto; padding: 6px 0; }
.order-table table { width: 100%; border-collapse: collapse; font-size: 11px; }
.order-table th, .order-table td { padding: 4px 6px; text-align: right; white-space: nowrap; }
.order-table th { color: var(--color-text-muted, #8090a5); font-weight: 600; }
.order-table td:first-child, .order-table th:first-child { text-align: left; padding-left: 12px; }
.order-table td:last-child, .order-table th:last-child { padding-right: 12px; }
.mono { font-family: monospace; }
.up { color: #26a69a; }
.down { color: #ef534f; }
.cancel-btn {
  padding: 2px 8px; cursor: pointer; font-size: 11px; font-weight: 600;
  color: #8090a5; background: transparent;
  border: 1px solid var(--color-border, #1e293b); border-radius: 4px;
}
.cancel-btn:hover { color: #f23645; border-color: #f23645; }
.ot-err { margin: 0 12px 8px; padding: 5px 8px; font-size: 11px; border-radius: 4px; background: rgba(127, 29, 29, 0.5); color: #fecaca; }
</style>
