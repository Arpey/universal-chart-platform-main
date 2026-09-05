import type {
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  Time,
  ISeriesApi,
  SeriesType,
} from 'lightweight-charts'

/**
 * TradingView 风格「持仓线 + 实时盈亏」叠加层（附着于 K 线 series 的 pane）。
 *
 * 渲染内容：
 * - 持仓均价水平线（贯穿 pane）+ 右缘方向/数量胶囊（▲ 多 · 2）；
 * - 止盈（TP）/ 止损（SL）价位线：已有 bracket 值画实线，仅建议值画半透明“幽灵”虚线；
 * - 每根 TP/SL 线在右缘提供可拖拽手柄（记录几何区域供 TradingChart 做命中检测）；
 * - 右上角实时盈亏卡片：方向、数量、均价、现价、浮动盈亏（金额 + 百分比）。
 *
 * 坐标换算：直接用 series.priceToCoordinate / coordinateToPrice，
 * 缩放 / 平移 / 自动缩放时随 canvas 重绘自动对齐，无需外部 DOM 同步。
 */
export class PositionLinePrimitive implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType, Time> | null = null
  private requestUpdate: (() => void) | null = null

  private _state: PositionLineState | null = null
  /** 最近一次绘制记录的手柄命中区（供 TradingChart mousedown 判断拖拽）。 */
  private _handles: { kind: 'tp' | 'sl'; x0: number; y0: number; x1: number; y1: number }[] = []

  setState(state: PositionLineState | null) {
    this._state = state
    this.requestUpdate?.()
  }

  /** 上一帧记录的 TP/SL 手柄命中区（screen/px，基于 pane 坐标系）。 */
  handles(): readonly { kind: 'tp' | 'sl'; x0: number; y0: number; x1: number; y1: number }[] {
    return this._handles
  }

  priceToY(price: number): number | null {
    if (!this.series) return null
    const v = this.series.priceToCoordinate(price)
    return Number.isFinite(v) ? v : null
  }

  yToPrice(y: number): number | null {
    if (!this.series) return null
    const v = this.series.coordinateToPrice(y)
    return Number.isFinite(v) ? v : null
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>) {
    this.series = param.series
    this.requestUpdate = param.requestUpdate
  }

  detached() {
    this.series = null
    this.requestUpdate = null
    this._state = null
    this._handles = []
  }

  paneViews(): readonly IPrimitivePaneView[] {
    const self = this
    return [
      {
        renderer(): IPrimitivePaneRenderer | null {
          return {
            draw(target: unknown) {
              self.render(target as any)
            },
          }
        },
      },
    ]
  }

  private render(target: any) {
    if (!this.series || !this._state) return
    if (typeof target.useMediaCoordinateSpace !== 'function') return
    target.useMediaCoordinateSpace((scope: any) => {
      const ctx = scope.context as CanvasRenderingContext2D
      const w = scope.mediaSize.width as number
      const h = scope.mediaSize.height as number
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return
      this._handles = []
      try {
        this.drawAll(ctx, w, h)
      } catch (err) {
        console.error('[PositionLinePrimitive] 渲染异常：', err)
      }
    })
  }

  private drawAll(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const s = this._state!
    const isLong = s.side === 'BUY'
    const accent = isLong ? COLOR_BUY : COLOR_SELL
    const tp = s.draftTakeProfit ?? s.takeProfit
    const sl = s.draftStopLoss ?? s.stopLoss
    const showTpGhost = !s.takeProfit && !s.draftTakeProfit && s.suggestedTakeProfit != null
    const showSlGhost = !s.stopLoss && !s.draftStopLoss && s.suggestedStopLoss != null
    const dragging = s.dragging

    const yEntry = this.series!.priceToCoordinate(s.entry)
    const yTp = tp != null
      ? this.series!.priceToCoordinate(tp)
      : showTpGhost
        ? this.series!.priceToCoordinate(s.suggestedTakeProfit!)
        : null
    const ySl = sl != null
      ? this.series!.priceToCoordinate(sl)
      : showSlGhost
        ? this.series!.priceToCoordinate(s.suggestedStopLoss!)
        : null

    // ---- 持仓均价线（主强调，宽贯穿） ----
    if (Number.isFinite(yEntry)) {
      this.hLine(ctx, 0, w, yEntry as number, accent, 1.8, [])
      this.chip(ctx, entryLabel(s), accent, yEntry as number, w, h, { emphasized: true })
    }

    // ---- 止盈线 ----
    if (Number.isFinite(yTp)) {
      const ghost = tp == null
      this.hLine(ctx, 0, w, yTp as number, COLOR_TP, ghost ? 1 : 1.6, ghost ? [4, 4] : [])
      const chipText = tp != null ? `止盈 ${fmtPrice(tp, decOf(s.entry))}` : '＋ 止盈'
      this.chip(ctx, chipText, COLOR_TP, yTp as number, w, h, { ghost, active: dragging === 'tp' })
      this._handles.push({ kind: 'tp', x0: w - 92, y0: (yTp as number) - 13, x1: w, y1: (yTp as number) + 13 })
    }

    // ---- 止损线 ----
    if (Number.isFinite(ySl)) {
      const ghost = sl == null
      this.hLine(ctx, 0, w, ySl as number, COLOR_SL, ghost ? 1 : 1.6, ghost ? [4, 4] : [])
      const chipText = sl != null ? `止损 ${fmtPrice(sl, decOf(s.entry))}` : '＋ 止损'
      this.chip(ctx, chipText, COLOR_SL, ySl as number, w, h, { ghost, active: dragging === 'sl' })
      this._handles.push({ kind: 'sl', x0: w - 92, y0: (ySl as number) - 13, x1: w, y1: (ySl as number) + 13 })
    }

    // ---- 右上角实时盈亏卡片 ----
    this.pnlCard(ctx, s, accent, w)
  }

  private hLine(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number, color: string, width: number, dash: number[]) {
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.globalAlpha = 0.85
    ctx.setLineDash(dash)
    ctx.beginPath()
    ctx.moveTo(x0, y)
    ctx.lineTo(x1, y)
    ctx.stroke()
    ctx.restore()
  }

  private pnlCard(ctx: CanvasRenderingContext2D, s: PositionLineState, accent: string, w: number) {
    const isLong = s.side === 'BUY'
    const sign = s.pnl >= 0 ? '+' : ''
    const pnlColor = s.pnl >= 0 ? '#26a69a' : '#ef534f'
    const lineH = 15
    const padX = 9
    const padY = 7
    ctx.save()
    ctx.font = '600 11px Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    const head = `${s.symbol} · ${isLong ? '▲ 多' : '▼ 空'} ${s.qty}`
    const rows = [
      head,
      `均价 ${fmtPrice(s.entry, decOf(s.entry))}`,
      `现价 ${fmtPrice(s.mark, decOf(s.mark))}`,
      `盈亏 ${sign}${fmtMoney(s.pnl)}  (${s.pnl >= 0 ? '+' : ''}${s.pnlPct.toFixed(2)}%)`,
    ]
    let maxW = 0
    for (const r of rows) maxW = Math.max(maxW, ctx.measureText(r).width)
    const bw = Math.min(maxW + padX * 2, w - 8)
    const bh = rows.length * lineH + padY + 2
    const bx = Math.max(2, w - bw - 6)
    const by = 8
    ctx.fillStyle = 'rgba(15, 20, 25, 0.9)'
    this.roundRect(ctx, bx, by, bw, bh, 6)
    ctx.fill()
    ctx.strokeStyle = hexToRgba(accent, 0.7)
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.textBaseline = 'middle'
    const colors: (string | null)[] = [accent, '#d1d5db', '#8090a5', pnlColor]
    rows.forEach((row, i) => {
      ctx.fillStyle = colors[i] ?? '#e8edf3'
      ctx.fillText(row, bx + padX, by + padY + 2 + i * lineH + lineH / 2)
    })
    ctx.restore()
  }


  /**
   * 价位线右缘胶囊。emphasized 用于持仓均价胶囊（方向醒目）；ghost 用于“＋ 止盈/止损”建议。
   */
  private chip(
    ctx: CanvasRenderingContext2D,
    text: string,
    color: string,
    y: number,
    w: number,
    h: number,
    opt: { ghost?: boolean; active?: boolean; emphasized?: boolean } = {},
  ) {
    ctx.save()
    ctx.font = opt.emphasized ? '700 11px Manrope, monospace' : '600 10px Manrope, monospace'
    const tw = ctx.measureText(text).width
    const bw = tw + 12
    const bh = opt.emphasized ? 20 : 17
    const bx = Math.max(2, Math.min(w - bw - 4, w - bw))
    const by = Math.max(0, Math.min(h - bh, y - bh / 2))
    ctx.globalAlpha = opt.ghost ? 0.6 : opt.active ? 1 : 0.92
    ctx.fillStyle = 'rgba(15, 20, 25, 0.92)'
    this.roundRect(ctx, bx, by, bw, bh, 4)
    ctx.fill()
    ctx.strokeStyle = opt.ghost ? hexToRgba(color, 0.55) : hexToRgba(color, opt.active ? 1 : 0.85)
    ctx.lineWidth = opt.active ? 2 : 1
    ctx.stroke()
    ctx.fillStyle = color
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, bx + 6, by + bh / 2 + (opt.emphasized ? 0.5 : 0))
    ctx.restore()
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }
}


export interface PositionLineState {
  symbol: string
  side: 'BUY' | 'SELL'
  qty: number
  entry: number
  /** 最新价（用于实时盈亏） */
  mark: number
  pnl: number
  pnlPct: number
  takeProfit: number | null
  stopLoss: number | null
  /** 未设置止盈/止损时展示的“建议价”（幽灵线） */
  suggestedTakeProfit: number | null
  suggestedStopLoss: number | null
  /** 拖拽过程中尚未提交的价格 */
  draftTakeProfit: number | null
  draftStopLoss: number | null
  /** 正在拖拽的手柄（视觉高亮/加粗） */
  dragging?: 'tp' | 'sl' | null
}

const COLOR_BUY = '#089981'
const COLOR_SELL = '#f23645'
const COLOR_TP = '#26a69a'
const COLOR_SL = '#ef534f'

function decOf(p: number): number {
  const s = String(p)
  const dot = s.indexOf('.')
  return dot >= 0 ? Math.min(6, s.length - dot - 1) : 2
}

function fmtPrice(v: number, dec: number): string {
  if (!Number.isFinite(v)) return '--'
  return v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
}

function fmtMoney(v: number): string {
  if (!Number.isFinite(v)) return '--'
  const abs = Math.abs(v)
  const dec = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4
  return v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
}

function entryLabel(s: PositionLineState): string {
  const arrow = s.side === 'BUY' ? '▲' : '▼'
  const dir = s.side === 'BUY' ? '多' : '空'
  return `${arrow} ${dir} · ${s.qty} @ ${fmtPrice(s.entry, decOf(s.entry))}`
}

function hexToRgba(hex: string, alpha: number): string {
  const full = hex.replace('#', '')
  const n = parseInt(full, 16)
  if (Number.isNaN(n)) return `rgba(59,130,246,${alpha})`
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

