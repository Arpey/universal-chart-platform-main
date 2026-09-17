<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMarketStore } from '../../stores/marketStore'

/**
 * 直连下单面板（Tradovate DOM 仿真下单入口）。
 *
 * 与 tradingStore 的 Mock / 网关链路（/api/trading）相互独立：
 * 这里直接 POST 本地 Playwright 下单微服务 pushOrder/app.py 的 /webhook，
 * 端口必须与该文件的 PORT 一致（默认 8000），可用 VITE_PUSH_ORDER_URL 覆盖。
 */
const PUSH_ORDER_BASE = (import.meta.env?.VITE_PUSH_ORDER_URL ?? 'http://localhost:8000').replace(/\/+$/, '')
/** 单次下单请求超时（毫秒）：后端最多等待「按钮 10s + 成交确认 5s」，留足余量。 */
const REQUEST_TIMEOUT_MS = 60000

type PushAction = 'BUY' | 'SELL'
type StatusKind = 'idle' | 'pending' | 'success' | 'error'

/** pushOrder/app.py `/webhook` 响应（失败时为 FastAPI 的 { detail }） */
interface PushOrderResponse {
  status?: string
  action?: string
  symbol?: string
  qty?: number
  message?: string
  confirmed_by?: string
  detail?: string
}

const market = useMarketStore()

/** 品种输入框：默认取当前图表品种，图表切换时自动跟随 */
const symbolInput = ref<string>(market.symbol)
const qtyInput = ref<number>(1)
const statusKind = ref<StatusKind>('idle')
const statusText = ref<string>('')
const pendingAction = ref<PushAction | null>(null)

const busy = computed(() => pendingAction.value !== null)
const canSend = computed(
  () => !busy.value && symbolInput.value.trim().length > 0 && Number.isFinite(Number(qtyInput.value)) && Number(qtyInput.value) > 0,
)

// 图表品种变化 → 同步到输入框（仍可手动改成 Tradovate 中已打开的根合约，如 MES）
watch(
  () => market.symbol,
  (s) => {
    symbolInput.value = s
  },
)

function parseResponse(text: string): PushOrderResponse {
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as PushOrderResponse) : {}
  } catch {
    return { message: text }
  }
}

function describeError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'AbortError') return `下单请求超时（${REQUEST_TIMEOUT_MS / 1000}s）`
  if (err instanceof TypeError) return `网络错误：无法连接本地下单服务 ${PUSH_ORDER_BASE}，请确认 pushOrder/app.py 已启动`
  return err instanceof Error ? err.message : String(err)
}

async function send(action: PushAction) {
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

  pendingAction.value = action
  statusKind.value = 'pending'
  statusText.value = `下单中…（${action} ${symbol} × ${qty}）`

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${PUSH_ORDER_BASE}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, symbol, qty }),
      signal: controller.signal,
    })
    const data = parseResponse(await response.text())
    if (!response.ok) throw new Error(data.detail || data.message || `HTTP ${response.status}`)
    statusKind.value = 'success'
    statusText.value = `成功：${data.action ?? action} ${data.symbol ?? symbol} × ${data.qty ?? qty} 已提交${data.confirmed_by ? `（${data.confirmed_by}）` : ''}`
  } catch (err) {
    statusKind.value = 'error'
    statusText.value = `失败：${describeError(err)}`
  } finally {
    window.clearTimeout(timer)
    pendingAction.value = null
  }
}
</script>

<template>
  <div class="push-order-bar" :title="'下单服务：' + PUSH_ORDER_BASE">
    <span class="po-title">⚡ 直连下单</span>

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
