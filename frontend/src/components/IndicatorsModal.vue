<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useIndicatorStore } from '../stores/indicatorStore'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const indicator = useIndicatorStore()
const keyword = ref('')
const searchRef = ref<HTMLInputElement | null>(null)

const INDICATORS = [
  { key: 'ema', symbol: 'EMA', name: 'Exponential Moving Average', cn: '指数移动平均线' },
]

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return INDICATORS
  return INDICATORS.filter(
    (i) => i.name.toLowerCase().includes(kw) || i.cn.includes(kw) || i.symbol.toLowerCase().includes(kw),
  )
})

// 打开时自动聚焦搜索框
watch(
  () => props.open,
  async (open) => {
    if (open) {
      keyword.value = ''
      await nextTick()
      searchRef.value?.focus()
    }
  },
)

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

/** 点击指标项 → 实例化添加（弹窗保持打开，支持连续添加多实例）。 */
function pick(item: { key: string }) {
  if (item.key === 'ema') indicator.addEMA(20)
}
</script>

<template>
  <div v-if="open" class="ind-modal" @mousedown.self="emit('close')">
    <div class="ind-dialog" role="dialog" aria-modal="true">
      <header class="ind-header">
        <div class="ind-search">
          <span class="ind-search-icon">⌕</span>
          <input ref="searchRef" v-model="keyword" class="ind-input" placeholder="搜索指标" />
        </div>
        <button class="ind-close" title="关闭 (Esc)" @click="emit('close')">✕</button>
      </header>
      <ul class="ind-list">
        <li v-for="i in filtered" :key="i.key" class="ind-item" @click="pick(i)">
          <span class="ind-symbol">{{ i.symbol }}</span>
          <span class="ind-name">
            <b>{{ i.name }}</b>
            <em>{{ i.cn }}</em>
          </span>
          <span class="ind-add" title="添加到图表">＋</span>
        </li>
      </ul>
      <footer v-if="!filtered.length" class="ind-empty">无匹配指标</footer>
    </div>
  </div>
</template>

<style scoped>
.ind-modal {
  position: fixed;
  inset: 0;
  z-index: 110;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 64px;
  background: rgba(0, 0, 0, 0.5);
}
.ind-dialog {
  width: 360px;
  max-width: 92vw;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-secondary, #1a1f26);
  border: 1px solid var(--color-border, #1e293b);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}
.ind-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border, #1e293b);
}
.ind-search {
  flex: 1;
  position: relative;
  display: flex;
  align-items: center;
}
.ind-search-icon {
  position: absolute;
  left: 10px;
  color: #8090a5;
  font-size: 14px;
  pointer-events: none;
}
.ind-input {
  width: 100%;
  height: 34px;
  padding: 0 34px 0 30px;
  background: var(--color-bg-primary, #12161c);
  color: var(--color-text, #e8edf3);
  border: 1px solid var(--color-border, #1e293b);
  border-radius: 6px;
  font-size: 12px;
  outline: none;
}
.ind-input:focus {
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
}
.ind-close {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: #8090a5;
  border: none;
  border-radius: 5px;
  font-size: 13px;
  cursor: pointer;
}
.ind-close:hover {
  background: var(--color-bg-tertiary, #242b34);
  color: #e8edf3;
}
.ind-list {
  flex: 1;
  list-style: none;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
}
.ind-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.ind-item:hover {
  background: rgba(59, 130, 246, 0.12);
}
.ind-item:hover .ind-add {
  color: #3b82f6;
}
.ind-symbol {
  font-family: monospace;
  font-size: 11px;
  font-weight: 800;
  color: #7dd3fc;
  background: rgba(59, 130, 246, 0.15);
  border: 1px solid rgba(59, 130, 246, 0.35);
  border-radius: 4px;
  padding: 2px 5px;
  flex-shrink: 0;
}
.ind-name {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.ind-name b {
  font-size: 12px;
  color: var(--color-text, #e8edf3);
  font-weight: 600;
}
.ind-name em {
  font-style: normal;
  font-size: 11px;
  color: #8090a5;
}
.ind-add {
  font-size: 15px;
  color: #556070;
  flex-shrink: 0;
}
.ind-empty {
  padding: 14px;
  text-align: center;
  font-size: 12px;
  color: #8090a5;
}
</style>
