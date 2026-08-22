<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  createChart,
  ColorType,
  CrosshairMode,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import {
  LineDrawingPrimitive,
  randomColor,
  type DrawKind,
  type DrawObject,
  type DrawPoint,
} from './LineDrawingPrimitive'

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
  activeTool?: DrawKind
  clearSignal?: number
}>()

const emit = defineEmits<{
  toolState: [active: boolean]
}>()

const container = ref<HTMLElement>()
let chart: IChartApi | null = null
let candleSeries: ISeriesApi<'Candlestick'> | null = null
let volumeSeries: ISeriesApi<'Histogram'> | null = null
let primitive: LineDrawingPrimitive | null = null

const drawings = ref<DrawObject[]>([])
let raf = 0
let renderPending = false
let lastLen = 0
let lastFirstTime = 0
let disposed = false
let ro: ResizeObserver | null = null

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

  primitive = new LineDrawingPrimitive()
  candleSeries.attachPrimitive(primitive)

  applyData(props.data, true)
  lastLen = props.data.length

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
  if (chart) {
    if (clickHandler) chart.unsubscribeClick(clickHandler)
    if (crosshairHandler) chart.unsubscribeCrosshairMove(crosshairHandler)
    chart.remove()
    chart = null
  }
  document.removeEventListener('mousemove', handleDocMove)
  document.removeEventListener('mouseup', handleMouseUp)
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
  } else if (bars.length > 0) {
    const last = bars[bars.length - 1]
    candleSeries.update(toCandle(last))
    volumeSeries.update(toVolume(last))
  }
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

// rAF 节流处理频繁 tick（每 tick 只增量刷新最后一根）
watch(
  () => props.data,
  () => {
    if (disposed) return
    if (renderPending) return
    renderPending = true
    raf = requestAnimationFrame(() => {
      renderPending = false
      applyData(props.data, false)
      primitive?.setObjects(drawings.value)
    })
  },
  { deep: true },
)

watch(
  () => [props.activeTool, props.clearSignal],
  () => {
    if (props.clearSignal && props.clearSignal > 0) drawings.value = []
    primitive?.setObjects(drawings.value)
  },
)

// ---------- 画线工具交互 ----------
let mode: 'idle' | 'placing' | 'dragging' = 'idle'
let pendingObj: DrawObject | null = null
let dragId: string | null = null
let dragAnchorIndex = 0
let clickHandler: ((param: any) => void) | null = null
let crosshairHandler: ((param: any) => void) | null = null

function bindInteraction() {
  if (!chart) return
  clickHandler = (param) => {
    if (disposed || !param.point || !param.time) return
    handleClick(param.point.x, param.point.y)
  }
  crosshairHandler = (param) => {
    if (disposed || !param.point) return
    handleMove(param.point.x, param.point.y)
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
}

function currentTool(): DrawKind {
  return props.activeTool ?? 'cursor'
}

function handleClick(x: number, y: number) {
  const tool = currentTool()
  if (tool === 'cursor') return
  const pt = primitive?.screenToPoint(x, y)
  if (!pt) return

  if (mode === 'placing' && pendingObj) {
    pendingObj.points.push(pt)
    drawings.value = [...drawings.value, pendingObj]
    pendingObj = null
    mode = 'idle'
    emit('toolState', false)
    primitive?.setObjects(drawings.value)
    return
  }

  if (tool === 'hline' || tool === 'vline') {
    const obj: DrawObject = { id: genId(), kind: tool, points: [pt], color: randomColor() }
    drawings.value = [...drawings.value, obj]
  } else {
    pendingObj = { id: genId(), kind: tool, points: [pt], color: randomColor() }
    mode = 'placing'
    emit('toolState', true)
  }
  primitive?.setObjects(drawings.value)
}

function handleMove(x: number, y: number) {
  if (mode === 'dragging' && dragId) {
    const pt = primitive?.screenToPoint(x, y)
    if (!pt) return
    const idx = drawings.value.findIndex((d) => d.id === dragId)
    if (idx >= 0) {
      const copy = { ...drawings.value[idx], points: [...drawings.value[idx].points] }
      copy.points[dragAnchorIndex] = pt
      drawings.value = drawings.value.map((d, i) => (i === idx ? copy : d))
      primitive?.setObjects(drawings.value)
    }
  }
}

function handleMouseDown(e: MouseEvent) {
  if (currentTool() !== 'cursor') return
  const hit = hitTestAnchor(e.offsetX, e.offsetY)
  if (hit) {
    dragId = hit.id
    dragAnchorIndex = hit.index
    mode = 'dragging'
  }
}

function handleDocMove(e: MouseEvent) {
  if (mode === 'dragging' && dragId && container.value) {
    const rect = container.value.getBoundingClientRect()
    handleMove(e.clientX - rect.left, e.clientY - rect.top)
  }
}

function handleMouseUp() {
  if (mode === 'dragging') {
    mode = 'idle'
    dragId = null
    emit('toolState', false)
  }
}

function handleDblClick(e: MouseEvent) {
  if (currentTool() !== 'cursor') return
  const hit = hitTestAnchor(e.offsetX, e.offsetY)
  if (hit) {
    drawings.value = drawings.value.filter((d) => d.id !== hit.id)
    primitive?.setObjects(drawings.value)
    emit('toolState', false)
  }
}

function hitTestAnchor(x: number, y: number): { id: string; index: number } | null {
  for (const obj of drawings.value) {
    for (let i = 0; i < obj.points.length; i++) {
      const px = primitive?.timeToX(obj.points[i].time)
      const py = primitive?.priceToY(obj.points[i].price)
      if (px != null && py != null && Math.abs(px - x) <= 6 && Math.abs(py - y) <= 6) {
        return { id: obj.id, index: i }
      }
    }
  }
  return null
}

let idCounter = 0
function genId(): string {
  return `d${++idCounter}_${Date.now()}`
}
</script>

<template>
  <div ref="container" class="tv-chart"></div>
</template>

<style scoped>
.tv-chart {
  width: 100%;
  height: 100%;
  min-height: 300px;
}
</style>

