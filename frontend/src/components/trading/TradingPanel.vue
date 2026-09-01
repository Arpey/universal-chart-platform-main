<script setup lang="ts">
import OrderForm from './OrderForm.vue'
import PositionTable from './PositionTable.vue'
import OrderTable from './OrderTable.vue'
</script>

<template>
  <aside class="trading-panel">
    <OrderForm />
    <PositionTable />
    <OrderTable />
  </aside>
</template>

<style scoped>
/* 右侧交易面板：下单 + 持仓 + 挂单，整体随工作区滚动 */
.trading-panel {
  width: 320px;
  flex-shrink: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  background: var(--color-bg-secondary, #141925);
  border-left: 1px solid var(--color-border, #1e293b);
}
</style>
