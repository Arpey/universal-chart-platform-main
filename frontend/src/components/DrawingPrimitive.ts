import type {
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  IChartApiBase,
  SeriesAttachedParameter,
  Time,
  ISeriesApi,
  SeriesType,
  ISeriesPrimitiveAxisView,
} from 'lightweight-charts'
import type { DrawObject, DrawPoint, DrawKind, LineStyle } from '../types/drawing'
import { FIB_LEVELS, FIBEXT_LEVELS } from '../types/drawing'

/** 原始 K 线（供标尺计算 bars/成交量） */
interface Kline { time: number; open: number; high: number; low: number; close: number; volume: number }

export interface PreviewData {
  kind: Exclude<DrawKind, 'cursor'>
  points: DrawPoint[]
  color: string
}

interface Renderer extends IPrimitivePaneRenderer {
  draw(target: unknown): void
}

interface View extends IPrimitivePaneView {
  renderer(): Renderer | null
}

export type HitResult = { id: string; index: number } | { id: string; body: true }

/** #rrggbb → rgba() 工具 */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(full, 16)
  if (Number.isNaN(n)) return `rgba(59,130,246,${alpha})`
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

/** 由价格本身推导小数位（默认 2 位，上限 8 位）。 */
function priceDecimals(p: number): number {
  const s = String(p)
  const dot = s.indexOf('.')
  return dot >= 0 ? Math.min(8, s.length - dot - 1) : 2
}

/** 价格格式化（与源价格小数位一致）。 */
function fmtPrice(v: number, dec?: number): string {
  return v.toFixed(dec != null ? dec : priceDecimals(v))
}

/** 斐波那契层级数字格式化：整数不带小数（1 → "1"），0.500 → "0.5"。 */
function fmtLevel(lv: number): string {
  if (Number.isInteger(lv)) return String(lv)
  return lv.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

function formatTimeAxis(timeSec: number): string {
  const d = new Date(timeSec * 1000)
  const p = (v: number) => String(v).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${s}s`
}

/** 兼容 number / BusinessDay / string 的 Time → 秒。 */
function normalizeTime(t: unknown): number | null {
  if (typeof t === 'number') return Number.isFinite(t) ? t : null
  if (typeof t === 'string') {
    const n = Date.parse(t) / 1000
    return Number.isNaN(n) ? null : n
  }
  if (t && typeof t === 'object') {
    const bd = t as { year?: number; month?: number; day?: number }
    if (bd.year != null && bd.month != null && bd.day != null) {
      return Date.UTC(bd.year, bd.month - 1, bd.day) / 1000
    }
  }
  return null
}

/**
 * 画线渲染引擎（lightweight-charts 插件叠加层）。
 * - 存储/渲染均基于 {time, price} 物理坐标，缩放/平移自动重定位。
 * - 已支持工具：ray（射线）、vline（垂直线 + 时间轴标签）、ruler（测量工具）。
 * - 提供锚点/线体命中检测、选中控制点与幽灵预览渲染。
 */
export class DrawingPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null
  private series: ISeriesApi<SeriesType, Time> | null = null
  private requestUpdate: (() => void) | null = null

  private _objects: DrawObject[] = []
  private _selectedId: string | null = null
  private _preview: PreviewData | null = null
  private _klines: Kline[] = []
  private _lastW = 0

  setObjects(objects: DrawObject[], selectedId: string | null = null) {
    this._objects = objects
    this._selectedId = selectedId
    this.redraw()
  }

  setPreview(preview: PreviewData | null) {
    this._preview = preview
    this.redraw()
  }

  /** 强制触发一次 Canvas 重绘（requestUpdate → 图表重绘该叠加层 pane）。任何画线数据变更后必须调用。 */
  redraw() {
    this.requestUpdate?.()
  }

  setKlines(data: Kline[]) {
    // 统一到秒级时间戳：部分数据源可能下发毫秒 openTime，而画线时间戳恒为秒。
    // 未归一化会导致 Nearest Bar Alignment 用「毫秒 vs 秒」比对而错位 → 画线永久隐形。
    this._klines = data.map((k) => (k.time >= 1e12 ? { ...k, time: Math.floor(k.time / 1000) } : k))
    this.redraw()
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>) {
    this.chart = param.chart
    this.series = param.series
    this.requestUpdate = param.requestUpdate
  }

  detached() {
    this.chart = null
    this.series = null
    this.requestUpdate = null
  }

  // ---------- 坐标换算 ----------

  /** 坐标合法性校验：null / undefined / NaN / ±Infinity 一律视为无效（NaN 会绕过 `== null` 守卫导致隐形画线）。 */
  private isValidCoordinate(v: number | null | undefined): v is number {
    return typeof v === 'number' && Number.isFinite(v)
  }

  priceToY(price: number): number | null {
    if (!this.series || !this.isValidCoordinate(price)) return null
    const v = this.series.priceToCoordinate(price)
    return this.isValidCoordinate(v) ? v : null
  }

  yToPrice(y: number): number | null {
    if (!this.series || !this.isValidCoordinate(y)) return null
    const v = this.series.coordinateToPrice(y)
    return this.isValidCoordinate(v) ? v : null
  }

  timeToX(time: number): number | null {
    if (!this.chart || !this.isValidCoordinate(time)) return null
    const exact = this.chart.timeScale().timeToCoordinate(time as Time)
    if (this.isValidCoordinate(exact)) return exact
    // Nearest Bar Alignment：时间戳落在非 Bar 整点（如跨周期后 1m 点位在 1d 视图）时，
    // 对齐到当前周期最近 K 线再映射，保证画线任何周期都可见、可命中。
    if (!this._klines.length) return null
    let nearest = time
    let bestDiff = Infinity
    for (const k of this._klines) {
      const d = Math.abs(k.time - time)
      if (d < bestDiff) {
        bestDiff = d
        nearest = k.time
      }
    }
    const v = this.chart.timeScale().timeToCoordinate(nearest as Time)
    return this.isValidCoordinate(v) ? v : null
  }

  screenToPoint(x: number, y: number): DrawPoint | null {
    if (!this.chart || !this.series || !this.isValidCoordinate(x) || !this.isValidCoordinate(y)) return null
    const t = this.chart.timeScale().coordinateToTime(x) as Time | null
    const price = this.series.coordinateToPrice(y)
    if (t == null || !this.isValidCoordinate(price)) return null
    const time = normalizeTime(t)
    if (time == null) return null
    // 吸附到最近 K 线的精确时间戳：保证 timeToCoordinate 在任何周期都能命中（跨周期画线正确性）
    return { time: this.snapTimeToBar(time), price }
  }

  /** 将时间吸附到最近 K 线的精确时间戳（跨周期画线正确性的关键）。 */
  private snapTimeToBar(time: number): number {
    if (!this._klines.length) return time
    let best = this._klines[0].time
    let bestDiff = Infinity
    for (const k of this._klines) {
      const d = Math.abs(k.time - time)
      if (d < bestDiff) {
        bestDiff = d
        best = k.time
      }
    }
    return best
  }

  // ---------- 视口视图 ----------
  paneViews(): readonly View[] {
    const self = this
    return [
      {
        renderer(): Renderer | null {
          return {
            draw(target: unknown) {
              self.drawAll(target as any)
            },
          }
        },
      },
    ]
  }

  /** 垂直线的时间轴日期标签（TradingView 风格：底部时间轴显示时间）。 */
  timeAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    const views: ISeriesPrimitiveAxisView[] = []
    for (const obj of this._objects) {
      if (obj.kind !== 'vline') continue
      const time = obj.points[0]?.time
      if (time == null) continue
      views.push({
        coordinate: () => this.timeToX(time) ?? -100000,
        text: () => formatTimeAxis(time),
        textColor: () => '#0f1419',
        backColor: () => obj.color,
        tickVisible: () => false,
      })
    }
    return views
  }

  // ---------- 命中检测 ----------
  hitTestObjects(objects: DrawObject[], x: number, y: number): HitResult | null {
    for (const obj of [...objects].reverse()) {
      const r = this.hitRadius(obj)
      for (let i = 0; i < obj.points.length; i++) {
        const px = this.timeToX(obj.points[i].time)
        const py = this.priceToY(obj.points[i].price)
        if (px != null && py != null && Math.abs(px - x) <= r && Math.abs(py - y) <= r) {
          return { id: obj.id, index: i }
        }
      }
      if (obj.kind === 'vline') {
        const px = this.timeToX(obj.points[0].time)
        if (px != null && Math.abs(px - x) <= r) return { id: obj.id, body: true }
      } else if (obj.kind === 'hray') {
        if (this.hitHRay(obj, x, y, r)) return { id: obj.id, body: true }
      } else if (obj.kind === 'trend') {
        if (this.hitSegment(obj, x, y, r)) return { id: obj.id, body: true }
      } else if (obj.kind === 'ray') {
        if (this.hitRay(obj, x, y, r)) return { id: obj.id, body: true }
      } else if (obj.kind === 'ruler') {
        if (this.hitRuler(obj, x, y, r)) return { id: obj.id, body: true }
      } else if (obj.kind === 'long' || obj.kind === 'short') {
        if (this.hitPosition(obj, x, y, r)) return { id: obj.id, body: true }
      } else if (obj.kind === 'fib') {
        if (this.hitFib(obj, x, y, r)) return { id: obj.id, body: true }
      } else if (obj.kind === 'fibext') {
        if (this.hitFibExt(obj, x, y, r)) return { id: obj.id, body: true }
      }
    }
    return null
  }

  /** 命中容差：至少 10px，且随线宽增大，避免粗线难点中。 */
  private hitRadius(obj: DrawObject): number {
    return Math.max(10, obj.lineWidth + 6)
  }

  private hitRay(obj: DrawObject, x: number, y: number, r: number): boolean {
    const [a, b] = obj.points
    if (b == null) return false
    const x0 = this.timeToX(a.time); const y0 = this.priceToY(a.price)
    const x1 = this.timeToX(b.time); const y1 = this.priceToY(b.price)
    if (x0 == null || y0 == null || x1 == null || y1 == null) return false
    const dx = x1 - x0
    let xEnd = this._lastW
    let yEnd = y1
    if (Math.abs(dx) > 0.0001) yEnd = y0 + ((y1 - y0) / dx) * (xEnd - x0)
    return this.distToSegment(x, y, x0, y0, xEnd, yEnd) <= r
  }

  private hitRuler(obj: DrawObject, x: number, y: number, r: number): boolean {
    const [a, b] = obj.points
    if (b == null) return false
    const x0 = this.timeToX(a.time); const y0 = this.priceToY(a.price)
    const x1 = this.timeToX(b.time); const y1 = this.priceToY(b.price)
    if (x0 == null || y0 == null || x1 == null || y1 == null) return false
    const rx = Math.min(x0, x1); const ry = Math.min(y0, y1)
    const rw = Math.abs(x1 - x0); const rh = Math.abs(y1 - y0)
    if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) return true
    return (
      this.distToSegment(x, y, x0, y0, x0, y1) <= r
      || this.distToSegment(x, y, x0, y1, x1, y1) <= r
      || this.distToSegment(x, y, x1, y1, x1, y0) <= r
      || this.distToSegment(x, y, x1, y0, x0, y0) <= r
    )
  }

  private hitSegment(obj: DrawObject, x: number, y: number, r: number): boolean {
    const [a, b] = obj.points
    if (b == null) return false
    const x0 = this.timeToX(a.time); const y0 = this.priceToY(a.price)
    const x1 = this.timeToX(b.time); const y1 = this.priceToY(b.price)
    if (x0 == null || y0 == null || x1 == null || y1 == null) return false
    return this.distToSegment(x, y, x0, y0, x1, y1) <= r
  }

  private hitHRay(obj: DrawObject, x: number, y: number, r: number): boolean {
    const a = obj.points[0]
    if (!a) return false
    const x0 = this.timeToX(a.time)
    const y0 = this.priceToY(a.price)
    if (x0 == null || y0 == null) return false
    return Math.abs(y - y0) <= r && x >= x0 - r
  }

  /** 持仓工具线体命中：矩形有限区间 [xL, xR] 内的三条水平价位线（止盈 / 入场 / 止损）。 */
  private hitPosition(obj: DrawObject, x: number, y: number, r: number): boolean {
    const lv = this.positionLevels(obj)
    if (!lv) return false
    const xE = this.timeToX(lv.entry.time)
    if (xE == null) return false
    const xT = this.timeToX(lv.tp.time) ?? xE
    const xS = this.timeToX(lv.sl.time) ?? xE
    const xL = Math.min(xE, xT, xS)
    const xR = Math.max(xE, xT, xS)
    for (const p of [lv.entry, lv.tp, lv.sl]) {
      const y0 = this.priceToY(p.price)
      if (y0 == null) continue
      if (x >= xL - r && x <= xR + r && Math.abs(y - y0) <= r) return true
    }
    return false
  }

  /** 斐波那契回调线体命中：任一勾选启用的层级水平线。 */
  private hitFib(obj: DrawObject, x: number, y: number, r: number): boolean {
    const [a, b] = obj.points
    if (!a || !b) return false
    const xA = this.timeToX(a.time)
    const xB = this.timeToX(b.time)
    if (xA == null || xB == null) return false
    const x0 = Math.min(xA, xB)
    for (const lv of this.fibEnabled(obj)) {
      const y0 = this.priceToY(a.price + (b.price - a.price) * lv)
      if (y0 == null) continue
      if (x >= x0 - r && Math.abs(y - y0) <= r) return true
    }
    return false
  }

  /** 趋势型斐波那契扩展线体命中：从 C 向右的任一勾选启用的扩展层级水平线。 */
  private hitFibExt(obj: DrawObject, x: number, y: number, r: number): boolean {
    const [a, b, c] = obj.points
    if (!a || !b || !c) return false
    const x0 = this.timeToX(c.time)
    if (x0 == null) return false
    const range = b.price - a.price
    for (const lv of this.fibEnabled(obj)) {
      const y0 = this.priceToY(c.price + range * lv)
      if (y0 == null) continue
      if (x >= x0 - r && Math.abs(y - y0) <= r) return true
    }
    return false
  }

  private distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1
    const dy = y2 - y1
    const len2 = dx * dx + dy * dy
    let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
  }

  // ---------- 渲染 ----------
  private _lastWarnAt = 0

  private drawAll(target: any) {
    if (!this.series || typeof target.useMediaCoordinateSpace !== 'function') return
    try {
      target.useMediaCoordinateSpace((scope: any) => {
        const ctx = scope.context as CanvasRenderingContext2D
        const w = scope.mediaSize.width as number
        const h = scope.mediaSize.height as number
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return
        this._lastW = w
        const sorted = [...this._objects].sort((a, b) => a.zIndex - b.zIndex)
        let skipped = 0
        for (const obj of sorted) {
          try {
            this.renderObject(ctx, obj, w, h)
          } catch (err) {
            // 单个坏对象不得击穿整个渲染循环（否则一帧内全部画线消失）
            skipped += 1
            console.error('[DrawingPrimitive] renderObject 渲染异常，已跳过：', obj.kind, obj.id, err)
          }
        }
        if (this._preview) {
          try {
            this.renderPreview(ctx, this._preview, w, h)
          } catch (err) {
            skipped += 1
            console.error('[DrawingPrimitive] renderPreview 渲染异常：', err)
          }
        }
        if (skipped > 0 && Date.now() - this._lastWarnAt > 2000) {
          this._lastWarnAt = Date.now()
          console.warn(`[DrawingPrimitive] ${skipped} 个画线对象渲染失败已跳过（2s 内不再重复告警）`)
        }
      })
    } catch (err) {
      console.error('[DrawingPrimitive] drawAll 渲染循环异常：', err)
    }
  }

  private renderObject(ctx: CanvasRenderingContext2D, obj: DrawObject, w: number, h: number) {
    switch (obj.kind) {
      case 'trend': this.drawTrend(ctx, obj, w, h, false); break
      case 'ray': this.drawRay(ctx, obj, w, h, false); break
      case 'hray': this.drawHRay(ctx, obj, w, h, false); break
      case 'vline': this.drawVline(ctx, obj, w, h, false); break
      case 'ruler': this.drawRuler(ctx, obj, w, h, false); break
      case 'long': this.drawPosition(ctx, obj, w, h, false); break
      case 'short': this.drawPosition(ctx, obj, w, h, false); break
      case 'fib': this.drawFib(ctx, obj, w, h, false); break
      case 'fibext': this.drawFibExt(ctx, obj, w, h, false); break
      default: break // 未实现工具后续扩展
    }
    if (obj.id === this._selectedId) this.drawAnchors(ctx, obj)
  }

  private applyLineStyle(ctx: CanvasRenderingContext2D, style: LineStyle) {
    ctx.setLineDash(style === 'dashed' ? [6, 4] : style === 'dotted' ? [2, 4] : [])
  }

  private drawRay(ctx: CanvasRenderingContext2D, obj: DrawObject, w: number, _h: number, draft: boolean) {
    const [a, b] = obj.points
    if (b == null) return
    const x0 = this.timeToX(a.time); const y0 = this.priceToY(a.price)
    const x1 = this.timeToX(b.time); const y1 = this.priceToY(b.price)
    if (x0 == null || y0 == null || x1 == null || y1 == null) return
    const dx = x1 - x0
    let xEnd = w
    let yEnd = y1
    if (Math.abs(dx) > 0.0001) yEnd = y0 + ((y1 - y0) / dx) * (xEnd - x0)
    ctx.save()
    ctx.strokeStyle = obj.color
    ctx.lineWidth = (draft ? obj.lineWidth : obj.lineWidth + (obj.id === this._selectedId ? 1 : 0))
    ctx.globalAlpha = draft ? 0.55 : 1
    this.applyLineStyle(ctx, draft ? 'dashed' : obj.lineStyle)
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(xEnd, yEnd); ctx.stroke()
    ctx.restore()
  }

  /** 趋势线：纯线段，仅连接 A→B，不向两侧延伸。 */
  private drawTrend(ctx: CanvasRenderingContext2D, obj: DrawObject, _w: number, _h: number, draft: boolean) {
    const [a, b] = obj.points
    if (b == null) return
    const x0 = this.timeToX(a.time); const y0 = this.priceToY(a.price)
    const x1 = this.timeToX(b.time); const y1 = this.priceToY(b.price)
    if (x0 == null || y0 == null || x1 == null || y1 == null) return
    ctx.save()
    ctx.strokeStyle = obj.color
    ctx.lineWidth = (draft ? obj.lineWidth : obj.lineWidth + (obj.id === this._selectedId ? 1 : 0))
    ctx.globalAlpha = draft ? 0.55 : 1
    this.applyLineStyle(ctx, draft ? 'dashed' : obj.lineStyle)
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke()
    ctx.restore()
  }

  /** 水平射线：从 A 的水平位置向右延伸至 Canvas 右缘，左侧不延伸。 */
  private drawHRay(ctx: CanvasRenderingContext2D, obj: DrawObject, w: number, _h: number, draft: boolean) {
    const a = obj.points[0]
    if (!a) return
    const x0 = this.timeToX(a.time)
    const y0 = this.priceToY(a.price)
    if (x0 == null || y0 == null) return
    ctx.save()
    ctx.strokeStyle = obj.color
    ctx.lineWidth = (draft ? obj.lineWidth : obj.lineWidth + (obj.id === this._selectedId ? 1 : 0))
    ctx.globalAlpha = draft ? 0.55 : 1
    this.applyLineStyle(ctx, draft ? 'dashed' : obj.lineStyle)
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(w, y0); ctx.stroke()
    ctx.restore()
  }

  private drawVline(ctx: CanvasRenderingContext2D, obj: DrawObject, _w: number, h: number, draft: boolean) {
    const x = this.timeToX(obj.points[0].time)
    if (x == null) return
    ctx.save()
    ctx.strokeStyle = obj.color
    ctx.lineWidth = (draft ? obj.lineWidth : obj.lineWidth + (obj.id === this._selectedId ? 1 : 0))
    ctx.globalAlpha = draft ? 0.55 : 1
    this.applyLineStyle(ctx, draft ? 'dashed' : obj.lineStyle)
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
    ctx.restore()
  }

  // ---------- 持仓工具（long / short） ----------

  /**
   * 持仓工具点位结构：
   * - 多头（long）：points = [入场, 止盈, 止损]，止损 = 2×入场 − 止盈（初始镜像，之后可独立拖拽）
   * - 空头（short）：points = [入场, 止损, 止盈]，止盈 = 2×入场 − 止损
   * 缺失第 3 点时（放置过程/预览阶段）自动按镜像推导。
   */
  private positionLevels(obj: DrawObject): { entry: DrawPoint; tp: DrawPoint; sl: DrawPoint } | null {
    const [p0, p1, p2] = obj.points
    if (!p0 || !p1) return null
    if (obj.kind === 'long') {
      const tp = p1
      const sl = p2 ?? { time: p0.time, price: 2 * p0.price - p1.price }
      return { entry: p0, tp, sl }
    }
    const sl = p1
    const tp = p2 ?? { time: p0.time, price: 2 * p0.price - p1.price }
    return { entry: p0, tp, sl }
  }

  /** 斐波那契对象当前勾选启用的层级（无勾选记录时回退默认层级）。 */
  private fibEnabled(obj: DrawObject): number[] {
    if (obj.enabledLevels && obj.enabledLevels.length) return obj.enabledLevels
    return obj.kind === 'fibext' ? FIBEXT_LEVELS : FIB_LEVELS
  }

  /** 持仓工具渲染：有限宽度双色遮罩矩形（TP 恒绿 / SL 恒红）+ 三条水平价位线 + 矩形边框 + 价格标签 + R:R Badge。 */
  private drawPosition(ctx: CanvasRenderingContext2D, obj: DrawObject, w: number, h: number, draft: boolean) {
    const lv = this.positionLevels(obj)
    if (!lv) return
    const xE = this.timeToX(lv.entry.time)
    const yE = this.priceToY(lv.entry.price)
    const yT = this.priceToY(lv.tp.price)
    const yS = this.priceToY(lv.sl.price)
    if (xE == null || yE == null || yT == null || yS == null) return
    const xT = this.timeToX(lv.tp.time) ?? xE
    const xS = this.timeToX(lv.sl.time) ?? xE
    // 有限区间：X 范围取三个锚点时间的 min/max（不贯穿图表右缘）
    let xL = Math.min(xE, xT, xS)
    let xR = Math.max(xE, xT, xS)
    // 零宽矩形（两点同 X 竖直拖拽）会整体隐形：强制最小 1px 可见宽度
    if (xR - xL < 1) xR = xL + 1
    ctx.save()
    // 止盈带恒绿色 + 止损带恒红色（两种方向一致）
    ctx.fillStyle = 'rgba(76, 175, 80, 0.25)'
    ctx.fillRect(xL, Math.min(yT, yE), xR - xL, Math.abs(yT - yE))
    ctx.fillStyle = 'rgba(244, 67, 54, 0.25)'
    ctx.fillRect(xL, Math.min(yE, yS), xR - xL, Math.abs(yE - yS))
    // 左右竖直边框，闭合矩形
    ctx.strokeStyle = hexToRgba(obj.color, draft ? 0.5 : 0.9)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(xL, Math.min(yT, yS)); ctx.lineTo(xL, Math.max(yT, yS))
    ctx.moveTo(xR, Math.min(yT, yS)); ctx.lineTo(xR, Math.max(yT, yS))
    ctx.stroke()
    ctx.restore()
    const dec = priceDecimals(lv.entry.price)
    this.drawLevelLine(ctx, xL, xR, lv.tp.price, draft, '#26a69a', fmtPrice(lv.tp.price, dec), w)
    this.drawLevelLine(ctx, xL, xR, lv.entry.price, draft, obj.color, fmtPrice(lv.entry.price, dec), w)
    this.drawLevelLine(ctx, xL, xR, lv.sl.price, draft, '#ef534f', fmtPrice(lv.sl.price, dec), w)
    this.drawPositionBadge(ctx, obj, lv, xL, xR, w, h)
  }

  /** 单条水平价位线（x0→x1 有限区间）+ 右缘价格标签。 */
  private drawLevelLine(ctx: CanvasRenderingContext2D, x0: number, x1: number, price: number, draft: boolean, color: string, label: string, clampW: number) {
    const y = this.priceToY(price)
    if (y == null) return
    ctx.save()
    ctx.strokeStyle = hexToRgba(color, draft ? 0.6 : 0.95)
    ctx.lineWidth = draft ? 1 : 1.5
    this.applyLineStyle(ctx, draft ? 'dashed' : 'solid')
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke()
    ctx.restore()
    this.drawRightLabel(ctx, label, color, y, x1, clampW)
  }

  /** 价格/层级标签：深色圆角小药丸，贴 anchorX 左侧放置（越界自动钳制进画布）。 */
  private drawRightLabel(ctx: CanvasRenderingContext2D, text: string, color: string, y: number, anchorX: number, clampW: number) {
    ctx.save()
    ctx.font = '10px Manrope, monospace'
    const tw = ctx.measureText(text).width
    const bw = tw + 10
    let bx = anchorX - bw - 6
    if (bx < 2) bx = 2
    if (bx + bw > clampW - 2) bx = Math.max(2, clampW - bw - 2)
    const by = y - 9
    ctx.fillStyle = 'rgba(15, 20, 25, 0.88)'
    this.roundRectPath(ctx, bx, by, bw, 18, 3)
    ctx.fill()
    ctx.strokeStyle = hexToRgba(color, 0.7)
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.fillStyle = color
    ctx.textBaseline = 'middle'
    ctx.fillText(text, bx + 5, y)
    ctx.restore()
  }

  /** 持仓 Badge：R:R + TP/SL 价格与百分比幅度（draft 阶段同样实时渲染）。TP 恒绿 / SL 恒红。 */
  private drawPositionBadge(ctx: CanvasRenderingContext2D, obj: DrawObject, lv: { entry: DrawPoint; tp: DrawPoint; sl: DrawPoint }, xL: number, xR: number, w: number, h: number) {
    const E = lv.entry.price
    const TP = lv.tp.price
    const SL = lv.sl.price
    const isLong = obj.kind === 'long'
    // R:R：分子/分母取绝对值，保证恒为正（空头：Entry−TP 与 SL−Entry 均为正）
    const risk = Math.abs(E - SL)
    const reward = Math.abs(TP - E)
    const rr = risk > 0 ? reward / risk : 0
    // 百分比幅度：止盈恒正收益、止损恒负亏损（两种方向按“获利/亏损”方向换算）
    let tpPct: number
    let slPct: number
    if (isLong) {
      tpPct = E !== 0 ? +((TP - E) / E) * 100 : 0
      slPct = E !== 0 ? -((E - SL) / E) * 100 : 0
    } else {
      tpPct = E !== 0 ? +((E - TP) / E) * 100 : 0
      slPct = E !== 0 ? -((SL - E) / E) * 100 : 0
    }
    const dec = priceDecimals(E)
    const lines = [
      { text: `R:R: ${rr.toFixed(2)}`, color: '#e8edf3' },
      { text: `TP: ${fmtPrice(TP, dec)} (${tpPct >= 0 ? '+' : ''}${tpPct.toFixed(2)}%)`, color: '#26a69a' },
      { text: `SL: ${fmtPrice(SL, dec)} (${slPct >= 0 ? '+' : ''}${slPct.toFixed(2)}%)`, color: '#ef534f' },
    ]
    const yE = this.priceToY(E) ?? 0
    const yT = this.priceToY(TP) ?? 0
    const yS = this.priceToY(SL) ?? 0
    const top = Math.min(yE, yT, yS)
    const bot = Math.max(yE, yT, yS)
    this.drawBadge(ctx, lines, xL, top, Math.max(1, xR - xL), Math.max(1, bot - top), w, h)
  }

  // ---------- 斐波那契回调（fib） ----------

  /** 斐波那契回调：A→B 确定趋势，仅绘制勾选启用的层级 + 相邻层级交替半透明色带 + 右缘「比例 (价格)」标签。 */
  private drawFib(ctx: CanvasRenderingContext2D, obj: DrawObject, w: number, _h: number, draft: boolean) {
    const [a, b] = obj.points
    if (!a || !b) return
    const xA = this.timeToX(a.time)
    const xB = this.timeToX(b.time)
    if (xA == null || xB == null) return
    const x0 = Math.min(xA, xB)
    const dec = priceDecimals(a.price)
    const levels = this.fibEnabled(obj)
    const prices = levels.map((lv) => a.price + (b.price - a.price) * lv)
    ctx.save()
    // 相邻已勾选层级间交替半透明色带
    for (let i = 0; i < levels.length - 1; i++) {
      const y1 = this.priceToY(prices[i])
      const y2 = this.priceToY(prices[i + 1])
      if (y1 == null || y2 == null) continue
      ctx.fillStyle = hexToRgba(obj.color, i % 2 === 0 ? 0.12 : 0.24)
      ctx.fillRect(x0, Math.min(y1, y2), w - x0, Math.abs(y1 - y2))
    }
    // 已勾选层级水平线 + 右缘标签
    for (let i = 0; i < levels.length; i++) {
      const y = this.priceToY(prices[i])
      if (y == null) continue
      ctx.strokeStyle = hexToRgba(obj.color, draft ? 0.7 : 0.95)
      ctx.lineWidth = i === 0 || i === levels.length - 1 ? 1.5 : 1
      this.applyLineStyle(ctx, draft ? 'dashed' : 'solid')
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(w, y); ctx.stroke()
      this.drawRightLabel(ctx, `${fmtLevel(levels[i])} (${fmtPrice(prices[i], dec)})`, hexToRgba(obj.color, 1), y, w, w)
    }
    ctx.restore()
  }

  // ---------- 趋势型斐波那契扩展（fibext） ----------

  /** 趋势型斐波那契扩展：A→B 主趋势 + C 回调点，从 C 向右绘制勾选启用的扩展层级（C 未定时渲染 A→B 引导虚线）。 */
  private drawFibExt(ctx: CanvasRenderingContext2D, obj: DrawObject, w: number, _h: number, draft: boolean) {
    const [a, b, c] = obj.points
    if (!a || !b) return
    const xA = this.timeToX(a.time)
    const yA = this.priceToY(a.price)
    const xB = this.timeToX(b.time)
    const yB = this.priceToY(b.price)
    if (xA == null || xB == null || yA == null || yB == null) return
    ctx.save()
    // A→B 主趋势引导线
    ctx.strokeStyle = hexToRgba(obj.color, 0.75)
    ctx.lineWidth = 1
    this.applyLineStyle(ctx, draft ? 'dashed' : obj.lineStyle)
    ctx.beginPath(); ctx.moveTo(xA, yA); ctx.lineTo(xB, yB); ctx.stroke()
    if (!c) {
      ctx.restore()
      return
    }
    const xC = this.timeToX(c.time)
    if (xC == null) {
      ctx.restore()
      return
    }
    const range = b.price - a.price
    const dec = priceDecimals(c.price)
    const levels = this.fibEnabled(obj)
    const prices = levels.map((lv) => c.price + range * lv)
    // 相邻已勾选层级间交替半透明色带
    for (let i = 0; i < levels.length - 1; i++) {
      const y1 = this.priceToY(prices[i])
      const y2 = this.priceToY(prices[i + 1])
      if (y1 == null || y2 == null) continue
      ctx.fillStyle = hexToRgba(obj.color, i % 2 === 0 ? 0.1 : 0.22)
      ctx.fillRect(xC, Math.min(y1, y2), w - xC, Math.abs(y1 - y2))
    }
    // 已勾选层级水平线 + 右缘标签
    for (let i = 0; i < levels.length; i++) {
      const y = this.priceToY(prices[i])
      if (y == null) continue
      ctx.strokeStyle = hexToRgba(obj.color, draft ? 0.7 : 0.95)
      ctx.lineWidth = levels[i] === 1 ? 1.5 : 1
      this.applyLineStyle(ctx, draft ? 'dashed' : 'solid')
      ctx.beginPath(); ctx.moveTo(xC, y); ctx.lineTo(w, y); ctx.stroke()
      this.drawRightLabel(ctx, `${fmtLevel(levels[i])} (${fmtPrice(prices[i], dec)})`, hexToRgba(obj.color, 1), y, w, w)
    }
    ctx.restore()
  }

  private drawRuler(ctx: CanvasRenderingContext2D, obj: DrawObject, w: number, h: number, draft: boolean) {
    const [a, b] = obj.points
    if (b == null) return
    const x0 = this.timeToX(a.time); const y0 = this.priceToY(a.price)
    const x1 = this.timeToX(b.time); const y1 = this.priceToY(b.price)
    if (x0 == null || y0 == null || x1 == null || y1 == null) return
    const rx = Math.min(x0, x1); const ry = Math.min(y0, y1)
    const rw = Math.abs(x1 - x0); const rh = Math.abs(y1 - y0)
    ctx.save()
    // TradingView 风格：固定蓝色半透明填充 + 虚线边框
    ctx.fillStyle = 'rgba(33, 150, 243, 0.15)'
    ctx.fillRect(rx, ry, rw, rh)
    ctx.strokeStyle = hexToRgba(obj.color, draft ? 0.6 : 0.95)
    ctx.lineWidth = draft ? 1 : obj.lineWidth
    this.applyLineStyle(ctx, 'dashed')
    ctx.strokeRect(rx, ry, rw, rh)
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke()
    ctx.restore()
    // draft 阶段同样渲染 Badge：绘制过程中随 mousemove 实时刷新 4 项数据
    this.drawRulerLabels(ctx, obj, rx, ry, rw, rh, w, h)
  }

  private drawRulerLabels(ctx: CanvasRenderingContext2D, obj: DrawObject, rx: number, ry: number, rw: number, rh: number, w: number, h: number) {
    const [a, b] = obj.points
    const t0 = Math.min(a.time, b.time)
    const t1 = Math.max(a.time, b.time)
    let bars = 0
    for (const k of this._klines) {
      if (k.time >= t0 && k.time <= t1) bars += 1
    }
    const dP = b.price - a.price
    const pct = a.price !== 0 ? (dP / a.price) * 100 : 0
    const ticks = Math.round(Math.abs(dP) / this.tickSize(obj))
    const lines = [
      { text: `${dP >= 0 ? '+' : ''}${dP.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`, color: dP >= 0 ? '#26a69a' : '#ef534f' },
      { text: `${bars} bars`, color: '#d1d5db' },
      { text: formatDuration(t1 - t0), color: '#d1d5db' },
      { text: `${ticks} ticks`, color: '#8090a5' },
    ]
    // Badge 贴合矩形左边框、垂直居中（越界自动钳制到框内左侧）
    this.drawBadge(ctx, lines, rx, ry, rw, rh, w, h)
  }

  /** 由价格小数位推导最小变动价位（tick），用于 ruler 的 ticks 计数。 */
  private tickSize(obj: DrawObject): number {
    const p = obj.points[0]?.price
    if (!p || !Number.isFinite(p)) return 0.01
    const str = String(p)
    const dot = str.indexOf('.')
    const decimals = dot >= 0 ? Math.min(8, str.length - dot - 1) : 0
    return Math.pow(10, -decimals)
  }

  private drawBadge(ctx: CanvasRenderingContext2D, lines: { text: string; color?: string }[], rx: number, ry: number, rw: number, rh: number, w: number, h: number) {
    ctx.save()
    ctx.font = '10px Manrope, monospace'
    const lineH = 14
    const padX = 8
    const padY = 5
    let maxW = 0
    for (const l of lines) maxW = Math.max(maxW, ctx.measureText(l.text).width)
    const bw = maxW + padX * 2
    const bh = lines.length * lineH + padY
    // 左侧定位：默认贴左框外侧，空间不足则贴左框内侧
    let bx = rx - bw - 6
    if (bx < 2) bx = rx + 6
    if (bx + bw > w - 2) bx = Math.max(2, w - bw - 2)
    let by = ry + rh / 2 - bh / 2
    if (by < 2) by = 2
    if (by + bh > h - 2) by = Math.max(2, h - bh - 2)
    ctx.fillStyle = 'rgba(15, 20, 25, 0.92)'
    this.roundRectPath(ctx, bx, by, bw, bh, 6)
    ctx.fill()
    ctx.strokeStyle = 'rgba(33, 150, 243, 0.6)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.textBaseline = 'middle'
    lines.forEach((l, i) => {
      ctx.fillStyle = l.color ?? '#e8edf3'
      ctx.fillText(l.text, bx + padX, by + padY + i * lineH + lineH / 2)
    })
    ctx.restore()
  }

  private roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }

  private drawAnchors(ctx: CanvasRenderingContext2D, obj: DrawObject) {
    ctx.save()
    for (const p of obj.points) {
      const x = this.timeToX(p.time)
      const y = this.priceToY(p.price)
      if (x == null || y == null) continue
      ctx.beginPath()
      ctx.arc(x, y, 4.5, 0, Math.PI * 2)
      ctx.fillStyle = '#ffffff'
      ctx.fill()
      ctx.strokeStyle = obj.color
      ctx.lineWidth = 2
      ctx.stroke()
    }
    ctx.restore()
  }

  private renderPreview(ctx: CanvasRenderingContext2D, preview: PreviewData, w: number, h: number) {
    const draftObj: DrawObject = {
      id: '__preview__',
      kind: preview.kind,
      color: preview.color,
      points: preview.points,
      lineWidth: 1,
      lineStyle: 'dashed',
      locked: false,
      zIndex: Number.MAX_SAFE_INTEGER,
      createdAt: 0,
    }
    switch (preview.kind) {
      case 'trend': this.drawTrend(ctx, draftObj, w, h, true); break
      case 'ray': this.drawRay(ctx, draftObj, w, h, true); break
      case 'hray': this.drawHRay(ctx, draftObj, w, h, true); break
      case 'vline': this.drawVline(ctx, draftObj, w, h, true); break
      case 'ruler': this.drawRuler(ctx, draftObj, w, h, true); break
      case 'long': this.drawPosition(ctx, draftObj, w, h, true); break
      case 'short': this.drawPosition(ctx, draftObj, w, h, true); break
      case 'fib': this.drawFib(ctx, draftObj, w, h, true); break
      case 'fibext': this.drawFibExt(ctx, draftObj, w, h, true); break
      default: break
    }
  }
}
