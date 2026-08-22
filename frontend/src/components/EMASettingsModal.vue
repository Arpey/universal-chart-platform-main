<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useIndicatorStore, type EMAInstance } from '../stores/indicatorStore'

const props = defineProps<{
  open: boolean
  ema: EMAInstance | null
}>()
const emit = defineEmits<{ close: [] }>()

const indicator = useIndicatorStore()

const PALETTE = ['#f59e0b', '#3b82f6', '#8b5cf6', '#10b981', '#ef4444', '#06b6d4', '#f97316', '#ec4899']

const lengthText = ref('20')
const color = ref(PALETTE[0])
const lineWidth = ref(2)

// 打开/切换目标实例时同步草稿
watch(
  () => props.ema,
  (e) => {
    if (e) {
      lengthText.value = String(e.length)
      color.value = e.color
      lineWidth.value = e.lineWidth
    }
  },
  { immediate: true },
)

/** 写回 store → TradingChart 监听实例变化实时刷新折线。 */
function patch(p: Partial<Pick<EMAInstance, 'length' | 'color' | 'lineWidth'>>) {
  if (props.ema) indicator.updateEMA(props.ema.id, p)
}

function onLengthInput(v: string) {
  lengthText.value = v
  const n = parseInt(v, 10)
  if (Number.isFinite(n)) patch({ length: Math.max(1, Math.min(500, n)) })
}

function onWindowKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
watch(
  () => props.open,
  (open) => {
    if (open) window.addEventListener('keydown', onWindowKeydown)
    else window.removeEventListener('keydown', onWindowKeydown)
  },
)
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))
</script>

<template>
  <div v-if="open" class="es-modal" @mousedown.self="emit('close')">
    <div class="es-dialog" role="dialog" aria-modal="true">
      <header class="es-header">
        <b>EMA 设置</b>
        <button class="es-close" title="关闭 (Esc)" @click="emit('close')">✕</button>
      </header>
      <div class="es-body">
        <label class="es-field">
          <span>Length（周期）</span>
          <input
            class="es-input"
            type="number"
            min="1"
            max="500"
            :value="lengthText"
            @input="onLengthInput(($event.target as HTMLInputElement).value)"
          />
        </label>
        <div class="es-field">
          <span>颜色</span>
          <div class="es-swatches">
            <button
              v-for="c in PALETTE"
              :key="c"
              class="es-swatch"
              :class="{ active: color === c }"
              :style="{ background: c }"
              :title="c"
              @click="color = c; patch({ color: c })"
            ></button>
            <label class="es-swatch es-custom" title="自定义颜色">
              <input
                type="color"
                :value="color"
                @input="color = ($event.target as HTMLInputElement).value; patch({ color })"
              />
            </label>
          </div>
        </div>
        <div class="es-field">
          <span>线宽</span>
          <div class="es-widths">
            <button
              v-for="n in 4"
              :key="n"
              class="es-width"
              :class="{ active: lineWidth === n }"
              :title="'线宽 ' + n"
              @click="lineWidth = n; patch({ lineWidth: n })"
            ><i :style="{ height: (2 + n) + 'px' }"></i></button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.es-modal {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.es-dialog {
  width: 300px;
  max-width: 92vw;
  background: var(--color-bg-secondary, #1a1f26);
  border: 1px solid var(--color-border, #1e293b);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}
.es-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border, #1e293b);
  font-size: 12px;
  color: var(--color-text, #e8edf3);
}
.es-close {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: #8090a5;
  border: none;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
}
.es-close:hover {
  background: var(--color-bg-tertiary, #242b34);
  color: #e8edf3;
}
.es-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
}
.es-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
  color: #8090a5;
}
.es-input {
  width: 80px;
  height: 30px;
  padding: 0 8px;
  background: var(--color-bg-primary, #12161c);
  color: var(--color-text, #e8edf3);
  border: 1px solid var(--color-border, #1e293b);
  border-radius: 5px;
  font-size: 12px;
  outline: none;
}
.es-input:focus {
  border-color: #3b82f6;
}
.es-swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.es-swatch {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.25);
  cursor: pointer;
  padding: 0;
}
.es-swatch.active {
  outline: 2px solid #3b82f6;
  outline-offset: 1px;
}
.es-custom {
  position: relative;
  overflow: hidden;
}
.es-custom input {
  position: absolute;
  inset: -4px;
  opacity: 0;
  cursor: pointer;
}
.es-widths {
  display: flex;
  gap: 6px;
}
.es-width {
  width: 32px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-primary, #12161c);
  color: var(--color-text, #d1d5db);
  border: 1px solid var(--color-border, #1e293b);
  border-radius: 5px;
  cursor: pointer;
}
.es-width:hover {
  border-color: #3b82f6;
}
.es-width.active {
  background: rgba(59, 130, 246, 0.18);
  border-color: #3b82f6;
}
.es-width i {
  display: block;
  width: 14px;
  background: currentColor;
  border-radius: 1px;
}
</style>
