import { defineStore } from 'pinia'
import { ref } from 'vue'

/** EMA 指标实例（支持多实例并行，如同时叠加 EMA 20 与 EMA 50）。 */
export interface EMAInstance {
  id: string
  length: number
  color: string
  lineWidth: number
  visible: boolean
}

const EMA_PALETTE = ['#f59e0b', '#3b82f6', '#8b5cf6', '#10b981', '#ef4444', '#06b6d4', '#f97316', '#ec4899']

/** 指标注册与实例管理中心：TradingChart 监听本 store 的实例变化来渲染/清理折线。 */
export const useIndicatorStore = defineStore('indicators', () => {
  const emaInstances = ref<EMAInstance[]>([])
  let seq = 0

  function addEMA(length = 20): EMAInstance {
    const inst: EMAInstance = {
      id: `ema_${++seq}_${Date.now()}`,
      length: Math.max(1, Math.floor(length)),
      color: EMA_PALETTE[emaInstances.value.length % EMA_PALETTE.length],
      lineWidth: 2,
      visible: true,
    }
    emaInstances.value.push(inst)
    return inst
  }

  function removeEMA(id: string) {
    emaInstances.value = emaInstances.value.filter((e) => e.id !== id)
  }

  function updateEMA(id: string, patch: Partial<Omit<EMAInstance, 'id'>>) {
    emaInstances.value = emaInstances.value.map((e) => (e.id === id ? { ...e, ...patch } : e))
  }

  function toggleVisible(id: string) {
    const target = emaInstances.value.find((e) => e.id === id)
    if (target) updateEMA(id, { visible: !target.visible })
  }

  return { emaInstances, addEMA, removeEMA, updateEMA, toggleVisible }
})
