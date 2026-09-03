<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  createChart,
  ColorType,
  CrosshairMode,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type LineWidth,
  type LogicalRange,
  type UTCTimestamp,
} from 'lightweight-charts'
import { CandleCountdownPrimitive } from './CandleCountdownPrimitive'
import { DrawingPrimitive } from './DrawingPrimitive'
import DrawingToolbar from './DrawingToolbar.vue'
import EMASettingsModal from './EMASettingsModal.vue'
import { useCountdown } from '../composables/useCountdown'
import { useIndicatorStore } from '../stores/indicatorStore'
import { calculateEMA } from '../utils/indicators'
import { POINT_COUNT, randomColor, DEFAULT_FIB_LEVELS, type DrawKind, type DrawObject, type DrawPoint } from '../types/drawing'
import type { Interval } from '../types'

interface Kline {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

const props = defineProps<{
  data: Kline[]
  interval: Interval
  /** 当前标的（如 BTCUSDT / NQ / MES）：用于识别跨标的切换并触发完整图表重置 */
  symbol?: string
  /** 当前数据源（binance / tradovate / ibkr / tradefi） */
  datasource?: string
  activeTool?: DrawKind
  magnet?: boolean
  stayInMode?: boolean
  clearSignal?: number
  /** 图表滚动到最左侧已加载 K 线时回调（endTime = 最旧 bar 的 Unix 毫秒），用于 IBKR 分页加载更早历史。 */
  onLoadMoreHistory?: (endTime: number) => void
}>()

const emit = defineEmits<{
  toolState: [active: boolean]
  drawingDone: []
}>()

const container = ref<HTMLElement>()
let chart: IChartApi | null = null
let candleSeries: ISeriesApi<'Candlestick'> | null = null
let volumeSeries: ISeriesApi<'Histogram'> | null = null
let primitive: DrawingPrimitive | null = null
let countdownPrimitive: CandleCountdownPrimitive | null = null

// ---------- 画线交互状态（FSM: idle → placing → selected/dragging） ----------
const mode = ref<'idle' | 'placing' | 'dragging'>('idle')
const selectedId = ref<string | null>(null)
const toolbarPos = ref<{ left: number; top: number } | null>(null)
const hoverState = ref<'anchor' | 'body' | null>(null)
const magnetHeld = ref(false)
let pendingObj: DrawObject | null = null
let previewPoint: DrawPoint | null = null
let dragId: string | null = null
let dragIndex: number | null = null
let dragOrigin: DrawPoint | null = null
let dragStartPoints: DrawPoint[] = []
let clickHandler: ((param: any) => void) | null = null
let crosshairHandler: ((param: any) => void) | null = null

// ---------- 技术指标（EMA） ----------
const indicator = useIndicatorStore()
const emaSeriesMap = new Map<string, ISeriesApi<'Line'>>()
const emaLastValues = ref<Record<string, number | null>>({})
const emaSettingsId = ref<string | null>(null)
const emaSettingsObj = computed(() => indicator.emaInstances.find((e) => e.id === emaSettingsId.value) ?? null)

const drawings = ref<DrawObject[]>([])
let raf = 0
let renderPending = false
let lastLen = 0
let lastFirstTime = 0
let disposed = false
let ro: ResizeObserver | null = null
let loadMoreGuardTime = 0 // 已触发 load_more 的最旧 bar 时间（避免同一边界重复请求）
let loadMoreGuardAt = 0 // 上次触发时间戳（节流，防止连续滚动时打爆后端）
/** 当前已渲染的标的/数据源上下文（用于识别跨标的切换）。 */
let prevScopeSymbol = props.symbol ?? ''
let prevScopeDatasource = props.datasource ?? ''
/** 新标的/周期数据尚未就绪：等下一次全量 setData 后调用 fitContent 自适应坐标。 */
let pendingAutoFit = true

// ---------- K 线收盘倒计时 ----------
const lastTimeSec = computed(() => props.data[props.data.length - 1]?.time)
const lastClose = computed(() => props.data[props.data.length - 1]?.close ?? 0)
const { countdown } = useCountdown(computed(() => props.interval), lastTimeSec)

watch([countdown, lastClose], () => {
  if (countdownPrimitive) {
    countdownPrimitive.setValue(lastClose.value, countdown.value)
  }
})

// 选中对象 / 磁吸开关 / 容器光标反馈
const selectedObj = computed(() => drawings.value.find((d) => d.id === selectedId.value) ?? null)
const magnetActive = computed(() => !!props.magnet || magnetHeld.value)
const containerCursor = computed(() => {
  if (mode.value === 'dragging') return 'grabbing'
  if (hoverState.value) return 'grab'
  if (currentTool() !== 'cursor') return 'crosshair'
  return 'default'
})

onMounted(async () => {
  if (!container.value) return
  chart = createChart(container.value, {
    width: container.value.clientWidth,
    height: container.value.clientHeight,
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: '#8090a5',
      fontFamily: 'Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: 11,
    },
    grid: {
      vertLines: { color: 'rgba(32,42,56,0.6)' },
      horzLines: { color: 'rgba(32,42,56,0.6)' },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: '#3b82f6', labelBackgroundColor: '#3b82f6' },
      horzLine: { color: '#3b82f6', labelBackgroundColor: '#3b82f6' },
    },
    rightPriceScale: {
      borderColor: 'rgba(51,64,82,1)',
      scaleMargins: { top: 0.1, bottom: 0.25 },
    },
    timeScale: {
      borderColor: 'rgba(51,64,82,1)',
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 5,
      barSpacing: 8,
    },
    handleScale: { axisPressedMouseMove: true },
  })

  candleSeries = chart.addSeries(CandlestickSeries, {
    upColor: '#26a69a',
    downColor: '#ef534f',
    borderUpColor: '#26a69a',
    borderDownColor: '#ef534f',
    wickUpColor: '#26a69a',
    wickDownColor: '#ef534f',
  })

  volumeSeries = chart.addSeries(HistogramSeries, {
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
  })
  chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })

  primitive = new DrawingPrimitive()
  candleSeries.attachPrimitive(primitive)
  primitive.setKlines(props.data)

  // K 线收盘倒计时徽标（叠加层）
  countdownPrimitive = new CandleCountdownPrimitive()
  candleSeries.attachPrimitive(countdownPrimitive)
  countdownPrimitive.setValue(lastClose.value, countdown.value)

  applyData(props.data, true)
  lastLen = props.data.length

  // 滚动到最左侧已加载 K 线时触发分页加载更早历史（IBKR）
  chart.timeScale().subscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChange)

  syncEmaSeries() // 初始渲染已有指标实例

  bindInteraction()

  ro = new ResizeObserver(() => {
    if (chart && container.value) {
      chart.applyOptions({ width: container.value.clientWidth, height: container.value.clientHeight })
    }
  })
  ro.observe(container.value)
  window.addEventListener('resize', handleResize)
})

onBeforeUnmount(() => {
  disposed = true
  if (raf) cancelAnimationFrame(raf)
  window.removeEventListener('resize', handleResize)
  ro?.disconnect()
  // 清理 EMA 折线系列（chart.removeSeries 为 v5 的移除 API）
  for (const s of emaSeriesMap.values()) chart?.removeSeries(s)
  emaSeriesMap.clear()
  if (chart) {
    chart.applyOptions({ handleScroll: { pressedMouseMove: true } }) // 兜底恢复，防止卸载后图表无法拖拽
    chart.timeScale().unsubscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChange)
    if (clickHandler) chart.unsubscribeClick(clickHandler)
    if (crosshairHandler) chart.unsubscribeCrosshairMove(crosshairHandler)
    chart.remove()
    chart = null
  }
  document.removeEventListener('mousemove', handleDocMove)
  document.removeEventListener('mouseup', handleMouseUp)
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('keyup', onKeyup)
  candleSeries = null
  volumeSeries = null
  primitive = null
})

function handleResize() {
  if (chart && container.value) {
    chart.applyOptions({ width: container.value.clientWidth, height: container.value.clientHeight })
  }
}

// ---------- 数据更新（tick 级增量） ----------
function applyData(data: Kline[], force: boolean) {
  if (!candleSeries || !volumeSeries) return
  const bars = normalizeKlines(data) // 先归一化（去重/排序/过滤非法）
  const firstTime = bars.length ? bars[0].time : 0
  if (force || bars.length !== lastLen || firstTime !== lastFirstTime) {
    candleSeries.setData(bars.map(toCandle))
    volumeSeries.setData(bars.map(toVolume))
    lastLen = bars.length
    lastFirstTime = firstTime
    // 切换标的/周期/首次加载后：新数据就绪即自适应时间轴与价格轴
    if (pendingAutoFit && bars.length > 0) {
      pendingAutoFit = false
      autoFitChart()
    }
  } else if (bars.length > 0) {
    const last = bars[bars.length - 1]
    candleSeries.update(toCandle(last))
    volumeSeries.update(toVolume(last))
  }
}

/**
 * 标的/数据源/周期切换时的完整重置：
 * 清空 Series、重置坐标状态与分页守卫，等待新数据到达后由 autoFitChart() 自适应。
 */
function resetChartContext(clearDrawings: boolean) {
  if (disposed || !chart || !candleSeries || !volumeSeries) return
  // 1) 清空 K 线 / 成交量序列：防止“长度+首根时间未变”的增量分支误判为同序列 tick
  candleSeries.setData([])
  volumeSeries.setData([])
  lastLen = 0
  lastFirstTime = 0
  // 2) 分页守卫归零，避免新标的沿用旧标的的 load_more 去重边界
  loadMoreGuardTime = 0
  loadMoreGuardAt = 0
  // 3) EMA：旧标的数值失效，先清空渲染，待新数据经 syncEmaSeries 重算
  for (const s of emaSeriesMap.values()) s.setData([])
  emaLastValues.value = {}
  // 4) 价格轴恢复自动缩放（用户对旧标的手动拖动/缩放不带到新标的）
  chart.priceScale('right').applyOptions({ autoScale: true })
  chart.priceScale('volume').applyOptions({ autoScale: true })
  // 5) 绘制状态：取消进行中的放置/拖拽；标的或数据源变化时旧画线坐标已无意义 → 一并清空
  cancelPending()
  deselect()
  if (clearDrawings) drawings.value = []
  primitive?.setKlines([])
  primitive?.setObjects(drawings.value, selectedId.value)
  // 6) 标记等待新数据 → applyData 全量写入后自动 fitContent
  pendingAutoFit = true
}

/** 新数据就绪后：时间轴 fit 到完整新区间，价格轴按新标的区间恢复自动缩放。 */
function autoFitChart() {
  if (!chart) return
  chart.timeScale().fitContent()
  chart.priceScale('right').applyOptions({ autoScale: true })
  chart.priceScale('volume').applyOptions({ autoScale: true })
}

/** 归一化原始 K 线：过滤非法行 → 同 time 去重 → 按 time 升序（满足 setData 的严格有序要求） */
function normalizeKlines(data: Kline[]): Kline[] {
  const seen = new Map<number, Kline>()
  for (const k of data) {
    if (!k || typeof k.time !== 'number' || !Number.isFinite(k.time)) continue
    seen.set(k.time, k)
  }
  return [...seen.values()].sort((a, b) => a.time - b.time)
}

/** 时间戳适配：>= 1e12 视为毫秒（如币安原始 openTime）→ 除以 1000 转秒；否则视为秒直接使用 */
function toUTCTime(t: number): UTCTimestamp {
  return (t >= 1e12 ? Math.floor(t / 1000) : Math.floor(t)) as UTCTimestamp
}

/**
 * 可见范围变化：当图表滚动到最左侧已加载 K 线时，回调 onLoadMoreHistory 触发分页拉取更早数据（IBKR）。
 * range.from 为可见区第一个 bar 的逻辑索引：<= 0 表示左边界已到达/越过最旧 bar。
 */
function onVisibleLogicalRangeChange(range: LogicalRange | null) {
  if (!range || disposed) return
  const bars = props.data
  if (!bars.length || typeof props.onLoadMoreHistory !== 'function') return
  const oldest = bars[0].time
  if (typeof oldest !== 'number' || !Number.isFinite(oldest) || oldest <= 0) return
  // 切换标的/周期后最旧 bar 变新 → 重置边界守卫
  if (oldest > loadMoreGuardTime) loadMoreGuardTime = 0
  const now = Date.now()
  if (
    typeof range.from === 'number'
    && range.from <= 0.5 // 左边界已滑到最左侧
    && oldest !== loadMoreGuardTime // 同一边界只请求一次
    && now - loadMoreGuardAt > 2000 // 节流
  ) {
    loadMoreGuardTime = oldest
    loadMoreGuardAt = now
    props.onLoadMoreHistory(oldest)
  }
}

/** 强制转为有限数值，避免后端返回字符串/NaN 导致图表异常 */
function toNumber(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function toCandle(k: Kline) {
  return { time: toUTCTime(k.time), open: toNumber(k.open), high: toNumber(k.high), low: toNumber(k.low), close: toNumber(k.close) }
}

function toVolume(k: Kline) {
  return {
    time: toUTCTime(k.time),
    value: Math.max(0, toNumber(k.volume)),
    color: toNumber(k.close) >= toNumber(k.open) ? 'rgba(38,166,154,0.6)' : 'rgba(239,83,79,0.6)',
  }
}

// ---------- EMA 指标：计算 + 渲染 + 生命周期 ----------
/** 与 store 实例 / K 线数据同步：创建、更新、隐藏、删除 EMA 折线系列。 */
function syncEmaSeries() {
  if (!chart) return
  const data = props.data
  const desired = new Set<string>()
  for (const inst of indicator.emaInstances) {
    desired.add(inst.id)
    const points = calculateEMA(data, inst.length)
    const last = points.length ? points[points.length - 1].value : null
    emaLastValues.value = { ...emaLastValues.value, [inst.id]: last }
    let s = emaSeriesMap.get(inst.id)
    if (!s) {
      s = chart.addSeries(LineSeries, {
        color: inst.color,
        lineWidth: inst.lineWidth as LineWidth,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        priceScaleId: 'right', // 叠加在 K 线同一价格轴 / 同一 Pane
      })
      emaSeriesMap.set(inst.id, s)
    }
    s.applyOptions({ color: inst.color, lineWidth: inst.lineWidth as LineWidth, visible: inst.visible })
    s.setData(points.map((p) => ({ time: toUTCTime(p.time), value: p.value } as LineData)))
  }
  // 清理已删除实例对应的折线系列
  for (const [id, s] of [...emaSeriesMap.entries()]) {
    if (!desired.has(id)) {
      chart.removeSeries(s)
      emaSeriesMap.delete(id)
      const next = { ...emaLastValues.value }
      delete next[id]
      emaLastValues.value = next
    }
  }
}

/** 图例数值格式化（与行情价格一致的小数位）。 */
function fmtEmaValue(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v)
    ? '--'
    : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

watch(
  [() => props.data, () => indicator.emaInstances],
  () => syncEmaSeries(),
  { deep: true },
)

// rAF 节流处理频繁 tick（每 tick 只增量刷新最后一根）
watch(
  () => props.data,
  (nv, ov) => {
    if (disposed) return
    if (nv !== ov) {
      // 切换标的/周期：清空未完成绘制状态与选区
      cancelPending()
      deselect()
    }
    primitive?.setKlines(nv)
    if (renderPending) return
    renderPending = true
    raf = requestAnimationFrame(() => {
      renderPending = false
      applyData(props.data, false)
      primitive?.setObjects(drawings.value, selectedId.value)
    })
  },
  { deep: true },
)

// 标的 / 数据源 / 周期变化 → 完整重置图表（Series、坐标轴、分页守卫、指标与画线状态）
watch(
  [() => props.symbol, () => props.datasource, () => props.interval],
  () => {
    if (disposed) return
    const scopeChanged =
      (props.symbol ?? '') !== prevScopeSymbol || (props.datasource ?? '') !== prevScopeDatasource
    prevScopeSymbol = props.symbol ?? ''
    prevScopeDatasource = props.datasource ?? ''
    resetChartContext(scopeChanged)
  },
)

watch(
  () => [props.activeTool, props.clearSignal],
  () => {
    if (props.clearSignal && props.clearSignal > 0) {
      drawings.value = []
      deselect()
    } else {
      cancelPending()
    }
    primitive?.setObjects(drawings.value, selectedId.value)
  },
)

// ---------- 画线工具交互（FSM: idle → placing → selected/dragging） ----------
function isDrawingTool(tool: DrawKind): tool is Exclude<DrawKind, 'cursor'> {
  return tool !== 'cursor'
}

function currentTool(): DrawKind {
  return props.activeTool ?? 'cursor'
}

function bindInteraction() {
  if (!chart) return
  clickHandler = (param) => {
    if (disposed || !param.point) return
    onChartClick(param.point.x, param.point.y)
  }
  crosshairHandler = (param) => {
    if (disposed || !param.point) return
    onChartMove(param.point.x, param.point.y)
  }
  chart.subscribeClick(clickHandler)
  chart.subscribeCrosshairMove(crosshairHandler)
  const el = container.value
  if (el) {
    el.addEventListener('mousedown', handleMouseDown)
    el.addEventListener('dblclick', handleDblClick)
  }
  document.addEventListener('mousemove', handleDocMove)
  document.addEventListener('mouseup', handleMouseUp)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('keyup', onKeyup)
}

/** 磁吸：吸附最近 K 线的 O/H/L/C 价格点（Ctrl/Cmd 按住或 Magnet 开关启用）。 */
function applyMagnet(pt: DrawPoint): DrawPoint {
  if (!magnetActive.value) return pt
  const klines = props.data
  if (!klines.length) return pt
  let best = klines[0]
  let bestDiff = Infinity
  for (const k of klines) {
    const d = Math.abs(k.time - pt.time)
    if (d < bestDiff) {
      bestDiff = d
      best = k
    }
  }
  const cand = [best.open, best.high, best.low, best.close]
  let bp = cand[0]
  for (const c of cand) {
    if (Math.abs(c - pt.price) < Math.abs(bp - pt.price)) bp = c
  }
  return { time: best.time, price: bp }
}

function onChartClick(x: number, y: number) {
  // cursor 模式的选区/拖动已由 mousedown 处理，这里只负责放置绘制点
  if (currentTool() === 'cursor') return
  const pt = primitive?.screenToPoint(x, y)
  if (!pt) return
  placePoint(applyMagnet(pt))
}

function onChartMove(x: number, y: number) {
  if (mode.value === 'dragging') return
  if (mode.value === 'placing' && pendingObj) {
    const pt = primitive?.screenToPoint(x, y)
    if (!pt) return
    previewPoint = applyMagnet(pt)
    primitive?.setPreview({
      kind: pendingObj.kind,
      points: [...pendingObj.points, previewPoint],
      color: pendingObj.color,
    })
    return
  }
  const tool = currentTool()
  if ((tool === 'vline' || tool === 'hray') && mode.value === 'idle') {
    const pt = primitive?.screenToPoint(x, y)
    if (!pt) return
    primitive?.setPreview({ kind: tool, points: [applyMagnet(pt)], color: '#3b82f6' })
    return
  }
  if (tool === 'cursor') {
    const hit = primitive?.hitTestObjects(drawings.value, x, y) ?? null
    hoverState.value = hit ? ('index' in hit ? 'anchor' : 'body') : null
  }
}

function placePoint(pt: DrawPoint) {
  const tool = currentTool()
  if (!isDrawingTool(tool)) return
  if (!pendingObj) {
    pendingObj = {
      id: genId(),
      kind: tool,
      color: randomColor(),
      points: [],
      lineWidth: 2,
      lineStyle: 'solid',
      locked: false,
      zIndex: Date.now(),
      createdAt: Date.now(),
      // 斐波那契工具：默认仅勾选核心层级 0/0.5/1/2（其余可在悬浮工具栏设置弹窗中手动勾选预设层级）
      ...(tool === 'fib' || tool === 'fibext' ? { enabledLevels: [...DEFAULT_FIB_LEVELS] } : {}),
    }
  }
  pendingObj.points.push(pt)
  const needed = POINT_COUNT[pendingObj.kind]
  if (pendingObj.points.length >= needed) {
    const done = pendingObj
    pendingObj = null
    // 持仓工具：第 2 点（多头=止盈 / 空头=止损）确定后，自动物化入场价镜像的第 3 个锚点
    // （止损 = 2×入场 − 止盈；空头反之）。物化后 3 个锚点即可独立拖拽。
    if (done.kind === 'long' || done.kind === 'short') {
      const [p0, p1] = done.points
      done.points.push({ time: p0.time, price: 2 * p0.price - p1.price })
    }
    mode.value = 'idle'
    previewPoint = null
    primitive?.setPreview(null)
    drawings.value = [...drawings.value, done]
    selectObject(done.id)
    emit('toolState', false)
    emit('drawingDone') // App.vue 根据 stayInMode 决定是否切回 cursor
  } else {
    mode.value = 'placing'
    emit('toolState', true)
  }
}

function cancelPending() {
  if (!pendingObj) return
  pendingObj = null
  mode.value = 'idle'
  previewPoint = null
  primitive?.setPreview(null)
  emit('toolState', false)
}

function handleMouseDown(e: MouseEvent) {
  if (currentTool() !== 'cursor') return
  const x = e.offsetX
  const y = e.offsetY
  const hit = primitive?.hitTestObjects(drawings.value, x, y) ?? null
  if (!hit) {
    deselect()
    return
  }
  const obj = drawings.value.find((d) => d.id === hit.id)
  if (!obj) {
    deselect()
    return
  }
  selectObject(hit.id)
  if (obj.locked) return
  // Bug B：拖拽画线/锚点时禁用底层图表左键拖拽平移，避免底图跟随滑动
  e.preventDefault()
  chart?.applyOptions({ handleScroll: { pressedMouseMove: false } })
  mode.value = 'dragging'
  dragId = hit.id
  dragIndex = 'index' in hit ? hit.index : null
  const pt = primitive?.screenToPoint(x, y)
  dragOrigin = pt ?? { time: 0, price: 0 }
  dragStartPoints = obj.points.map((p) => ({ ...p }))
}

function handleDocMove(e: MouseEvent) {
  if (mode.value !== 'dragging' || !dragId || !container.value) return
  const rect = container.value.getBoundingClientRect()
  const pt = primitive?.screenToPoint(e.clientX - rect.left, e.clientY - rect.top)
  if (!pt || !dragOrigin) return
  const snapped = applyMagnet(pt)
  drawings.value = drawings.value.map((d) => {
    if (d.id !== dragId) return d
    if (dragIndex != null) {
      return { ...d, points: d.points.map((p, i) => (i === dragIndex ? snapped : p)) }
    }
    const dt = snapped.time - dragOrigin!.time
    const dp = snapped.price - dragOrigin!.price
    return {
      ...d,
      points: d.points.map((p, i) => ({ time: dragStartPoints[i].time + dt, price: dragStartPoints[i].price + dp })),
    }
  })
  primitive?.setObjects(drawings.value, selectedId.value)
  updateToolbarPos()
}

function handleMouseUp() {
  if (mode.value === 'dragging') {
    mode.value = 'idle'
    // 恢复底图拖拽平移
    chart?.applyOptions({ handleScroll: { pressedMouseMove: true } })
    dragId = null
    dragIndex = null
    dragOrigin = null
    dragStartPoints = []
  }
}

function handleDblClick(e: MouseEvent) {
  if (currentTool() !== 'cursor') return
  const hit = primitive?.hitTestObjects(drawings.value, e.offsetX, e.offsetY) ?? null
  if (!hit) return
  drawings.value = drawings.value.filter((d) => d.id !== hit.id)
  if (selectedId.value === hit.id) deselect()
  else primitive?.setObjects(drawings.value, selectedId.value)
}

// ---- 选区 / 悬浮工具栏 / 层级 ----
function selectObject(id: string) {
  selectedId.value = id
  primitive?.setObjects(drawings.value, id)
  updateToolbarPos()
}

function deselect() {
  selectedId.value = null
  toolbarPos.value = null
  primitive?.setObjects(drawings.value, null)
}

function updateToolbarPos() {
  const obj = selectedObj.value
  if (!obj || !primitive || !container.value) return
  const p = obj.points[0]
  if (!p) return
  const x = primitive.timeToX(p.time)
  const y = primitive.priceToY(p.price)
  if (x == null || y == null) return
  const cw = container.value.clientWidth
  toolbarPos.value = {
    left: Math.min(Math.max(4, x), cw - 160),
    top: Math.max(4, y - 40),
  }
}

function patchSelected(patch: Partial<DrawObject>) {
  const id = selectedId.value
  if (!id) return
  drawings.value = drawings.value.map((d) => (d.id === id ? { ...d, ...patch } : d))
  primitive?.setObjects(drawings.value, id)
}

function deleteSelected() {
  const id = selectedId.value
  if (!id) return
  drawings.value = drawings.value.filter((d) => d.id !== id)
  deselect()
}

function zOrder(front: boolean) {
  const id = selectedId.value
  if (!id) return
  let ref = front ? -Infinity : Infinity
  for (const d of drawings.value) {
    if (d.id === id) continue
    ref = front ? Math.max(ref, d.zIndex) : Math.min(ref, d.zIndex)
  }
  const next = front ? (ref === -Infinity ? 0 : ref + 1) : (ref === Infinity ? 0 : ref - 1)
  drawings.value = drawings.value.map((d) => (d.id === id ? { ...d, zIndex: next } : d))
  primitive?.setObjects(drawings.value, id)
}

// ---- 快捷键 ----
function onKeydown(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault()
    deleteSelected()
  } else if (e.key === 'Escape') {
    cancelPending()
    deselect()
  } else if (e.key === 'Control' || e.key === 'Meta') {
    magnetHeld.value = true
  }
}

function onKeyup(e: KeyboardEvent) {
  if (e.key === 'Control' || e.key === 'Meta') magnetHeld.value = false
}

let idCounter = 0
function genId(): string {
  return `d${++idCounter}_${Date.now()}`
}
</script>

<template>
  <div ref="container" class="tv-chart" :style="{ cursor: containerCursor }">
    <!-- 左上角指标图例 -->
    <div v-if="indicator.emaInstances.length" class="ema-legend" @mousedown.stop.prevent @dblclick.stop>
      <div v-for="inst in indicator.emaInstances" :key="inst.id" class="ema-legend-row">
        <span class="ema-legend-name" :style="{ color: inst.color }">
          EMA {{ inst.length }}<em>{{ fmtEmaValue(emaLastValues[inst.id]) }}</em>
        </span>
        <button
          class="ema-legend-btn"
          :class="{ off: !inst.visible }"
          :title="inst.visible ? '隐藏指标' : '显示指标'"
          @click="indicator.toggleVisible(inst.id)"
        >👁</button>
        <button class="ema-legend-btn" title="设置" @click="emaSettingsId = inst.id">⚙</button>
        <button class="ema-legend-btn danger" title="删除指标" @click="indicator.removeEMA(inst.id)">🗑</button>
      </div>
    </div>

    <DrawingToolbar
      v-if="selectedObj"
      :obj="selectedObj"
      :pos="toolbarPos"
      @change="patchSelected"
      @delete="deleteSelected"
      @front="zOrder(true)"
      @back="zOrder(false)"
      @close="deselect"
    />

    <EMASettingsModal :open="!!emaSettingsId" :ema="emaSettingsObj" @close="emaSettingsId = null" />
  </div>
</template>

<style scoped>
.tv-chart {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 300px;
}

/* 左上角 EMA 图例 */
.ema-legend {
  position: absolute;
  top: 6px;
  left: 8px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  pointer-events: auto;
  user-select: none;
}
.ema-legend-row {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: rgba(15, 20, 25, 0.85);
  border: 1px solid rgba(33, 150, 243, 0.35);
  border-radius: 5px;
  padding: 1px 4px;
  font-size: 11px;
}
.ema-legend-name {
  font-family: monospace;
  font-weight: 700;
  white-space: nowrap;
}
.ema-legend-name em {
  font-style: normal;
  font-weight: 500;
  color: #e8edf3;
  margin-left: 4px;
}
.ema-legend-btn {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
  color: #8090a5;
  padding: 0;
}
.ema-legend-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #e8edf3;
}
.ema-legend-btn.off {
  opacity: 0.35;
}
.ema-legend-btn.danger:hover {
  background: rgba(239, 83, 79, 0.2);
  color: #ef534f;
}
</style>

