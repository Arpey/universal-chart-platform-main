<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useMarketStore } from '../../stores/marketStore'
import { useTradingStore } from '../../stores/tradingStore'
import type { BrokerType, OrderParams, OrderSide, OrderType } from '../../types/trading'

const market = useMarketStore()
const trading = useTradingStore()

const BROKERS: { id: BrokerType; label: string }[] = [
  { id: 'MOCK', label: 'Mock 模拟盘' },
  { id: 'TRADOVATE', label: 'Tradovate 期货' },
  { id: 'IBKR', label: 'IBKR（占位）' },
]

const side = ref<OrderSide>('BUY')
const orderType = ref<OrderType>('MARKET')
const qty = ref(1)
const price = ref<number | null>(null)
const stopLoss = ref<number | null>(null)
const takeProfit = ref<number | null>(null)
const connecting = ref(false)
const submitting = ref(false)
const errorMsg = ref('')
const successMsg = ref('')

const isLimit = computed(() => orderType.value === 'LIMIT')
const busy = computed(() => connecting.value || submitting.value)
const symbol = computed(() => trading.activeSymbol || market.symbol)
const brokerLabel = computed(() => BROKERS.find((b) => b.id === trading.currentBrokerType)?.label ?? trading.currentBrokerType)

// 交易品种单向同步：行情侧选中品种 → tradingStore.activeSymbol（仅此一处跨模块触点）
watch(() => market.symbol, (s) => trading.setActiveSymbol(s), { immediate: true })

// 挂载即连接默认 Broker（MOCK 开箱即用）
onMounted(() => {
  if (!trading.isConnected) void connectCurrent()
})

/** 以最新价填充限价委托价。 */
function fillFromMarket() {
  const last = market.ticker?.price
  if (last && last > 0) price.value = last
}

async function connectCurrent() {
  connecting.value = true
  errorMsg.value = ''
  successMsg.value = ''
  try {
    await trading.connectBroker()
    successMsg.value = `已连接 ${brokerLabel.value}`
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    connecting.value = false
  }
}

async function onBrokerChange(type: BrokerType) {
  connecting.value = true
  errorMsg.value = ''
  successMsg.value = ''
  try {
    await trading.switchBroker(type)
    await trading.connectBroker()
    successMsg.value = `已连接 ${BROKERS.find((b) => b.id === type)?.label ?? type}`
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    connecting.value = false
  }
}

async function submit() {
  if (!symbol.value) { errorMsg.value = '请先选择交易品种'; return }
  if (!(qty.value > 0)) { errorMsg.value = '数量必须大于 0'; return }
  if (isLimit.value && !(price.value && price.value > 0)) { errorMsg.value = '限价单必须填写委托价'; return }
  if (!trading.isConnected) { errorMsg.value = 'Broker 未连接，请先连接'; return }

  const params: OrderParams = {
    symbol: symbol.value,
    side: side.value,
    type: orderType.value,
    qty: qty.value,
  }
  if (isLimit.value && price.value) params.price = price.value
  if (stopLoss.value && stopLoss.value > 0) params.stopLoss = stopLoss.value
  if (takeProfit.value && takeProfit.value > 0) params.takeProfit = takeProfit.value

  submitting.value = true
  errorMsg.value = ''
  successMsg.value = ''
  try {
    const order = await trading.submitOrder(params)
    successMsg.value = `下单成功：${order.side} ${order.qty} ${order.symbol}${order.price ? ` @ ${order.price}` : ' 市价'}`
    if (order.status === 'FILLED') qty.value = 1
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="order-form">
    <header class="of-header">
      <b>下单 · Order</b>
      <span class="of-symbol" :title="'交易品种：' + symbol">{{ symbol || '--' }}</span>
    </header>

    <div class="of-row">
      <label class="of-label">Broker</label>
      <div class="of-broker">
        <select :value="trading.currentBrokerType" :disabled="busy" @change="onBrokerChange(($event.target as HTMLSelectElement).value as BrokerType)">
          <option v-for="b in BROKERS" :key="b.id" :value="b.id">{{ b.label }}</option>
        </select>
        <span class="conn" :class="trading.isConnected ? 'ok' : 'err'">{{ trading.isConnected ? '● 已连接' : '● 未连接' }}</span>
      </div>
    </div>

    <div class="of-row">
      <label class="of-label">方向</label>
      <div class="of-side">
        <button type="button" class="side-btn buy" :class="{ active: side === 'BUY' }" @click="side = 'BUY'">做多 BUY</button>
        <button type="button" class="side-btn sell" :class="{ active: side === 'SELL' }" @click="side = 'SELL'">做空 SELL</button>
      </div>
    </div>

    <div class="of-row">
      <label class="of-label">类型</label>
      <div class="of-type">
        <button type="button" class="type-btn" :class="{ active: orderType === 'MARKET' }" @click="orderType = 'MARKET'">市价</button>
        <button type="button" class="type-btn" :class="{ active: orderType === 'LIMIT' }" @click="orderType = 'LIMIT'">限价</button>
      </div>
    </div>

    <div class="of-row">
      <label class="of-label" for="of-qty">数量（张 / 手）</label>
      <input id="of-qty" v-model.number="qty" type="number" min="1" step="1" class="of-input" />
    </div>

    <div v-if="isLimit" class="of-row">
      <label class="of-label" for="of-price">委托价</label>
      <div class="of-price">
        <input id="of-price" v-model.number="price" type="number" min="0" step="0.01" class="of-input" placeholder="0.00" />
        <button type="button" class="fill-btn" :disabled="!market.ticker" @click="fillFromMarket">当前价</button>
      </div>
    </div>

    <div class="of-row of-grid">
      <div>
        <label class="of-label" for="of-sl">止损</label>
        <input id="of-sl" v-model.number="stopLoss" type="number" min="0" step="0.01" class="of-input" placeholder="可选" />
      </div>
      <div>
        <label class="of-label" for="of-tp">止盈</label>
        <input id="of-tp" v-model.number="takeProfit" type="number" min="0" step="0.01" class="of-input" placeholder="可选" />
      </div>
    </div>

    <div v-if="errorMsg" class="of-msg err">{{ errorMsg }}</div>
    <div v-else-if="successMsg" class="of-msg ok">{{ successMsg }}</div>

    <button
      type="button"
      class="of-submit"
      :class="side === 'BUY' ? 'buy' : 'sell'"
      :disabled="busy || !trading.isConnected"
      @click="submit"
    >
      {{ submitting ? '提交中…' : side === 'BUY' ? '买入 / 开多' : '卖出 / 开空' }}
    </button>
  </div>
</template>

<style scoped>
.order-form {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border, #1e293b);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.of-header {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 12px; font-weight: 700; letter-spacing: 0.4px; color: var(--color-text, #e8edf3);
}
.of-symbol {
  font-family: monospace; font-size: 11px; font-weight: 700;
  color: #3b82f6; background: rgba(59, 130, 246, 0.12);
  padding: 2px 7px; border-radius: 4px; max-width: 160px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.of-row { display: flex; flex-direction: column; gap: 4px; }
.of-grid { flex-direction: row; gap: 8px; }
.of-grid > div { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.of-label { font-size: 10px; font-weight: 600; color: var(--color-text-muted, #8090a5); letter-spacing: 0.3px; }
.of-input {
  width: 100%; height: 28px; padding: 0 8px;
  background: var(--color-bg-tertiary, #242b34);
  border: 1px solid var(--color-border, #1e293b); border-radius: 5px;
  color: #e8edf3; font-size: 12px; font-family: monospace; outline: none;
}
.of-input:focus { border-color: #3b82f6; }
.of-broker { display: flex; align-items: center; gap: 8px; }
.of-broker select {
  flex: 1; height: 28px; padding: 0 6px;
  background: var(--color-bg-tertiary, #242b34);
  border: 1px solid var(--color-border, #1e293b); border-radius: 5px;
  color: #e8edf3; font-size: 12px; outline: none;
}
.conn { font-size: 11px; font-weight: 600; white-space: nowrap; }
.conn.ok { color: #26a69a; }
.conn.err { color: #ef534f; }
.of-side { display: flex; gap: 6px; }
.side-btn {
  flex: 1; height: 30px; border-radius: 5px; cursor: pointer;
  border: 1px solid var(--color-border, #1e293b);
  background: var(--color-bg-tertiary, #242b34);
  color: var(--color-text-muted, #8090a5); font-size: 12px; font-weight: 700;
}
.side-btn.buy.active { background: rgba(38, 166, 154, 0.16); color: #26a69a; border-color: #26a69a; }
.side-btn.sell.active { background: rgba(239, 83, 79, 0.16); color: #ef534f; border-color: #ef534f; }
.of-type { display: flex; gap: 6px; }
.type-btn {
  flex: 1; height: 26px; border-radius: 4px; cursor: pointer;
  border: 1px solid var(--color-border, #1e293b);
  background: transparent; color: var(--color-text-muted, #8090a5); font-size: 12px; font-weight: 600;
}
.type-btn.active { background: rgba(59, 130, 246, 0.14); color: #3b82f6; border-color: #3b82f6; }
.of-price { display: flex; gap: 6px; }
.of-price .of-input { flex: 1; }
.fill-btn {
  height: 28px; padding: 0 10px; flex-shrink: 0; cursor: pointer;
  background: var(--color-bg-tertiary, #242b34); color: #3b82f6;
  border: 1px solid var(--color-border, #1e293b); border-radius: 5px; font-size: 11px; font-weight: 600;
}
.fill-btn:hover { border-color: #3b82f6; }
.fill-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.of-msg { font-size: 11px; line-height: 1.4; padding: 5px 8px; border-radius: 4px; word-break: break-all; }
.of-msg.err { background: rgba(127, 29, 29, 0.5); color: #fecaca; }
.of-msg.ok { background: rgba(6, 78, 59, 0.5); color: #a7f3d0; }
.of-submit {
  height: 32px; border: none; border-radius: 5px; cursor: pointer;
  font-size: 13px; font-weight: 800; letter-spacing: 0.5px; color: #fff;
}
.of-submit.buy { background: #089981; }
.of-submit.buy:hover { background: #0aa88c; }
.of-submit.sell { background: #f23645; }
.of-submit.sell:hover { background: #f64553; }
.of-submit:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
