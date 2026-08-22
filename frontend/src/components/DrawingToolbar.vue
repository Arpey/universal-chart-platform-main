<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DrawObject, LineStyle } from '../types/drawing'
import { FIB_LEVEL_PRESETS, FIBEXT_LEVEL_PRESETS, DEFAULT_FIB_LEVELS } from '../types/drawing'

const props = defineProps<{
  obj: DrawObject
  pos: { left: number; top: number } | null
}>()

const emit = defineEmits<{
  change: [patch: Partial<DrawObject>]
  delete: []
  front: []
  back: []
  close: []
}>()

const showSettings = ref(false)

const PALETTE = ['#ffd166', '#4cc9f0', '#f72585', '#7ae582', '#9d4edd', '#ff6b6b', '#48bfe3', '#3b82f6', '#ffffff', '#ef4444', '#10b981', '#f97316']

const LINE_STYLES: { key: LineStyle; label: string; title: string }[] = [
  { key: 'solid', label: '—', title: '实线' },
  { key: 'dashed', label: '--', title: '虚线' },
  { key: 'dotted', label: '· ·', title: '点线' },
]

// ---- 斐波那契层级勾选 ----
const isFib = computed(() => props.obj.kind === 'fib' || props.obj.kind === 'fibext')
const fibPresets = computed(() => (props.obj.kind === 'fibext' ? FIBEXT_LEVEL_PRESETS : FIB_LEVEL_PRESETS))
const fibDefaults = computed(() => DEFAULT_FIB_LEVELS)

function levelEnabled(lv: number): boolean {
  const cur = props.obj.enabledLevels
  if (cur && cur.length) return cur.includes(lv)
  return fibDefaults.value.includes(lv)
}

function toggleLevel(lv: number) {
  const cur = props.obj.enabledLevels && props.obj.enabledLevels.length ? [...props.obj.enabledLevels] : [...fibDefaults.value]
  const next = cur.includes(lv) ? cur.filter((v) => v !== lv) : [...cur, lv]
  next.sort((a, b) => a - b)
  emit('change', { enabledLevels: next })
}
</script>

<template>
  <div class="draw-toolbar" :style="{ left: (pos?.left ?? 0) + 'px', top: (pos?.top ?? 0) + 'px' }" @mousedown.stop.prevent @dblclick.stop>
    <div class="dt-row">
      <button
        v-for="n in 4"
        :key="n"
        class="dt-btn wd"
        :class="{ active: obj.lineWidth === n }"
        :title="'线宽 ' + n"
        @click="emit('change', { lineWidth: n })"
      ><i :style="{ height: (2 + n) + 'px' }"></i></button>

      <span class="dt-sep"></span>

      <button
        v-for="s in LINE_STYLES"
        :key="s.key"
        class="dt-btn"
        :class="{ active: obj.lineStyle === s.key }"
        :title="s.title"
        @click="emit('change', { lineStyle: s.key })"
      ><span class="dt-style">{{ s.label }}</span></button>

      <span class="dt-sep"></span>

      <button
        v-for="c in PALETTE"
        :key="c"
        class="swatch"
        :class="{ active: obj.color === c }"
        :style="{ background: c }"
        :title="c"
        @click="emit('change', { color: c })"
      ></button>
      <label class="swatch custom" title="自定义颜色">
        <input
          type="color"
          :value="obj.color"
          @input="emit('change', { color: ($event.target as HTMLInputElement).value })"
        />
      </label>

      <span class="dt-sep"></span>

      <button class="dt-btn" :class="{ active: obj.locked }" :title="obj.locked ? '已锁定（解锁）' : '锁定'" @click="emit('change', { locked: !obj.locked })">🔒</button>
      <button class="dt-btn" title="置顶" @click="emit('front')">▲</button>
      <button class="dt-btn" title="置底" @click="emit('back')">▼</button>
      <button class="dt-btn danger" title="删除 (Delete)" @click="emit('delete')">🗑</button>
      <button class="dt-btn" :class="{ active: showSettings }" title="设置" @click="showSettings = !showSettings">⚙</button>
      <button class="dt-btn" title="关闭" @click="emit('close')">✕</button>
    </div>

    <div v-if="showSettings" class="dt-settings">
      <p>颜色 / 线宽 / 线型可在上方直接调整。</p>
      <div v-if="isFib" class="fib-levels">
        <p class="muted">{{ obj.kind === 'fibext' ? '趋势型扩展层级（勾选显示）' : '回调层级（勾选显示）' }}</p>
        <label v-for="lv in fibPresets" :key="lv" class="fib-level" :title="'显示层级 ' + lv">
          <input type="checkbox" :checked="levelEnabled(lv)" @change="toggleLevel(lv)" />
          <span>{{ lv }}</span>
        </label>
      </div>
      <p v-else class="muted">持仓工具支持三锚点独立拖拽；TP 恒绿 / SL 恒红。</p>
    </div>
  </div>
</template>

<style scoped>
.draw-toolbar {
  position: absolute;
  z-index: 30;
  max-width: calc(100% - 8px);
  background: var(--color-bg-secondary, #1a1f26);
  border: 1px solid var(--color-border, #1e293b);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  padding: 4px 6px;
  pointer-events: auto;
}
.dt-row { display: flex; align-items: center; gap: 3px; flex-wrap: nowrap; }
.dt-btn {
  min-width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  background: transparent; color: var(--color-text, #d1d5db);
  border: 1px solid transparent; border-radius: 5px; cursor: pointer; font-size: 12px;
}
.dt-btn:hover { background: var(--color-bg-tertiary, #242b34); }
.dt-btn.active { background: rgba(59, 130, 246, 0.18); border-color: #3b82f6; }
.dt-btn.danger:hover { background: rgba(239, 83, 79, 0.18); color: #ef534f; }
.dt-btn.wd i { display: block; width: 14px; background: currentColor; border-radius: 1px; }
.dt-style { font-family: monospace; font-size: 11px; letter-spacing: 0; }
.dt-sep { width: 1px; height: 16px; background: var(--color-border, #1e293b); margin: 0 2px; }
.swatch {
  width: 16px; height: 16px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.25);
  cursor: pointer; flex-shrink: 0; padding: 0;
}
.swatch.active { outline: 2px solid #3b82f6; outline-offset: 1px; }
.swatch.custom { position: relative; overflow: hidden; }
.swatch.custom input { position: absolute; inset: -4px; opacity: 0; cursor: pointer; }
.dt-settings {
  margin-top: 6px; padding: 8px; border-top: 1px solid var(--color-border, #1e293b);
  font-size: 11px; color: var(--color-text, #d1d5db);
}
.dt-settings p { margin: 0 0 4px; }
.dt-settings .muted { color: #8090a5; }
.fib-levels { margin-top: 6px; }
.fib-levels .muted { margin-bottom: 6px; }
.fib-levels .fib-level {
  display: inline-flex; align-items: center; gap: 4px;
  margin: 0 10px 6px 0; font-family: monospace; font-size: 11px;
  color: var(--color-text, #d1d5db); cursor: pointer;
}
.fib-levels input { accent-color: #3b82f6; margin: 0; }
</style>
