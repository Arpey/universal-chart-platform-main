<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useMarketStore } from '../../stores/marketStore'
import { useTradingStore } from '../../stores/tradingStore'
import type { BrokerType, OrderSide } from '../../types/trading'

/**
 * 直连下单面板（统一交易入口）。
 *
 * 下单链路统一走 tradingStore → IBrokerAdapter（Broker 由顶部下拉框切换）：
 * - TRADOVATE_PLAYWRIGHT: 直连本地 Playwright 下单微服务（pushOrder/app.py，默认 http://localhost:8000）；
 * - MOCK / TRADOVATE / IBKR: 其余适配器实现。
 * 组件自身不再直连任何交易服务，只消费 store 的标准化状态与方法。
 */
const BROKERS: { id: BrokerType; label: string }[] = [
  { id: 'TRADOVATE_PLAYWRIGHT', label: 'Tradovate 直连' },
  { id: 'MOCK', label: 'Mock 模拟盘' },
  { id: 'TRADOVATE', label: 'Tradovate 网关' },
  { id: 'IBKR', label: 'IBKR（占位）' },
]

type StatusKind = 'idle' | 'pending' | 'success' | 'error'

const market = useMarketStore()
const trading = useTradingStore()

/** 品种输入框：默认取当前图表品种，图表切换时自动跟随（仍可手动改成 Root 合约，如 MES） */
const symbolInput = ref<string>(market.symbol)
const qtyInput = ref<number>(1)
const statusKind = ref<StatusKind>('idle')
const statusText = ref<string>('')
const pendingAction = ref<OrderSide | null>(null)
const switching = ref(false)

const busy = computed(() => pendingAction.value !== null || switching.value)
const canSend = computed(
  () => !busy.value && trading.isConnected && symbolInput.value.trim().length > 0
    && Number.isFinite(Number(qtyInput.value)) && Number(qtyInput.value) > 0,
)

// 图表品种变化 → 同步到输入框
watch(
  () => market.symbol,
  (s) => {
    symbolInput.value = s
  },
)

// 挂载即连接当前 Broker（默认 MOCK 开箱即用），保证面板可直接下单
onMounted(() => {
  if (!trading.isConnected) void onBrokerChange(trading.currentBrokerType)
})

function brokerLabel(type: BrokerType): string {
  return BROKERS.find((b) => b.id === type)?.label ?? type
}

function describeError(err: unknown): string {
  if (err instanceof TypeError) return '网络错误：无法连接交易服务，请确认对应服务已启动'
  return err instanceof Error ? err.message : String(err)
}

/** 切换 Broker：销毁旧适配器 → 创建新适配器 → 立即连接并拉取初始数据。 */
async function onBrokerChange(type: BrokerType) {
  if (switching.value) return
  switching.value = true
  statusKind.value = 'pending'
  statusText.value = `连接中…（${brokerLabel(type)}）`
  try {
    await trading.switchBroker(type)
    await trading.connectBroker()
    statusKind.value = 'success'
    statusText.value = `已连接 ${brokerLabel(type)}`
  } catch (err) {
    statusKind.value = 'error'
    statusText.value = `失败：${describeError(err)}`
  } finally {
    switching.value = false
  }
}

/** 市价下单：统一经 tradingStore 派发到当前 Broker 适配器。 */
async function send(action: OrderSide) {
  if (busy.value) return

  const symbol = symbolInput.value.trim().toUpperCase()
  const qty = Math.floor(Number(qtyInput.value))
  if (!symbol) {
    statusKind.value = 'error'
    statusText.value = '失败：请先填写交易品种'
    return
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    statusKind.value = 'error'
    statusText.value = '失败：手数必须为正整数'
    return
  }
  if (!trading.isConnected) {
    statusKind.value = 'error'
    statusText.value = '失败：Broker 未连接，请先在上方选择并连接 Broker'
    return
  }

  pendingAction.value = action
  statusKind.value = 'pending'
  statusText.value = `下单中…（${action} ${symbol} × ${qty}）`

  try {
    const order = await trading.submitOrder({ symbol, side: action, type: 'MARKET', qty })
    statusKind.value = 'success'
    statusText.value = `成功：${order.side} ${order.symbol} × ${order.qty} 已提交（${order.orderId}）`
  } catch (err) {
    statusKind.value = 'error'
    statusText.value = `失败：${describeError(err)}`
  } finally {
    pendingAction.value = null
  }
}
</script>

<template>
  <div class="push-order-bar" :title="'当前 Broker：' + trading.currentBrokerType">
    <span class="po-title">⚡ 直连下单</span>

    <label class="po-field">
      <span class="po-label">Broker</span>
      <select
        class="po-input po-broker"
        :value="trading.currentBrokerType"
        :disabled="busy"
        @change="onBrokerChange(($event.target as HTMLSelectElement).value as BrokerType)"
      >
        <option v-for="b in BROKERS" :key="b.id" :value="b.id">{{ b.label }}</option>
      </select>
    </label>

    <label class="po-field">
      <span class="po-label">品种</span>
      <input
        v-model="symbolInput"
        class="po-input po-symbol"
        type="text"
        spellcheck="false"
        placeholder="MES"
        :disabled="busy"
      />
    </label>

    <label class="po-field">
      <span class="po-label">手数</span>
      <input v-model.number="qtyInput" class="po-input po-qty" type="number" min="1" step="1" :disabled="busy" />
    </label>

    <button type="button" class="po-btn buy" :disabled="!canSend" @click="send('BUY')">
      {{ pendingAction === 'BUY' ? '下单中…' : 'BUY' }}
    </button>
    <button type="button" class="po-btn sell" :disabled="!canSend" @click="send('SELL')">
      {{ pendingAction === 'SELL' ? '下单中…' : 'SELL' }}
    </button>

    <span class="po-status" :class="statusKind">{{ statusText || '等待下单…' }}</span>
  </div>
</template>

<style scoped>
/* 图表上方的横向下单条（不遮挡图表，属于独立布局行） */
.push-order-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 10px;
  background: var(--color-bg-secondary, #1a1f26);
  border-bottom: 1px solid var(--color-border, #1e293b);
  font-size: 12px;
  color: var(--color-text, #e8edf3);
}
.po-title {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.4px;
  color: #3b82f6;
  white-space: nowrap;
}
.po-field { display: inline-flex; align-items: center; gap: 4px; }
.po-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--color-text-muted, #8090a5);
  white-space: nowrap;
}
.po-input {
  height: 26px;
  padding: 0 8px;
  background: var(--color-bg-tertiary, #242b34);
  border: 1px solid var(--color-border, #1e293b);
  border-radius: 5px;
  color: #e8edf3;
  font-family: monospace;
  font-size: 12px;
  outline: none;
}
.po-input:focus { border-color: #3b82f6; }
.po-input:disabled { opacity: 0.5; cursor: not-allowed; }
.po-symbol { width: 96px; text-transform: uppercase; }
.po-qty { width: 62px; }
.po-broker { width: 150px; }
.po-btn {
  height: 26px;
  min-width: 62px;
  padding: 0 12px;
  border: none;
  border-radius: 5px;
  color: #fff;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.4px;
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
}
.po-btn.buy { background: #089981; }
.po-btn.buy:hover:not(:disabled) { background: #0aa88c; }
.po-btn.sell { background: #f23645; }
.po-btn.sell:hover:not(:disabled) { background: #f64553; }
.po-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.po-status {
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted, #8090a5);
}
.po-status.pending { color: #f0b90b; }
.po-status.success { color: #26a69a; }
.po-status.error { color: #ef534f; }

</style>
