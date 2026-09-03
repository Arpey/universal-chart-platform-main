<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import OrderForm from './OrderForm.vue'
import PositionTable from './PositionTable.vue'
import OrderTable from './OrderTable.vue'
import { useMarketStore } from '../../stores/marketStore'
import { useTradingStore } from '../../stores/tradingStore'

const market = useMarketStore()
const trading = useTradingStore()

/** 面板开合状态集中托管于 tradingStore（isOrderPanelOpen），
 *  顶栏按钮 / 快捷键 / 图表右键菜单均可读写，保证各入口状态同步。 */
const open = computed(() => trading.isOrderPanelOpen)
const symbol = computed(() => trading.activeSymbol || market.symbol)

function close() {
  trading.closeOrderPanel()
}

/** 打开期间监听 ESC 关闭（仅面板打开时挂载，避免与画线取消等全局键位冲突）。 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}
watch(open, (o) => {
  if (o) window.addEventListener('keydown', onKeydown)
  else window.removeEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="trading-layer">
    <!-- 蒙版：点击面板外部关闭 -->
    <Transition name="tp-fade">
      <div v-if="open" class="tp-mask" @click="close"></div>
    </Transition>

    <!-- 右侧抽屉：下单 + 持仓 + 挂单 -->
    <Transition name="tp-slide">
      <aside v-if="open" class="trading-panel" role="dialog" aria-modal="true" aria-label="快捷下单面板">
        <header class="tp-header">
          <div class="tp-title">
            <b>⚡ 快捷下单</b>
            <span class="tp-symbol" :title="'交易品种：' + symbol">{{ symbol || '--' }}</span>
          </div>
          <button class="tp-close" title="关闭面板（Esc）" aria-label="关闭下单面板" @click="close">✕</button>
        </header>

        <div class="tp-body">
          <OrderForm />
          <PositionTable />
          <OrderTable />
        </div>
      </aside>
    </Transition>
  </div>
</template>

<style scoped>
/* 覆盖层：与 App 顶部工具栏(44px)/底部状态栏(36px) 对齐，仅盖住工作区 */
.trading-layer {
  position: fixed;
  top: 44px;
  right: 0;
  bottom: 36px;
  left: 0;
  z-index: 95;
  pointer-events: none;
}

/* 蒙版（淡入淡出，可点击关闭） */
.tp-mask {
  position: absolute;
  inset: 0;
  background: rgba(5, 8, 13, 0.5);
  pointer-events: auto;
}

/* 右侧抽屉容器（默认隐藏，仅在 store 打开时渲染并滑入） */
.trading-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 340px;
  max-width: 92%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-secondary, #1a1f26);
  border-left: 1px solid var(--color-border, #1e293b);
  box-shadow: -16px 0 40px rgba(0, 0, 0, 0.45);
  pointer-events: auto;
}

/* 面板头部：标题 + 显眼关闭按钮 */
.tp-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 44px;
  padding: 0 8px 0 14px;
  background: var(--color-bg-tertiary, #242b34);
  border-bottom: 1px solid var(--color-border, #1e293b);
}
.tp-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.tp-title b {
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.4px;
  color: #3b82f6;
  white-space: nowrap;
}
.tp-symbol {
  max-width: 170px;
  font-family: monospace;
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-muted, #8090a5);
  background: var(--color-bg-secondary, #1a1f26);
  border: 1px solid var(--color-border, #1e293b);
  border-radius: 4px;
  padding: 2px 7px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tp-close {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(242, 54, 69, 0.12);
  color: #f87171;
  border: 1px solid rgba(242, 54, 69, 0.35);
  border-radius: 6px;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.tp-close:hover {
  background: rgba(242, 54, 69, 0.28);
  color: #fff;
}

/* 面板内容区：下单 + 持仓 + 挂单，整体纵向滚动 */
.tp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

/* ---- 过渡动画 ---- */
/* 蒙版淡入淡出 */
.tp-fade-enter-active,
.tp-fade-leave-active {
  transition: opacity 0.22s ease;
}
.tp-fade-enter-from,
.tp-fade-leave-to {
  opacity: 0;
}

/* 抽屉：右滑进入 / 右滑退出 */
.tp-slide-enter-active {
  transition: transform 0.28s cubic-bezier(0.32, 0.72, 0, 1);
}
.tp-slide-leave-active {
  transition: transform 0.2s ease-in;
}
.tp-slide-enter-from,
.tp-slide-leave-to {
  transform: translateX(100%);
}
.tp-slide-enter-to,
.tp-slide-leave-from {
  transform: translateX(0);
}
</style>
