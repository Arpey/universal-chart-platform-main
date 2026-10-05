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

/** H2/L2（高二低二：EMA 二次突破回调）指标配置。 */
export interface H2L2Config {
  /** 开关状态：关闭时 TradingChart 立即清空标记并移除 EMA 折线 */
  enabled: boolean
  /** 均线周期（默认 20，即 20 EMA 二次突破） */
  emaPeriod: number
  /** 命中信号时是否发送邮件提醒（依赖后端 POST /api/notify/email） */
  emailNotify: boolean
}

const EMA_PALETTE = ['#f59e0b', '#3b82f6', '#8b5cf6', '#10b981', '#ef4444', '#06b6d4', '#f97316', '#ec4899']

/** 指标注册与实例管理中心：TradingChart 监听本 store 的实例变化来渲染/清理折线。 */
export const useIndicatorStore = defineStore('indicators', () => {
  const emaInstances = ref<EMAInstance[]>([])
  /** H2/L2 指标配置：面板勾选框直接读写 `h2l2.enabled`（Pinia setup store 会解包 ref）。 */
  const h2l2 = ref<H2L2Config>({ enabled: true, emaPeriod: 20, emailNotify: false })
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

  /** H2/L2 开关：可传目标状态（checkbox 双向绑定用），不传则取反。 */
  function toggleH2L2(force?: boolean) {
    h2l2.value.enabled = typeof force === 'boolean' ? force : !h2l2.value.enabled
  }

  /** H2/L2 配置更新：`emaPeriod` 会被夹取为 1~500 的整数。 */
  function updateH2L2(patch: Partial<H2L2Config>) {
    const merged = { ...h2l2.value, ...patch }
    const period = Number.isFinite(merged.emaPeriod) ? Math.floor(merged.emaPeriod) : 20
    h2l2.value = { ...merged, emaPeriod: Math.max(1, Math.min(500, period)) }
  }

  return { emaInstances, h2l2, addEMA, removeEMA, updateEMA, toggleVisible, toggleH2L2, updateH2L2 }
})
