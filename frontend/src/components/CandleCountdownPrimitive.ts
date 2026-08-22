import type {
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  Time,
  ISeriesApi,
  SeriesType,
} from 'lightweight-charts'

interface Renderer extends IPrimitivePaneRenderer {
  draw(target: unknown): void
}

interface View extends IPrimitivePaneView {
  renderer(): Renderer | null
}

/**
 * K 线收盘倒计时徽标（叠加层）：
 * 绘制在主图右缘、最新收盘价的水平位置，样式为圆角"胶囊"+倒计时文本。
 * 每秒由外部调用 setValue() 并经由 requestUpdate() 局部重绘，不触发全图表重排。
 */
export class CandleCountdownPrimitive implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType, Time> | null = null
  private requestUpdate: (() => void) | null = null

  private _lastPrice = 0
  private _countdown = '--:--'

  /** 更新显示内容并请求重绘（值未变化时跳过，避免无谓开销）。 */
  setValue(lastPrice: number, countdown: string) {
    if (this._lastPrice === lastPrice && this._countdown === countdown) return
    this._lastPrice = lastPrice
    this._countdown = countdown
    this.requestUpdate?.()
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>) {
    this.series = param.series
    this.requestUpdate = param.requestUpdate
  }

  detached() {
    this.series = null
    this.requestUpdate = null
  }

  paneViews(): readonly View[] {
    const self = this
    return [
      {
        renderer(): Renderer | null {
          return {
            draw(target: unknown) {
              self.draw(target as any)
            },
          }
        },
      },
    ]
  }

  private draw(target: any) {
    if (!this.series) return
    if (typeof target.useMediaCoordinateSpace !== 'function') return
    target.useMediaCoordinateSpace((scope: any) => {
      const ctx = scope.context as CanvasRenderingContext2D
      const width = scope.mediaSize.width as number
      const height = scope.mediaSize.height as number

      // 无有效价格或倒计时为空时跳过
      if (!this._lastPrice || !this._countdown) return
      const y = this.series!.priceToCoordinate(this._lastPrice)
      if (y == null) return

      const text = this._countdown
      ctx.save()
      ctx.font = '600 11px Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      const textWidth = ctx.measureText(text).width
      const padX = 9
      const boxH = 22
      const boxW = textWidth + padX * 2
      const gap = 8
      const x = width - boxW - gap
      const boxY = Math.max(4, Math.min(height - boxH - 4, y - boxH / 2))

      // 背景胶囊
      ctx.fillStyle = 'rgba(15, 20, 25, 0.88)'
      this.roundRect(ctx, x, boxY, boxW, boxH, 6)
      ctx.fill()
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.65)'
      ctx.lineWidth = 1
      ctx.stroke()

      // 倒计时文本
      ctx.fillStyle = '#e8edf3'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, x + boxW / 2, boxY + boxH / 2 + 0.5)

      ctx.restore()
    })
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
