<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  createChart,
  ColorType,
  CrosshairMode,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type LineWidth,
  type LogicalRange,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import { CandleCountdownPrimitive } from './CandleCountdownPrimitive'
import { DrawingPrimitive } from './DrawingPrimitive'
import { PositionLinePrimitive, type PositionLineState } from './PositionLinePrimitive'
import DrawingToolbar from './DrawingToolbar.vue'
import EMASettingsModal from './EMASettingsModal.vue'
import { useCountdown } from '../composables/useCountdown'
import { useIndicatorStore } from '../stores/indicatorStore'
import { useTradingStore } from '../stores/tradingStore'
import { calculateEMA } from '../utils/indicators'
import { normalizeKlines, toKlineSeconds } from '../utils/klineSeries'
import { formatBeijingDateTime, formatBeijingShort, timeLikeToEpochSec } from '../utils/beijingTime'
import { POINT_COUNT, randomColor, DEFAULT_FIB_LEVELS, type DrawKind, type DrawObject, type DrawPoint } from '../types/drawing'
import type { Interval } from '../types'
import type { OrderPreset } from '../types/trading'

// ---------- 北京时间（UTC+8）刻度/十字光标格式化 ----------
// lightweight-charts 默认按 UTC 墙钟渲染时间轴；这里在展示层显式 +8h，
// 平移后读取 UTC getter，得到与浏览器本地时区无关的北京时间。
function formatBeijingTickMark(time: Time, tickMarkType: TickMarkType, _locale: string): string {
  const sec = timeLikeToEpochSec(time)
  if (sec == null) return ''
  const shifted = sec + 28800 // +8h 后按 UTC 墙钟读取即北京时间
  const d = new Date(shifted * 1000)
  const p = (v: number) => String(v).padStart(2, '0')
  switch (tickMarkType) {
    case TickMarkType.Year:
      return String(d.getUTCFullYear())
    case TickMarkType.Month:
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}`
    case TickMarkType.DayOfMonth:
      return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
    case TickMarkType.TimeWithSeconds:
      return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
    case TickMarkType.Time:
    default:
      return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  }
}

function formatBeijingCrosshairTime(time: Time): string {
  const sec = timeLikeToEpochSec(time)
  if (sec == null) return '--'
  return formatBeijingShort(sec)
}

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
  /**
   * 实时变更信号（store.klineVersion）：每次 K 线写入自增。
   * watcher 使用 flush:'sync'，因此在 props 更新（紧随 store 写入的那次 patch）中立即执行
   * series.update() —— 不经过 rAF / setTimeout / debounce，也不会像 rAF 那样丢弃中间 tick。
   */
  updateSignal?: number
  /** 当前标的（如 BTCUSDT / NQ / MES）：用于识别跨标的切换并触发完整图表重置 */
  symbol?: string
  /** 当前数据源（binance / tradovate / ibkr / tradefi） */
  datasource?: string
  activeTool?: DrawKind
  magnet?: boolean
  stayInMode?: boolean
  clearSignal?: number
  /**
   * 时间轴拖到最左侧时的分页回调（加载更早的 K 线，REST /api/kline/history&endTime=最早一根）。
   * @returns 前置新增的根数（> 0 时图表按该数量补偿视口偏移，画面不跳动）；
   *          0 = 没有更早的数据（此后不再触发）；null = 本次跳过（并发中 / 请求失败，可稍后重试）。
   */
  onLoadMoreHistory?: () => Promise<number | null>
}>()

const emit = defineEmits<{
  toolState: [active: boolean]
  drawingDone: []
  openOrder: [preset: OrderPreset]
}>()

const container = ref<HTMLElement>()
let chart: IChartApi | null = null
let candleSeries: ISeriesApi<'Candlestick'> | null = null
let volumeSeries: ISeriesApi<'Histogram'> | null = null
let primitive: DrawingPrimitive | null = null
let countdownPrimitive: CandleCountdownPrimitive | null = null
let positionPrimitive: PositionLinePrimitive | null = null

// ---------- 画线交互状态（FSM: idle → placing → selected/dragging） ----------
const mode = ref<'idle' | 'placing' | 'dragging' | 'bracket-drag'>('idle')
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
/** 持仓线 TP/SL 拖拽位移追踪（≥4px 才允许 mouseup 提交保护单）。 */
let bracketDragStartY = 0
let bracketDragMoved = false
let clickHandler: ((param: any) => void) | null = null
let crosshairHandler: ((param: any) => void) | null = null

// ---------- 技术指标（EMA） ----------
const indicator = useIndicatorStore()
const emaSeriesMap = new Map<string, ISeriesApi<'Line'>>()
/** EMA 尾部缓存（每个实例一条）：用于 tick 级增量递推，避免每个 tick 全量重算整条 EMA。 */
interface EmaTail {
  /** 已渲染的最后一个 EMA 点时间（10 位 Unix 秒） */
  time: number
  /** 已渲染的最后一个 EMA 值 */
  value: number
  /** 倒数第二个 EMA 值（EMA[i-1]，同周期 tick 重算末点用） */
  prev: number | null
}
const emaTailMap = new Map<string, EmaTail>()
const emaLastValues = ref<Record<string, number | null>>({})
const emaSettingsId = ref<string | null>(null)
const emaSettingsObj = computed(() => indicator.emaInstances.find((e) => e.id === emaSettingsId.value) ?? null)

const drawings = ref<DrawObject[]>([])
/**
 * 增量渲染重入锁：同步执行、无论成功失败都在 finally 中释放 ——
 * 杜绝「更新中」标志未释放导致图表永远卡住（原实现的 renderPending 在异常路径上会残留）。
 */
let updating = false
/** 更新期间又到达的新 tick：本次结束后补刷一次（最多一层递归，不会无限循环）。 */
let tickPending = false
let lastLen = 0
let lastFirstTime = 0
/** 已渲染的最后一根 K 线时间（10 位 Unix 秒）：用于判断 update() 的时间是否回退。 */
let lastRenderedTime = 0
let disposed = false
let ro: ResizeObserver | null = null
let loadMoreGuardTime = 0 // 已触发 load_more 的最旧 bar 时间（避免同一边界重复请求）
let loadMoreGuardAt = 0 // 上次触发时间戳（节流，防止连续滚动时打爆后端）
/** 是否还存在更早的 K 线（分页回调返回 0 后置 false，停止继续向左加载）。 */
let paginationHasMore = true
/** 分页请求进行中：避免同一时刻并发多页请求。 */
let paginationLoading = false
/**
 * 是否已进入「用户主动交互」状态：初始 fitContent / 程序化视口设置同样会让 range.from ≈ 0，
 * 若不区分就会在首屏自动加载更早历史（多余请求），因此只在用户滚动/拖拽/缩放后才允许分页。
 */
let paginationArmed = false
/** 触发分页的左侧阈值（可见区间起点逻辑索引）：<= 10 视为「已拖到最左」。 */
const LOAD_MORE_FROM_THRESHOLD = 10
/** 分页节流间隔（毫秒）：拖动过程中最多每 2s 触发一次。 */
const LOAD_MORE_THROTTLE_MS = 2000
/** 当前已渲染的标的/数据源上下文（用于识别跨标的切换）。 */
let prevScopeSymbol = props.symbol ?? ''
let prevScopeDatasource = props.datasource ?? ''
/** 新标的/周期数据尚未就绪：等下一次全量 setData 后调用 fitContent 自适应坐标。 */
let pendingAutoFit = true

// ---------- K 线收盘倒计时 ----------
/**
 * 当前（未收盘）K 线的收盘价。
 * 直接读数组尾部（props.data 为浅响应数组，实时值由 updateSignal 驱动刷新），
 * 不做响应式依赖追踪 —— 保证每次调用都拿到最新 tick 值。
 */
function currentClose(): number {
  const bars = props.data
  return bars.length ? toNumber(bars[bars.length - 1].close) : 0
}

/**
 * 当前 K 线开盘时间：额外依赖 updateSignal，使 tick 级原地更新后仍能重算；
 * computed 的值只在「换线」时变化 → useCountdown 的定时器不会每个 tick 被重启。
 */
const lastTimeSec = computed(() => {
  void props.updateSignal
  return props.data[props.data.length - 1]?.time
})
const { countdown } = useCountdown(computed(() => props.interval), lastTimeSec)

// 倒计时每秒重算：同步刷新徽标上的最新价（tick 级刷新由 applyRealtimeTick 直接负责）
watch(countdown, () => {
  countdownPrimitive?.setValue(currentClose(), countdown.value)
})

// ---------- 图表持仓线（TradingView 风格：方向 / 均价 / 数量 / 实时盈亏 / TP·SL） ----------
const trading = useTradingStore()
/** 当前图表品种的现仓（无则 null）。 */
const activePosition = computed(() => {
  const sym = (props.symbol ?? '').toUpperCase()
  if (!sym) return null
  const p = trading.positions.find((x) => x.symbol === sym && x.qty > 0)
  return p ?? null
})
/** TP/SL 拖拽草稿价（拖拽中实时预览，mouseup 才提交挂单）。 */
const draftSl = ref<number | null>(null)
const draftTp = ref<number | null>(null)
/** 正在拖拽的 bracket 手柄（高亮）。 */
const bracketTarget = ref<'tp' | 'sl' | null>(null)
/** 图表右键菜单（含价格与北京时间的显示）。 */
const ctxMenu = ref<{ x: number; y: number; price: number; time: number } | null>(null)
/** 现仓减仓方向（设置止盈/止损时优先按减仓腿方向预填；无现仓时留给用户选择）。 */
const ctxReduceSide = computed<'BUY' | 'SELL' | undefined>(() => {
  const pos = activePosition.value
  if (!pos) return undefined
  return pos.side === 'BUY' ? 'SELL' : 'BUY'
})

/** 持仓线默认止盈/止损建议间距（占持仓均价的百分比）。 */
const BRACKET_SUGGEST_PCT = 0.01

function roundToTick(value: number, refPrice: number): number {
  const str = String(refPrice)
  const dot = str.indexOf('.')
  const dec = dot >= 0 ? Math.min(6, str.length - dot - 1) : 2
  const m = Math.pow(10, dec)
  return Math.round(value * m) / m
}

/** 计算并推送 PositionLinePrimitive 需要的最新叠加状态。 */
function syncPositionOverlay() {
  if (!positionPrimitive) return
  const pos = activePosition.value
  if (!pos) {
    positionPrimitive.setState(null)
    return
  }
  const dir = pos.side === 'BUY' ? 1 : -1
  const last = currentClose()
  const mark = Number.isFinite(last) && last > 0 ? last : pos.markPrice
  const pnl = (mark - pos.entryPrice) * pos.qty * dir
  const cost = pos.entryPrice * pos.qty
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0
  const bracket = trading.getPositionBracket(pos.symbol)
  const suggDist = pos.entryPrice * BRACKET_SUGGEST_PCT
  const suggestedStopLoss = bracket.stopLoss == null ? pos.entryPrice - dir * suggDist : null
  const suggestedTakeProfit = bracket.takeProfit == null ? pos.entryPrice + dir * suggDist : null
  const state: PositionLineState = {
    symbol: pos.symbol,
    side: pos.side,
    qty: pos.qty,
    entry: pos.entryPrice,
    mark,
    pnl,
    pnlPct,
    takeProfit: bracket.takeProfit,
    stopLoss: bracket.stopLoss,
    suggestedTakeProfit,
    suggestedStopLoss,
    draftTakeProfit: draftTp.value,
    draftStopLoss: draftSl.value,
    dragging: bracketTarget.value,
  }
  positionPrimitive.setState(state)
}

// 持仓 / bracket / 拖拽草稿任一变化 → 刷新持仓线叠加层
// （行情价格变化不走这里：每个 tick 由 applyRealtimeTick 直接调用，避免 deep 遍历大盘数组）
watch(
  () => [
    props.symbol,
    trading.positions,
    () => trading.positionBrackets[(props.symbol ?? '').toUpperCase()],
    draftSl,
    draftTp,
    bracketTarget,
  ],
  () => syncPositionOverlay(),
  { deep: true },
)

/** 提交拖拽中的 TP/SL（落腿 → 撤旧单 + 挂新保护单）。 */
async function commitBracketDrag() {
  const pos = activePosition.value
  if (!pos) return
  const symbol = pos.symbol
  const cur = trading.getPositionBracket(symbol)
  const nextSl = draftSl.value ?? cur.stopLoss
  const nextTp = draftTp.value ?? cur.takeProfit
  const slChanged = nextSl !== cur.stopLoss
  const tpChanged = nextTp !== cur.takeProfit
  if (slChanged || tpChanged) {
    try {
      await trading.setPositionBracket(symbol, {
        stopLoss: slChanged ? nextSl : undefined,
        takeProfit: tpChanged ? nextTp : undefined,
      })
    } catch (err) {
      trading.error = err instanceof Error ? err.message : String(err)
    }
  }
  draftSl.value = null
  draftTp.value = null
  bracketTarget.value = null
  syncPositionOverlay()
}

/** 图表右键菜单操作：带价格/方向的快捷下单预设 → 通知 App 打开下单面板。 */
function openQuickOrder(preset: OrderPreset) {
  ctxMenu.value = null
  emit('openOrder', preset)
}

function closeCtxMenu() {
  ctxMenu.value = null
}


// 选中对象 / 磁吸开关 / 容器光标反馈
const selectedObj = computed(() => drawings.value.find((d) => d.id === selectedId.value) ?? null)
const magnetActive = computed(() => !!props.magnet || magnetHeld.value)
const containerCursor = computed(() => {
  if (mode.value === 'bracket-drag') return 'ns-resize'
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
    localization: {
      timeFormatter: (time: Time) => formatBeijingCrosshairTime(time),
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
      // X 轴刻度强制按北京时间（UTC+8）渲染，不再跟随浏览器时区/UTC 默认
      tickMarkFormatter: (time: Time, tickMarkType: TickMarkType, locale: string) =>
        formatBeijingTickMark(time, tickMarkType, locale),
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
  countdownPrimitive.setValue(currentClose(), countdown.value)

  // 图表持仓线叠加层（TradingView 风格：方向/均价/数量/实时盈亏 + TP·SL 拖拽手柄）
  positionPrimitive = new PositionLinePrimitive()
  candleSeries.attachPrimitive(positionPrimitive)
  syncPositionOverlay()

  fullRefresh()

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
  window.removeEventListener('resize', handleResize)
  const el = container.value
  if (el) {
    // 分页启用监听（与 bindInteraction 对应）
    el.removeEventListener('wheel', armPagination)
    el.removeEventListener('mousedown', armPagination)
    el.removeEventListener('touchstart', armPagination)
  }
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
  window.removeEventListener('mousedown', onWindowPointerDown)
  candleSeries = null
  volumeSeries = null
  primitive = null
  positionPrimitive = null
})

function handleResize() {
  if (chart && container.value) {
    chart.applyOptions({ width: container.value.clientWidth, height: container.value.clientHeight })
  }
}

// ---------- 数据更新：结构级全量重绘 + tick 级增量（无节流） ----------

/**
 * 全量重绘（低频、结构级）：历史整表替换 / 分页加载 / 清空 / 切标的 / 时间回退时调用。
 * 这里是**唯一**的 `setData()` 调用点 —— 实时 tick 路径绝不触发它，避免每 tick 深拷贝整表。
 */
function fullRefresh() {
  if (disposed || !candleSeries || !volumeSeries) return
  const bars = normalizeKlines(props.data, props.interval)
  candleSeries.setData(bars.map(toCandle))
  volumeSeries.setData(bars.map(toVolume))
  lastLen = props.data.length
  lastFirstTime = props.data.length ? toKlineSeconds(props.data[0].time) : 0
  lastRenderedTime = props.data.length ? toKlineSeconds(props.data[props.data.length - 1].time) : 0
  // 画线叠加层持有 K 线数组元素引用：结构变化后重新绑定（tick 原地更新无需重绑）
  primitive?.setKlines(props.data)
  primitive?.setObjects(drawings.value, selectedId.value)
  if (pendingAutoFit && bars.length > 0) {
    pendingAutoFit = false
    autoFitChart()
  }
  syncEmaSeries()
}

/**
 * 实时增量刷新（tick 级，**无节流**）。
 *
 * 由 `props.updateSignal`（store.klineVersion）以 `flush: 'sync'` 触发：store 写入后紧随的
 * patch 中立即执行，不经过 requestAnimationFrame / setTimeout / debounce（原实现用 rAF 节流，
 * 既引入最多一帧延迟，又会在 renderPending 期间丢弃中间 tick）。
 *
 * - 同周期 tick：只把「最后一根」交给 `series.update()`（覆盖当前蜡烛），零数组分配；
 * - 换线（尾部新增一根）：同样只调 `series.update()`，由 lightweight-charts 追加新 K 线，
 *   不做 setData、不复制整个 K 线数组；
 * - 结构变化 / 时间回退：回退 `fullRefresh()` 自愈（保证 update() 的时间严格递增）；
 * - 重入由 `updating` 串行化，锁在 finally 中释放（异常也不会把图表锁死）；
 *   更新期间到达的 tick 用 `tickPending` 标记，结束后补刷一次（最多一层，不会无限递归）。
 */
function applyRealtimeTick() {
  if (disposed || !candleSeries || !volumeSeries) return
  if (updating) { tickPending = true; return }
  updating = true
  try {
    const bars = props.data
    const len = bars.length
    if (!len) return
    const first = toKlineSeconds(bars[0].time)
    // 结构变化（整表替换 / 裁掉最旧 / 一次补多根）→ 全量重绘
    if (len < lastLen || len > lastLen + 1 || first !== lastFirstTime) {
      fullRefresh()
      return
    }
    const last = bars[len - 1]
    const time = toKlineSeconds(last.time)
    // 时间回退（乱序 / 迟到数据）→ 全量重绘兜底：update() 收到更早时间会抛错并让渲染停摆
    if (time < lastRenderedTime) {
      fullRefresh()
      return
    }
    candleSeries.update(toCandle(last))
    volumeSeries.update(toVolume(last))
    lastLen = len
    lastFirstTime = first
    lastRenderedTime = time
    // 叠加层随 tick 轻量同步：倒计时徽标最新价 / 持仓浮盈 / EMA 折线尾部
    countdownPrimitive?.setValue(toNumber(last.close), countdown.value)
    syncPositionOverlay()
    syncEmaTail(last)
  } catch (err) {
    // 任何异常都不得卡住渲染：降级为全量重绘
    console.warn('[TradingChart] 实时增量渲染失败，回退全量重绘', err)
    try {
      fullRefresh()
    } catch (fallbackErr) {
      console.error('[TradingChart] 全量重绘仍失败', fallbackErr)
    }
  } finally {
    updating = false
    if (tickPending) {
      tickPending = false
      applyRealtimeTick()
    }
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
  lastRenderedTime = 0
  // 2) 分页守卫归零，避免新标的沿用旧标的的 load_more 去重边界；hasMore 等由 store 的 loadHistory 重新置位
  loadMoreGuardTime = 0
  loadMoreGuardAt = 0
  paginationHasMore = true
  paginationLoading = false
  paginationArmed = false // 新标的/周期：等用户再次交互才允许向左分页
  // 3) EMA：旧标的数值失效，先清空渲染，待新数据经 syncEmaSeries 重算
  for (const s of emaSeriesMap.values()) s.setData([])
  emaTailMap.clear()
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
  // 6) 标记等待新数据 → fullRefresh() 全量写入后自动 fitContent
  pendingAutoFit = true
}

/** 新数据就绪后：时间轴 fit 到完整新区间，价格轴按新标的区间恢复自动缩放。 */
function autoFitChart() {
  if (!chart) return
  chart.timeScale().fitContent()
  chart.priceScale('right').applyOptions({ autoScale: true })
  chart.priceScale('volume').applyOptions({ autoScale: true })
}

/** 时间戳适配：统一为 10 位 Unix 秒（lightweight-charts 不允许毫秒），>= 1e12 视为毫秒 */
function toUTCTime(t: number): UTCTimestamp {
  return toKlineSeconds(t) as UTCTimestamp
}

/**
 * 可见范围变化：图表被拖到最左侧（range.from <= 阈值）时自动加载更早的 K 线（REST 分页）。
 * 触发条件（全部满足）：用户已交互过、还有更早数据、无进行中的分页请求、同一边界未请求过、距上次触发超过节流间隔。
 */
function onVisibleLogicalRangeChange(range: LogicalRange | null) {
  if (!range || disposed) return
  const bars = props.data
  if (!bars.length || typeof props.onLoadMoreHistory !== 'function') return
  // 首屏 fitContent / 程序化视口 → 尚未交互，不触发分页
  if (!paginationArmed) return
  if (typeof range.from !== 'number' || range.from > LOAD_MORE_FROM_THRESHOLD) return
  if (!paginationHasMore || paginationLoading) return
  const oldest = bars[0].time
  if (!Number.isFinite(oldest) || oldest <= 0) return
  // 切换标的/周期后最旧 bar 变新 → 重置边界守卫（同一边界只请求一页）
  if (oldest > loadMoreGuardTime) loadMoreGuardTime = 0
  const now = Date.now()
  if (oldest === loadMoreGuardTime) return
  if (now - loadMoreGuardAt < LOAD_MORE_THROTTLE_MS) return
  loadMoreGuardTime = oldest
  loadMoreGuardAt = now
  void loadOlderBars()
}

/**
 * 拉取更早一页并保持视口：分页数据是**前置插入**，setData 后整体右移「新增根数」，
 * 用户看到的画面位置不变（否则新数据插入后视口会跳到最左侧）。
 */
async function loadOlderBars() {
  const loader = props.onLoadMoreHistory
  if (!chart || disposed || typeof loader !== 'function') return
  // 记录加载前的可见逻辑区间（setData 前后索引基准一致：逻辑索引按 bar 序号）
  const prev = chart.timeScale().getVisibleLogicalRange()
  paginationLoading = true
  try {
    const added = await loader()
    if (disposed || !chart) return
    if (added === 0) {
      // 上游没有更早的数据 → 停止继续向左分页
      paginationHasMore = false
      return
    }
    if (added === null || typeof added !== 'number' || added <= 0) return // 跳过/失败：保持 hasMore，稍后可重试
    // 等 store → props.data → fullRefresh()（setData）落地后再补偿视口
    await nextTick()
    if (disposed || !chart || !prev) return
    chart.timeScale().setVisibleLogicalRange({ from: prev.from + added, to: prev.to + added })
  } catch (err) {
    console.warn('[TradingChart] 加载更早 K 线失败', err)
  } finally {
    paginationLoading = false
  }
}

/** 用户首次与图表交互（滚轮 / 拖拽 / 触屏）后启用分页 —— 避免首屏自动加载更早历史。 */
function armPagination() {
  paginationArmed = true
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
    // 记录尾部两点：tick 增量递推需要 EMA[i-1]（prev）与当前末点（value）
    const count = points.length
    if (count > 0) {
      emaTailMap.set(inst.id, {
        time: toKlineSeconds(points[count - 1].time),
        value: points[count - 1].value,
        prev: count >= 2 ? points[count - 2].value : null,
      })
    } else {
      emaTailMap.delete(inst.id)
    }
  }
  // 清理已删除实例对应的折线系列
  for (const [id, s] of [...emaSeriesMap.entries()]) {
    if (!desired.has(id)) {
      chart.removeSeries(s)
      emaSeriesMap.delete(id)
      emaTailMap.delete(id)
      const next = { ...emaLastValues.value }
      delete next[id]
      emaLastValues.value = next
    }
  }
}

/**
 * tick 级增量更新 EMA 尾部（O(1)）：EMA_today = Close·k + EMA_yesterday·(1-k)。
 * - 同周期 tick：用 `tail.prev` 重算末点并 `series.update()`；
 * - 换线（时间更大）：以 `tail.value` 为前值追加新点，EMA 折线随换线即时延伸。
 * （原实现每 tick 全量重算整条 EMA：500 根 × N 个指标，是刷新频率的主要瓶颈。）
 */
function syncEmaTail(bar: Kline) {
  if (!emaTailMap.size || !emaSeriesMap.size) return
  const time = toKlineSeconds(bar.time)
  const close = toNumber(bar.close)
  if (!time || !(close > 0)) return
  for (const inst of indicator.emaInstances) {
    const series = emaSeriesMap.get(inst.id)
    const tail = emaTailMap.get(inst.id)
    if (!series || !tail) continue
    const k = 2 / (inst.length + 1)
    if (time === tail.time) {
      const value = tail.prev == null ? close : close * k + tail.prev * (1 - k)
      series.update({ time: time as UTCTimestamp, value })
      tail.value = value
      emaLastValues.value[inst.id] = value
    } else if (time > tail.time) {
      const value = close * k + tail.value * (1 - k)
      series.update({ time: time as UTCTimestamp, value })
      emaTailMap.set(inst.id, { time, value, prev: tail.value })
      emaLastValues.value[inst.id] = value
    }
  }
}

/** 图例数值格式化（与行情价格一致的小数位）。 */
function fmtEmaValue(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v)
    ? '--'
    : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// 指标实例变化（增删 / 改色 / 改长度）→ 重算 EMA（deep 仅覆盖指标实例数组，不涉及 K 线大盘数组）
watch(
  () => indicator.emaInstances,
  () => { if (!disposed) syncEmaSeries() },
  { deep: true },
)

/**
 * 结构性 K 线变化（历史整表替换 / 分页 / 清空）：数组引用变化即触发。
 * 刻意**不加 deep** —— 实时 tick 只原地更新最后一根、不改变数组引用，因此不会进入这里（走 updateSignal 增量路径）。
 */
watch(
  () => props.data,
  () => {
    if (disposed) return
    // 切换标的 / 周期 / 历史整表替换：清空未完成绘制状态与选区
    cancelPending()
    deselect()
    fullRefresh()
  },
)

/**
 * 实时 tick 信号（store.klineVersion）：`flush: 'sync'` 让回调在信号变化的同一次 patch 中执行，
 * 即 store.update() → series.update() 之间不存在 rAF / setTimeout / debounce 延迟，
 * 也不会像 rAF 节流那样在“渲染中”丢弃后续 tick（中途到达的 tick 由 tickPending 补刷）。
 */
watch(
  () => props.updateSignal,
  () => applyRealtimeTick(),
  { flush: 'sync' },
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
    // 跨标的切换后清空上一品种的持仓线拖拽草稿与右键菜单
    draftSl.value = null
    draftTp.value = null
    bracketTarget.value = null
    ctxMenu.value = null
    if (mode.value === 'bracket-drag') {
      mode.value = 'idle'
      chart?.applyOptions({ handleScroll: { pressedMouseMove: true } })
    }
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
    // 右键快捷下单：需要图表的物理坐标 → 价格 / 时间
    el.addEventListener('contextmenu', handleContextMenu)
    // 分页启用：用户滚动 / 拖拽 / 触屏后才允许向左加载更早历史（见 armPagination）
    el.addEventListener('wheel', armPagination, { passive: true })
    el.addEventListener('mousedown', armPagination)
    el.addEventListener('touchstart', armPagination, { passive: true })
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
  // 仅左键参与画线 / 持仓线拖拽（右键由 contextmenu 处理，中键留给图表平移）
  if (e.button !== 0) return
  const x = e.offsetX
  const y = e.offsetY

  // 持仓线 TP/SL 右缘手柄 → 拖拽设置止盈/止损（优先于画线锚点命中）
  if (positionPrimitive && activePosition.value) {
    const hd = positionPrimitive.handles().find((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)
    if (hd) {
      e.preventDefault()
      chart?.applyOptions({ handleScroll: { pressedMouseMove: false } })
      const entry = activePosition.value.entryPrice
      const price = positionPrimitive.yToPrice(y)
      const start = price != null ? roundToTick(price, entry) : entry
      mode.value = 'bracket-drag'
      bracketTarget.value = hd.kind
      if (hd.kind === 'tp') draftTp.value = start
      else draftSl.value = start
      // 仅当真正发生拖拽位移（≥4px）才在 mouseup 提交，防止误点手柄误下保护单
      bracketDragStartY = e.clientY
      bracketDragMoved = false
      syncPositionOverlay()
      return
    }
  }

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
  // 持仓线 TP/SL 拖拽：鼠标 y → 价格，实时更新草稿线预览
  if (mode.value === 'bracket-drag' && positionPrimitive && activePosition.value && container.value) {
    const rect = container.value.getBoundingClientRect()
    if (Math.abs(e.clientY - bracketDragStartY) >= 4) bracketDragMoved = true
    const price = positionPrimitive.yToPrice(e.clientY - rect.top)
    if (price == null) return
    const p = roundToTick(price, activePosition.value.entryPrice)
    if (bracketTarget.value === 'tp') draftTp.value = p
    else if (bracketTarget.value === 'sl') draftSl.value = p
    syncPositionOverlay()
    return
  }
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
  // 结束 TP/SL 手柄拖拽：恢复平移；仅在有实际位移时提交保护腿挂单
  if (mode.value === 'bracket-drag') {
    mode.value = 'idle'
    chart?.applyOptions({ handleScroll: { pressedMouseMove: true } })
    if (bracketDragMoved) {
      void commitBracketDrag()
    } else {
      draftSl.value = null
      draftTp.value = null
      bracketTarget.value = null
      syncPositionOverlay()
    }
    return
  }
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

// ---- 图表右键快捷下单菜单 ----
function handleContextMenu(e: MouseEvent) {
  e.preventDefault()
  const el = container.value
  if (!el || !primitive) return
  const rect = el.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  const pt = primitive.screenToPoint(x, y)
  if (!pt) return
  const W = el.clientWidth
  const H = el.clientHeight
  ctxMenu.value = {
    x: Math.max(2, Math.min(x, W - 196)),
    y: Math.max(2, Math.min(y, H - 220)),
    price: pt.price,
    time: pt.time,
  }
}

/** 点击菜单外部任意位置时关闭右键菜单。 */
function onWindowPointerDown(e: MouseEvent) {
  if (!ctxMenu.value) return
  const t = e.target as HTMLElement | null
  if (t && t.closest('.ctx-menu')) return
  ctxMenu.value = null
}
watch(ctxMenu, (menu) => {
  if (menu) window.addEventListener('mousedown', onWindowPointerDown)
  else window.removeEventListener('mousedown', onWindowPointerDown)
})

/** 按价格自身精度动态格式化（右键菜单价格展示）。 */
function fmtDynamicPrice(n: number): string {
  if (!Number.isFinite(n)) return '--'
  const s = String(n)
  const dot = s.indexOf('.')
  const dec = dot >= 0 ? Math.min(6, s.length - dot - 1) : 2
  return n.toLocaleString('en-US', { minimumFractionDigits: Math.min(dec, 2), maximumFractionDigits: Math.max(dec, 2) })
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
    // 取消持仓线 TP/SL 拖拽（不提交保护腿）
    if (mode.value === 'bracket-drag') {
      mode.value = 'idle'
      chart?.applyOptions({ handleScroll: { pressedMouseMove: true } })
      draftSl.value = null
      draftTp.value = null
      bracketTarget.value = null
      syncPositionOverlay()
    }
    closeCtxMenu()
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

    <!-- 图表右键快捷下单菜单：自动取鼠标处价格/时间（北京时间展示） -->
    <div
      v-if="ctxMenu"
      class="ctx-menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @mousedown.stop
      @contextmenu.prevent
    >
      <div class="ctx-head">
        <b>⚡ {{ fmtDynamicPrice(ctxMenu.price) }}</b>
        <span>北京时间 {{ formatBeijingDateTime(ctxMenu.time, true) }}</span>
      </div>
      <button class="ctx-item buy" @click="openQuickOrder({ side: 'BUY', type: 'LIMIT', price: ctxMenu.price })">
        在此价格买入 / 开多（限价）
      </button>
      <button class="ctx-item sell" @click="openQuickOrder({ side: 'SELL', type: 'LIMIT', price: ctxMenu.price })">
        在此价格卖出 / 开空（限价）
      </button>
      <div class="ctx-sep"></div>
      <button
        class="ctx-item"
        @click="openQuickOrder({ side: ctxReduceSide, type: 'LIMIT', price: ctxMenu.price })"
      >
        在此价格设置止盈（TP·限价平仓）
      </button>
      <button
        class="ctx-item"
        @click="openQuickOrder({ side: ctxReduceSide, type: 'STOP', price: ctxMenu.price })"
      >
        在此价格设置止损（SL·止损触发）
      </button>
    </div>
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

/* ---- 图表右键快捷下单菜单 ---- */
.ctx-menu {
  position: absolute;
  z-index: 60;
  min-width: 190px;
  background: var(--color-bg-secondary, #1a1f26);
  border: 1px solid var(--color-border, #1e293b);
  border-radius: 8px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5);
  padding: 5px;
  user-select: none;
}
.ctx-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px 7px;
  border-bottom: 1px solid var(--color-border, #1e293b);
  white-space: nowrap;
}
.ctx-head b {
  font-family: monospace;
  font-size: 13px;
  color: #3b82f6;
}
.ctx-head span {
  font-size: 10px;
  color: var(--color-text-muted, #8090a5);
}
.ctx-item {
  display: block;
  width: 100%;
  margin-top: 3px;
  padding: 7px 9px;
  text-align: left;
  background: transparent;
  color: var(--color-text, #d1d5db);
  border: 1px solid transparent;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.ctx-item:hover {
  background: var(--color-bg-tertiary, #242b34);
  border-color: rgba(59, 130, 246, 0.4);
}
.ctx-item.buy { color: #26a69a; }
.ctx-item.buy:hover { background: rgba(38, 166, 154, 0.12); }
.ctx-item.sell { color: #ef534f; }
.ctx-item.sell:hover { background: rgba(239, 83, 79, 0.12); }
.ctx-sep {
  height: 1px;
  margin: 4px 2px;
  background: var(--color-border, #1e293b);
}
</style>

