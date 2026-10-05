import type { LineData, SeriesMarker, Time, UTCTimestamp } from 'lightweight-charts'
import { H2L2Tracker, calculateH2L2All, type H2L2Result } from '../indicators/H2L2Indicator'
import { toKlineSeconds } from '../utils/klineSeries'
import type { Kline } from '../types'

/**
 * H2 / L2（20 EMA 二次突破）信号与图表标记的桥接层。
 *
 * 计算逻辑本身来自 `frontend/src/indicators/H2L2Indicator.ts`（`H2L2Tracker` / `calculateH2L2All`）；
 * 本模块只负责「增量驱动 + 标记映射」，与 Vue / 图表实例解耦，便于单测：
 *
 * - **有状态 tracker 的喂入约定**：`H2L2Tracker` 内部维护 prevEMA / trend / count / extremePrice / prevBar，
 *   对同一根 Bar 重复调用 `update()` 会把 `count` 多次累加（同一根 K 线可能反复产生 H2/L2），
 *   因此这里**只接受「已收盘」的 Bar，且同一 time 只喂一次**（`pushClosedBar` 内按 lastClosedTime 去重）。
 * - **未收盘的最后一根不参与计算**：实时流会持续原地修改最后一根 K 线，
 *   若把它喂进 tracker 会污染增量状态，故 `reset()` 只喂 `bars[0 .. len-2]`；相应地，
 *   实时信号在「该根收盘（尾部出现新的一根）」时落定 —— 结果与「拿收盘后的整表全量重算」完全一致。
 * - **历史播种**：`reset()` 内部调用指标模块的 `calculateH2L2All()` 产出全部信号与 EMA 序列，
 *   再用同一批 K 线重放一次以恢复增量 tracker 状态（两遍 O(n)，只在加载/切标的/改周期时各跑一次）。
 */

/** H2 = 多头二次突破（向上），L2 = 空头二次突破（向下）。 */
export type H2L2SignalType = 'H2' | 'L2'

/** 一次已确认（所在 K 线已收盘）的 H2/L2 信号。 */
export interface H2L2Signal {
  /** 信号所在 K 线的开盘时间（10 位 Unix 秒，与图表 time 一致） */
  time: number
  type: H2L2SignalType
  /** 突破价格：H2 取该根最高价，L2 取该根最低价 */
  price: number
  /** 该根收盘时计算出的 EMA20（图例 / 调试用） */
  ema20: number
}

/** EMA 折线上的一个点。 */
export interface H2L2EmaPoint {
  /** K 线开盘时间（10 位 Unix 秒，与图表 time 一致） */
  time: number
  /** 该根收盘时 H2/L2 判定所用的 EMA 值（取自 `H2L2Result.ema20`） */
  value: number
}

/** H2 标记色（与图表上涨蜡烛色一致）。 */
export const H2_MARKER_COLOR = '#26a69a'
/** L2 标记色（与图表下跌蜡烛色一致）。 */
export const L2_MARKER_COLOR = '#ef534f'

export interface H2L2Engine {
  /**
   * 重建引擎：以整表 K 线重新播种 tracker，返回重建后的全部信号。
   * **最后一根视为未收盘，不参与计算**（实时流会持续改写它）。
   */
  reset(bars: readonly Kline[]): readonly H2L2Signal[]
  /**
   * 增量喂入一根「已收盘」的 K 线。
   * 命中 H2/L2 返回该信号，否则返回 `null`；time 重复或回退时直接忽略（同键去重）。
   */
  pushClosedBar(bar: Kline): H2L2Signal | null
  /** 当前累计信号（按时间升序，只读）。 */
  signals(): readonly H2L2Signal[]
  /**
   * 已喂入（已收盘）Bar 的 EMA 曲线点（按时间升序，只读）。
   * 与 H2/L2 判定用的 EMA **严格同源**（取自 `H2L2Result.ema20`），
   * 不共用 `utils/indicators.calculateEMA`（后者用 SMA 播种并丢弃前 N-1 点），避免曲线与信号基准错位。
   */
  emaPoints(): readonly H2L2EmaPoint[]
}

/** 创建 H2/L2 增量引擎（默认 period = 20，即 20 EMA）。 */
export function createH2L2Engine(period = 20): H2L2Engine {
  let tracker = new H2L2Tracker(period)
  let signals: H2L2Signal[] = []
  let emaPoints: H2L2EmaPoint[] = []
  /** 已喂入 tracker 的最后一根收盘 K 线时间：同一根不重复喂，时间回退一律忽略。 */
  let lastClosedTime = 0

  /** 汇总一次计算结果：EMA 点全量收集，命中信号则追加到 signals。 */
  const record = (bar: Kline, result: H2L2Result, time: number): H2L2Signal | null => {
    emaPoints = [...emaPoints, { time, value: result.ema20 }]
    if (!result.signal) return null
    const signal: H2L2Signal = {
      time,
      type: result.signal,
      price: result.signal === 'H2' ? Number(bar.high) : Number(bar.low),
      ema20: result.ema20,
    }
    signals = [...signals, signal]
    return signal
  }

  const push = (bar: Kline): H2L2Signal | null => {
    const time = toKlineSeconds(bar.time)
    if (!time || time <= lastClosedTime) return null
    const result = tracker.update(bar)
    lastClosedTime = time
    return record(bar, result, time)
  }

  return {
    reset(bars) {
      tracker = new H2L2Tracker(period)
      signals = []
      emaPoints = []
      lastClosedTime = 0
      const all = Array.isArray(bars) ? bars : []
      // 1) 归一化：剔除时间非法 / 重复 / 回退的行，并把最后一根（仍在形成中）整体剔除。
      //    守卫条件与 push() 完全等价 → 「历史播种」与「实时增量」喂入的是同一序列。
      const closed: Kline[] = []
      const times: number[] = []
      let prevTime = 0
      for (let i = 0; i < all.length - 1; i += 1) {
        const time = toKlineSeconds(all[i].time)
        if (!time || time <= prevTime) continue
        prevTime = time
        closed.push(all[i])
        times.push(time)
      }
      // 2) 历史全量：复用指标模块官方全量函数一次算出全部信号与 EMA 序列
      //    （calculateH2L2All 内部为 klines.map(...)，返回值与 closed 索引一一对应）
      const results = calculateH2L2All(closed, period)
      for (let i = 0; i < results.length; i += 1) record(closed[i], results[i], times[i])
      // 3) 用同一批 K 线重放一次，恢复增量 tracker 的内部状态
      //    （prevEMA / trend / count / extremePrice / prevBar）：
      //    重放完成后其状态恰好等于「按序 push 过 closed 的全部元素」，实时 pushClosedBar 可直接续跑。
      for (let i = 0; i < closed.length; i += 1) tracker.update(closed[i])
      lastClosedTime = prevTime
      return signals
    },
    pushClosedBar: push,
    signals: () => signals,
    emaPoints: () => emaPoints,
  }
}

/** 单个信号 → 图表标记（显式返回类型，让字面量获得上下文类型推断）。 */
function toMarker(signal: H2L2Signal): SeriesMarker<Time> {
  const time = signal.time as UTCTimestamp
  if (signal.type === 'H2') {
    // 多头二次突破：绿色向上箭头，画在 K 线下方
    return { time, position: 'belowBar', shape: 'arrowUp', color: H2_MARKER_COLOR, text: 'H2' }
  }
  // 空头二次突破：红色向下箭头，画在 K 线上方
  return { time, position: 'aboveBar', shape: 'arrowDown', color: L2_MARKER_COLOR, text: 'L2' }
}

/**
 * 信号列表 → lightweight-charts 标记数组。
 * 注意：lightweight-charts **v5 已移除 `series.setMarkers()`**，需配合
 * `createSeriesMarkers(series, markers)` 返回的插件对象调用 `setMarkers()` 使用。
 */
export function toSeriesMarkers(signals: readonly H2L2Signal[]): SeriesMarker<Time>[] {
  return signals.map(toMarker)
}

/**
 * EMA 曲线点 → lightweight-charts 折线数据。
 * 数据源为引擎的 `emaPoints()`（即 H2/L2 判定所用的同一条 EMA），因此曲线与标记基准严格一致。
 */
export function toEmaLineData(points: readonly H2L2EmaPoint[]): LineData<Time>[] {
  return points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
}
