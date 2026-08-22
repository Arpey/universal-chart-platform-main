/** 画线工具类型。cursor 为选择/光标模式，其余为绘制工具。long/short 为多头/空头持仓工具。 */
export type DrawKind = 'cursor' | 'trend' | 'ray' | 'hray' | 'vline' | 'ruler' | 'long' | 'short' | 'fib' | 'fibext'

/** 画线锚点：物理坐标（time 为 UTC 秒，price 为价格），随图表缩放/平移自动重定位。 */
export interface DrawPoint {
  time: number
  price: number
}

export type LineStyle = 'solid' | 'dashed' | 'dotted'

export interface DrawObject {
  id: string
  kind: Exclude<DrawKind, 'cursor'>
  color: string
  points: DrawPoint[]
  lineWidth: number // 1-4
  lineStyle: LineStyle
  locked: boolean
  zIndex: number
  /** fib：是否显示扩展层级 */
  showExtensions?: boolean
  /** fib/fibext：勾选启用的层级（预设列表见 FIB_LEVEL_PRESETS / FIBEXT_LEVEL_PRESETS） */
  enabledLevels?: number[]
  /** 持仓工具：止盈/止损比值 */
  rr?: number
  /** 持仓工具：预估手数（盈亏金额计算用） */
  size?: number
  createdAt: number
}

/** 各绘制工具需要的锚点数（状态机：idle → 逐点放置 → 完成）。 */
export const POINT_COUNT: Record<Exclude<DrawKind, 'cursor'>, number> = {
  trend: 2,
  hray: 1,
  vline: 1,
  ray: 2,
  ruler: 2,
  long: 2,
  short: 2,
  fib: 2,
  fibext: 3,
}

/** 斐波那契回调默认层级 */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0]
/** 斐波那契回调可选扩展层级 */
export const FIB_EXT_LEVELS = [1.618, 2.618, 4.236, -0.236, -0.618]
/** 趋势型斐波那契扩展层级 */
export const FIBEXT_LEVELS = [0, 0.382, 0.618, 1.0, 1.272, 1.618, 2.0, 2.618]

/** 斐波那契回调预设常用层级（设置弹窗 Checkbox 列表，默认勾选 FIB_LEVELS） */
export const FIB_LEVEL_PRESETS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0, 1.272, 1.618, 2.618]
/** 趋势型斐波那契扩展预设常用层级（设置弹窗 Checkbox 列表，默认勾选 FIBEXT_LEVELS） */
export const FIBEXT_LEVEL_PRESETS = [0, 0.382, 0.618, 1.0, 1.272, 1.618, 2.0, 2.618, 3.618, 4.236]

const PALETTE = ['#ffd166', '#4cc9f0', '#f72585', '#7ae582', '#9d4edd', '#ff6b6b', '#48bfe3', '#3b82f6']

export function randomColor(): string {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)]
}
