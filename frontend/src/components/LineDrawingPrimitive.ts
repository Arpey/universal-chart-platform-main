import type {
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  IChartApiBase,
  SeriesAttachedParameter,
  Time,
  ISeriesApi,
  SeriesType,
} from 'lightweight-charts'

export type DrawKind = 'cursor' | 'trend' | 'ray' | 'hline' | 'vline' | 'fib'

export interface DrawPoint {
  time: Time
  price: number
}

export interface DrawObject {
  id: string
  kind: Exclude<DrawKind, 'cursor'>
  points: DrawPoint[]
  color: string
}

const PALETTE = [
  '#ffd166', '#4cc9f0', '#f72585', '#7ae582', '#9d4edd', '#ff6b6b', '#48bfe3',
]

export function randomColor(): string {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)]
}

interface Renderer extends IPrimitivePaneRenderer {
  draw(target: unknown): void
}

interface View extends IPrimitivePaneView {
  renderer(): Renderer | null
}

/**
 * 画线叠加层：附着到 K 线 series 上，负责把全体 DrawObject 绘制到主图。
 * 坐标换算：series.priceToCoordinate(price)=y，chart.timeScale().timeToCoordinate(time)=x。
 */
export class LineDrawingPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null
  private series: ISeriesApi<SeriesType, Time> | null = null
  private requestUpdate: (() => void) | null = null
  private _objects: DrawObject[] = []

  setObjects(objects: DrawObject[]) {
    this._objects = objects
    this.requestUpdate?.()
  }

  get objects(): DrawObject[] {
    return this._objects
  }

  /** 生命周期：附着到 series 时被调用，保存换算引用 */
  attached(param: SeriesAttachedParameter<Time, SeriesType>) {
    this.chart = param.chart
    this.series = param.series
    this.requestUpdate = param.requestUpdate
  }

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

  // ---------- 交互换算工具 ----------
  priceToY(price: number): number | null {
    return this.series ? this.series.priceToCoordinate(price) : null
  }

  yToPrice(y: number): number | null {
    return this.series ? this.series.coordinateToPrice(y) : null
  }

  timeToX(time: Time): number | null {
    return this.chart ? this.chart.timeScale().timeToCoordinate(time) : null
  }

  screenToPoint(x: number, y: number): DrawPoint | null {
    if (!this.chart || !this.series) return null
    const time = this.chart.timeScale().coordinateToTime(x) as Time | null
    const price = this.series.coordinateToPrice(y)
    if (time == null || price == null) return null
    return { time, price }
  }

  // ---------- 渲染 ----------
  private drawAll(target: any) {
    if (typeof target.useMediaCoordinateSpace !== 'function') return
    target.useMediaCoordinateSpace((scope: any) => {
      const ctx = scope.context
      const w = scope.mediaSize.width
      const h = scope.mediaSize.height
      // 注意：主画布与 K 线/成交量共享，lightweight-charts 每帧会全量重绘背景，
      // 这里绝不能 clearRect，否则会把刚画好的 K 线一起擦掉（导致只显示成交量）。
      this.renderObjects(ctx, w, h)
    })
  }

  /** 核心渲染：将所有画线对象绘制到媒介像素坐标的 2D context。 */
  private renderObjects(ctx: CanvasRenderingContext2D, width: number, height: number) {
    if (!this.series) return
    for (const obj of this._objects) {
      const pts = obj.points
      if (pts.length < 1) continue
      const xs = pts.map((p) => this.timeToX(p.time))
      const ys = pts.map((p) => this.priceToY(p.price))

      ctx.save()
      ctx.lineWidth = 1.75
      ctx.strokeStyle = obj.color
      ctx.fillStyle = obj.color

      if (obj.kind === 'trend' && xs.length >= 2 && xs[0] != null && xs[1] != null && ys[0] != null && ys[1] != null) {
        ctx.beginPath()
        ctx.moveTo(xs[0] as number, ys[0] as number)
        ctx.lineTo(xs[1] as number, ys[1] as number)
        ctx.stroke()
      } else if (obj.kind === 'ray' && xs.length >= 2 && xs[1] != null && ys[0] != null && ys[1] != null) {
        const x0 = xs[0] as number
        const y0 = ys[0] as number
        const x1 = xs[1] as number
        const y1 = ys[1] as number
        const dx = x1 - x0
        if (Math.abs(dx) > 0.0001) {
          const slope = (y1 - y0) / dx
          const xEnd = x1 > x0 ? width : 0
          const yEnd = y0 + slope * (xEnd - x0)
          ctx.beginPath()
          ctx.moveTo(x0, y0)
          ctx.lineTo(xEnd, yEnd)
          ctx.stroke()
        }
      } else if (obj.kind === 'hline' && ys[0] != null) {
        ctx.fillRect(0, ys[0] - 0.5, width, 1)
      } else if (obj.kind === 'vline' && xs[0] != null) {
        ctx.fillRect(xs[0] - 0.5, 0, 1, height)
      } else if (obj.kind === 'fib' && xs.length >= 2 && xs[0] != null && xs[1] != null && pts.length >= 2) {
        this.fib(ctx, xs[0] as number, xs[1] as number, pts[0].price, pts[1].price)
      }

      // 端点锚点
      for (let i = 0; i < pts.length; i++) {
        const x = xs[i]
        const y = ys[i]
        if (x != null && y != null) {
          ctx.beginPath()
          ctx.arc(x as number, y as number, 4, 0, Math.PI * 2)
          ctx.fill()
          ctx.strokeStyle = '#0f1419'
          ctx.lineWidth = 1.5
          ctx.stroke()
        }
      }
      ctx.restore()
    }
  }

  private fib(ctx: CanvasRenderingContext2D, x0: number, x1: number, p0: number, p1: number) {
    const lo = Math.min(p0, p1)
    const hi = Math.max(p0, p1)
    if (Math.abs(hi - lo) < 1e-9) return
    const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
    for (let i = 0; i < levels.length; i++) {
      const y = this.priceToY(hi - (hi - lo) * levels[i])
      if (y == null) continue
      ctx.save()
      ctx.setLineDash(i === 0 || i === levels.length - 1 ? [] : [4, 4])
      ctx.strokeStyle = i === 0 ? '#f72585' : i === levels.length - 1 ? '#4cc9f0' : '#ffd166'
      ctx.beginPath()
      ctx.moveTo(x0, y)
      ctx.lineTo(x1, y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.restore()
    }
  }
}
