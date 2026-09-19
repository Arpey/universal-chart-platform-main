<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useTradingStore } from '../stores/tradingStore'

/**
 * 账户面板（TradingView 深色风格）。
 * - 顶部 4 个指标：余额 / 权益 / 可用保证金 / 浮动盈亏；
 * - 下方持仓表格：品种 / 方向 / 数量 / 均价 / 现价 / 盈亏；
 * - 数据取自 tradingStore.accountSummary 与 tradingStore.positions，
 *   挂载后立即刷新并每 3 秒轮询，卸载时清理定时器。
 */
const POLL_INTERVAL_MS = 3000

const trading = useTradingStore()

/** 账户资金汇总（未连接 / 未拉取时为 null） */
const account = computed(() => trading.accountSummary)
/** 浮动盈亏：持仓未实现盈亏合计（账户汇总接口不单独返回该字段） */
const floatingPnl = computed(() => trading.totalUnrealizedPnL)

let timer: number | null = null

onMounted(() => {
  void trading.refreshAccount()
  timer = window.setInterval(() => { void trading.refreshAccount() }, POLL_INTERVAL_MS)
})

onUnmounted(() => {
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
})

/** 金额格式化：千分位 + 两位小数（非数值回退 '--'）。 */
function fmt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '--'
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 盈亏格式化：正值补 '+' 号。 */
function fmtSigned(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '--'
  return `${value > 0 ? '+' : ''}${fmt(value)}`
}

/** 数量格式化：整数不带小数位。 */
function fmtQty(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '--'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/** 盈亏配色类：正绿 / 负红 / 零与无效值中性。 */
function pnlClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return 'flat'
  return value > 0 ? 'up' : 'down'
}

/** 方向显示：BUY → 多，SELL → 空。 */
function sideText(side: string): string {
  return side === 'BUY' ? '多' : '空'
}
</script>

<template>
  <section class="account-panel">
    <!-- 顶部 4 个资金指标 -->
    <div class="ap-metrics">
      <div class="ap-metric">
        <span class="ap-label">余额</span>
        <span class="ap-value">{{ fmt(account?.balance) }}</span>
      </div>
      <div class="ap-metric">
        <span class="ap-label">权益</span>
        <span class="ap-value">{{ fmt(account?.equity) }}</span>
      </div>
      <div class="ap-metric">
        <span class="ap-label">可用保证金</span>
        <span class="ap-value">{{ fmt(account?.freeMargin) }}</span>
      </div>
      <div class="ap-metric">
        <span class="ap-label">浮动盈亏</span>
        <span class="ap-value" :class="pnlClass(floatingPnl)">{{ fmtSigned(floatingPnl) }}</span>
      </div>
    </div>

    <!-- 持仓表格 -->
    <div class="ap-table-wrap">
      <table class="ap-table">
        <thead>
          <tr>
            <th>品种</th>
            <th>方向</th>
            <th class="num">数量</th>
            <th class="num">均价</th>
            <th class="num">现价</th>
            <th class="num">盈亏</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in trading.positions" :key="p.symbol">
            <td class="ap-symbol" :title="p.symbol">{{ p.symbol || '--' }}</td>
            <td :class="p.side === 'BUY' ? 'up' : 'down'">{{ sideText(p.side) }}</td>
            <td class="num">{{ fmtQty(p.qty) }}</td>
            <td class="num">{{ fmt(p.entryPrice) }}</td>
            <td class="num">{{ fmt(p.markPrice) }}</td>
            <td class="num" :class="pnlClass(p.pnl)">{{ fmtSigned(p.pnl) }}</td>
          </tr>
          <tr v-if="trading.positions.length === 0">
            <td class="ap-empty" colspan="6">暂无持仓</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
/* TradingView 深色配色：背景 #131722 / 分隔线 #2a2e39 / 涨 #26a69a / 跌 #ef5350 */
.account-panel {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #131722;
  border-bottom: 1px solid #2a2e39;
  color: #d1d4dc;
  font-size: 12px;
}

/* ---- 顶部指标区（2 × 2 网格，用 1px 间隙模拟分隔线） ---- */
.ap-metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  background: #2a2e39;
}
.ap-metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  background: #131722;
}
.ap-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: #787b86;
}
.ap-value {
  font-family: monospace;
  font-size: 13px;
  font-weight: 700;
  color: #d1d4dc;
}

/* ---- 持仓表格 ---- */
.ap-table-wrap {
  max-height: 178px;
  overflow-y: auto;
}
.ap-table {
  width: 100%;
  border-collapse: collapse;
}
.ap-table th {
  position: sticky;
  top: 0;
  padding: 6px 8px;
  background: #131722;
  border-bottom: 1px solid #2a2e39;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: #787b86;
  text-align: left;
  white-space: nowrap;
}
.ap-table td {
  padding: 6px 8px;
  border-bottom: 1px solid #2a2e39;
  white-space: nowrap;
}
.ap-table tbody tr:last-child td {
  border-bottom: none;
}
.ap-table tbody tr:hover {
  background: #1e222d;
}
.ap-symbol {
  font-family: monospace;
  font-weight: 600;
  color: #d1d4dc;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ap-table .num {
  text-align: right;
  font-family: monospace;
}
.ap-empty {
  padding: 14px 0;
  text-align: center;
  color: #787b86;
}

/* ---- 涨跌配色 ---- */
.up { color: #26a69a; }
.down { color: #ef5350; }
.flat { color: #d1d4dc; }
</style>
