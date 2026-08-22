<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import SymbolSearchModal from './components/SymbolSearchModal.vue'
import Watchlist from './components/Watchlist.vue'
import TradingChart from './components/TradingChart.vue'
import StatusBar from './components/StatusBar.vue'
import IndicatorsModal from './components/IndicatorsModal.vue'
import { useMarketStore } from './stores/marketStore'
import { connectMarket } from './services/wsService'
import { useCountdown } from './composables/useCountdown'
import type { DrawKind } from './types/drawing'

const market = useMarketStore()
const lastTimeSec = computed(() => market.klines[market.klines.length - 1]?.time)
const { countdown: candleCountdown } = useCountdown(computed(() => market.interval), lastTimeSec)
const connected = ref(false)
const searchOpen = ref(false)
const indicatorModalOpen = ref(false)
const activeTool = ref<DrawKind>('cursor')
const clearSignal = ref(0)
const toolActive = ref(false)
let disconnect = () => {}

const DRAW_GROUPS: { title: string; items: { key: DrawKind; icon: string; title: string }[] }[] = [
  { title: '选择', items: [{ key: 'cursor', icon: '🖱', title: '光标/选择' }] },
  {
    title: '趋势线',
    items: [
      { key: 'trend', icon: '╱', title: '趋势线（线段，两点）' },
      { key: 'ray', icon: '➤', title: '射线（两点，向右延伸）' },
      { key: 'hray', icon: '─', title: '水平射线（单点，向右延伸）' },
    ],
  },
  {
    title: '测量',
    items: [
      { key: 'vline', icon: '│', title: '垂直线（单点）' },
      { key: 'ruler', icon: '▭', title: '测量工具（两点）' },
    ],
  },
  {
    title: '持仓',
    items: [
      { key: 'long', icon: '▲', title: '多头持仓（两点：入场 → 止盈，止损自动镜像，三锚点可拖）' },
      { key: 'short', icon: '▼', title: '空头持仓（两点：入场 → 止损，止盈自动镜像，三锚点可拖）' },
    ],
  },
  {
    title: '斐波那契',
    items: [
      { key: 'fib', icon: 'ƒ', title: '斐波那契回调（两点：趋势起点 A → 终点 B）' },
      { key: 'fibext', icon: '⇗', title: '趋势型斐波那契扩展（三点：A → B → C 回调点）' },
    ],
  },
]

const magnet = ref(false)
const stayInMode = ref(false)

const TOOL_HINTS: Partial<Record<DrawKind, string>> = {
  trend: '趋势线：点击 A → B，绘制有限线段（不延伸）',
  ray: '射线：点击 A 点 → B 点，向右侧无限延伸',
  hray: '水平射线：单击放置，从该点向右水平延伸',
  vline: '垂直线：单击放置时间标记',
  ruler: '测量工具：点击两点拉取区间（ΔP / % / bars / 时长 / ticks）',
  long: '多头持仓：点击入场价 → 点击止盈价（止损自动镜像），三锚点可独立拖拽',
  short: '空头持仓：点击入场价 → 点击止损价（止盈自动镜像），三锚点可独立拖拽',
  fib: '斐波那契回调：点击 A（趋势起点）→ B（趋势终点），默认 0/0.5/1/2 层级',
  fibext: '斐波那契扩展：点击 A → B（主趋势）→ C（回调点），第 3 点完成后生成扩展线',
}

function onDrawingDone() {
  if (!stayInMode.value) {
    activeTool.value = 'cursor'
    toolActive.value = false
  }
}

function pickTool(key: DrawKind) {
  activeTool.value = activeTool.value === key ? 'cursor' : key
  toolActive.value = activeTool.value !== 'cursor'
}

function clearDrawings() {
  clearSignal.value++
}

async function refresh() {
  disconnect()
  await market.load()
  disconnect = connectMarket(market.symbol, market.interval, market.update, value => connected.value = value)
}

watch(() => [market.symbol, market.interval], refresh)
onMounted(async () => {
  await market.loadUniverse()
  refresh()
})
onBeforeUnmount(() => disconnect())

function formatPrice(value?: number) {
  return value ? value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--'
}
</script>

<template>
  <main class="app">
    <!-- 顶部：标的 + 周期切换（TradingView 风格） -->
    <header class="topbar">
      <div class="ticker-strip">
        <button class="symbol-btn" title="切换交易对" @click="searchOpen = true">
          <em>{{ market.symbol.slice(0, market.symbol.indexOf('USDT')).slice(0, 4) }}</em>
          <b>{{ market.symbol }}</b>
          <span class="caret">▾</span>
        </button>
        <div class="periods">
          <button
            v-for="item in (['1m','5m','15m','1h','4h','1d'] as const)"
            :key="item"
            :class="{ active: item === market.interval }"
            @click="market.interval = item"
          >{{ item }}</button>
        </div>
        <button class="ind-btn" title="指标（Indicators）" @click="indicatorModalOpen = true">
          <span class="ind-fx">ƒx</span>
        </button>
        <span class="candle-countdown" title="距下一根 K 线开盘">⏱ {{ candleCountdown }}</span>
        <span v-if="market.ticker" class="last-price" :class="market.ticker.change24h >= 0 ? 'up' : 'down'">
          {{ formatPrice(market.ticker.price) }}
        </span>
        <span v-if="market.ticker" class="chg" :class="market.ticker.change24h >= 0 ? 'up' : 'down'">
          {{ market.ticker.change24h >= 0 ? '+' : '' }}{{ market.ticker.change24h.toFixed(2) }}%
        </span>
      </div>
      <div class="topbar-right">
        <span class="badge">PERPETUAL · USDT <b>●</b></span>
        <button class="search-btn" title="搜索交易对" @click="searchOpen = true">⌕</button>
      </div>
    </header>

    <section class="workspace">
      <!-- 左侧画线工具栏 -->
      <aside class="toolbar">
        <template v-for="(group, gi) in DRAW_GROUPS" :key="group.title">
          <span class="tool-group-title">{{ group.title }}</span>
          <button
            v-for="t in group.items"
            :key="t.key"
            class="tool"
            :class="{ active: activeTool === t.key }"
            :title="t.title"
            @click="pickTool(t.key)"
          ><span class="tool-icon">{{ t.icon }}</span></button>
          <span v-if="gi < DRAW_GROUPS.length - 1" class="tool-sep"></span>
        </template>

        <span class="tool-sep"></span>
        <button class="tool" :class="{ active: magnet }" title="磁吸模式（Ctrl/Cmd 可临时启用）" @click="magnet = !magnet">🧲</button>
        <button class="tool" :class="{ active: stayInMode }" title="连续绘制模式（画完保持当前工具）" @click="stayInMode = !stayInMode">🔁</button>
        <button class="tool danger" title="清除全部画线" @click="clearDrawings">✕</button>
      </aside>

      <!-- 主图区 -->
      <div class="panel">
        <div v-if="market.error" class="error">
          ⚠️ {{ market.error }}。请确认后端已启动或检查网络/代理配置。
        </div>
        <div v-if="toolActive" class="tool-hint">
          {{ TOOL_HINTS[activeTool] ?? '点击图表开始绘制' }} · 双击锚点删除 · Esc 取消
        </div>
        <TradingChart
          :data="market.klines"
          :interval="market.interval"
          :active-tool="activeTool"
          :magnet="magnet"
          :stay-in-mode="stayInMode"
          :clear-signal="clearSignal"
          @tool-state="toolActive = $event"
          @drawing-done="onDrawingDone"
        />
      </div>
      <Watchlist />
    </section>

    <StatusBar :connected="connected" :count="market.klines.length" />
    <SymbolSearchModal v-model:open="searchOpen" />
    <IndicatorsModal :open="indicatorModalOpen" @close="indicatorModalOpen = false" />
  </main>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100vh;
  background: var(--color-bg-primary);
}

/* ---- 顶部栏 ---- */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  height: 44px;
  flex-shrink: 0;
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
}

.ticker-strip {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.symbol-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}
.symbol-btn:hover { border-color: #3b82f6; }
.symbol-btn em {
  font-style: normal;
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 5px;
  background: rgba(59, 130, 246, 0.15);
  color: #3b82f6; font-size: 9px; font-weight: 800;
}
.symbol-btn .caret { color: var(--color-text-muted); font-size: 9px; }

.periods { display: flex; gap: 4px; }
.periods button {
  padding: 4px 9px;
  background: transparent; color: var(--color-text-muted);
  border: 1px solid transparent; border-radius: 3px;
  font-size: 11px; font-weight: 600; cursor: pointer; text-transform: uppercase;
}
.periods button:hover { color: var(--color-text); border-color: var(--color-border); }
.periods button.active { background: #3b82f6; color: #fff; }

/* 指标（Indicators）按钮 */
.ind-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  padding: 0 9px;
  margin-left: 2px;
  flex-shrink: 0;
  background: transparent;
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.ind-btn:hover {
  color: var(--color-text);
  border-color: #3b82f6;
  background: rgba(59, 130, 246, 0.1);
}
.ind-fx {
  font-family: monospace;
  font-weight: 800;
  font-size: 12px;
  letter-spacing: 0;
}

.candle-countdown {
  font-family: monospace;
  font-size: 12px;
  font-weight: 600;
  color: #7dd3fc;
  background: rgba(59, 130, 246, 0.12);
  border: 1px solid rgba(59, 130, 246, 0.3);
  border-radius: 5px;
  padding: 3px 8px;
  white-space: nowrap;
}

.last-price { font-family: monospace; font-size: 14px; font-weight: 600; }
.chg { font-family: monospace; font-size: 12px; }
.up { color: #26a69a; }
.down { color: #ef534f; }

.topbar-right { display: flex; align-items: center; gap: 10px; }
.badge { font-size: 11px; font-weight: 700; letter-spacing: 0.5px; color: var(--color-text-muted); text-transform: uppercase; }
.badge b { color: #10b981; }
.search-btn {
  width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
  background: var(--color-bg-tertiary); color: var(--color-text);
  border: 1px solid var(--color-border); border-radius: 6px; font-size: 16px; cursor: pointer;
}
.search-btn:hover { border-color: #3b82f6; color: #3b82f6; }

/* ---- 工作区 ---- */
.workspace { display: flex; flex: 1; min-height: 0; }

/* 左侧画线工具栏 */
.toolbar {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  width: 48px; flex-shrink: 0;
  padding: 6px 0;
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--color-border);
  overflow-y: auto;
}
.tool-group-title {
  font-size: 9px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase;
  color: #5b6470; padding: 6px 0 2px; user-select: none;
}
.tool-sep {
  width: 24px; height: 1px; margin: 4px 0; background: var(--color-border);
}
.tool {
  width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
  background: transparent; color: var(--color-text-muted);
  border: none; border-radius: 6px; cursor: pointer;
}
.tool .tool-icon { font-size: 15px; line-height: 1; }
.tool:hover { background: var(--color-bg-tertiary); color: var(--color-text); }
.tool.active { background: #3b82f6; color: #fff; }
.tool.danger { margin-top: 6px; color: #ef534f; font-size: 13px; }
.tool.danger:hover { background: rgba(239, 83, 79, 0.15); }

/* 主图区 */
.panel { flex: 1; min-width: 0; position: relative; background: var(--color-bg-primary); }
.error {
  position: absolute; top: 8px; left: 8px; right: 8px; z-index: 5;
  padding: 8px 12px; background: #7f1d1d; color: #fecaca; font-size: 12px; border-radius: 6px;
}
.tool-hint {
  position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 5;
  padding: 5px 12px; background: rgba(15, 20, 25, 0.85); color: #e8edf3;
  border: 1px solid var(--color-border); border-radius: 6px; font-size: 12px;
  pointer-events: none;
}
</style>
