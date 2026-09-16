/**
 * K 线聚合器单元测试：时间戳对齐（毫秒→秒、按周期向下取整）、
 * 同周期 OHLCV 合并、跨周期开新根、乱序数据丢弃、历史播种合并（vitest）。
 */
import { describe, expect, it } from 'vitest'
import { KlineAggregator, alignToInterval, toEpochMs, toEpochSeconds } from '../src/core/KlineAggregator'

describe('KlineAggregator 时间戳归一化', () => {
  it('毫秒 → 10 位 Unix 秒', () => {
    expect(toEpochSeconds(1_789_000_000_123)).toBe(1_789_000_000)
    expect(toEpochSeconds(1_789_000_000)).toBe(1_789_000_000)
    expect(toEpochSeconds(0)).toBe(0)
    expect(toEpochSeconds(Number.NaN)).toBe(0)
  })

  it('秒 → 毫秒（前端图表分页参数）', () => {
    expect(toEpochMs(1_789_000_000)).toBe(1_789_000_000_000)
    expect(toEpochMs(1_789_000_000_123)).toBe(1_789_000_000_123)
  })

  it('按周期向下取整对齐（1m / 5m / 1h）', () => {
    expect(alignToInterval(1_789_000_123, '1m')).toBe(Math.floor(1_789_000_123 / 60) * 60)
    expect(alignToInterval(1_789_000_123, '5m')).toBe(Math.floor(1_789_000_123 / 300) * 300)
    expect(alignToInterval(1_789_000_123, '1h')).toBe(Math.floor(1_789_000_123 / 3600) * 3600)
  })
})

describe('KlineAggregator tick 合成 K 线', () => {
  const minute = 1_789_000_000 - (1_789_000_000 % 60) // 对齐到整分钟

  it('跨入新周期开启全新 K 线（open=high=low=close=首笔价）', () => {
    const agg = new KlineAggregator('1m')
    const bar = agg.push({ price: 100, size: 2, timestamp: (minute + 5) * 1000 })
    expect(bar).toEqual({ time: minute, open: 100, high: 100, low: 100, close: 100, volume: 2 })
  })

  it('同周期更新 high/low/close 并累加 volume', () => {
    const agg = new KlineAggregator('1m')
    agg.push({ price: 100, size: 2, timestamp: minute + 5 })
    agg.push({ price: 105, size: 3, timestamp: minute + 20 })
    const bar = agg.push({ price: 98, size: 5, timestamp: minute + 45 })
    expect(bar).toEqual({ time: minute, open: 100, high: 105, low: 98, close: 98, volume: 10 })
  })

  it('跨入新周期开新根且 volume 重新计数', () => {
    const agg = new KlineAggregator('1m')
    agg.push({ price: 100, size: 2, timestamp: minute + 5 })
    const next = agg.push({ price: 101, size: 7, timestamp: minute + 61 })
    expect(next).toEqual({ time: minute + 60, open: 101, high: 101, low: 101, close: 101, volume: 7 })
  })

  it('丢弃早于当前 K 线的迟到 Tick（已收盘周期）', () => {
    const agg = new KlineAggregator('1m')
    agg.push({ price: 100, size: 1, timestamp: minute + 30 })
    // 上一根 K 线（周期已收盘）的迟到数据 → 丢弃
    expect(agg.push({ price: 90, size: 1, timestamp: minute - 5 })).toBeNull()
    expect(agg.push({ price: 90, size: 1, timestamp: minute - 60 })).toBeNull()
    expect(agg.current).toEqual({ time: minute, open: 100, high: 100, low: 100, close: 100, volume: 1 })
    // 同周期内的乱序 Tick 仍属于当前 K 线：按 high/low/close 合并，volume 累加（不丢弃）
    expect(agg.push({ price: 90, size: 1, timestamp: minute + 10 })?.close).toBe(90)
    expect(agg.current).toEqual({ time: minute, open: 100, high: 100, low: 90, close: 90, volume: 2 })
  })

  it('丢弃非法 Tick（价格 / 时间戳无效）', () => {
    const agg = new KlineAggregator('1m')
    expect(agg.push({ price: 0, timestamp: minute + 5 })).toBeNull()
    expect(agg.push({ price: Number.NaN, timestamp: minute + 5 })).toBeNull()
    expect(agg.push({ price: 100, timestamp: 0 })).toBeNull()
    expect(agg.current).toBeNull()
  })

  it('连续换线：K 线时间戳严格递增（newBar.time > lastBar.time，不会锁死/回退）', () => {
    const agg = new KlineAggregator('1m')
    const emitted: number[] = []
    // 3 个周期 × 每周期 6 笔 tick：同周期更新 + 两次换线
    for (let period = 0; period < 3; period += 1) {
      for (let i = 0; i < 6; i += 1) {
        const bar = agg.push({ price: 100 + period * 10 + i, size: 1, timestamp: minute + period * 60 + i * 10 })
        if (bar) emitted.push(bar.time)
      }
    }
    // 每次推送都会落在这 3 根 K 线上，且时间戳单调不减
    expect(emitted).toHaveLength(18)
    for (let i = 1; i < emitted.length; i += 1) expect(emitted[i]).toBeGreaterThanOrEqual(emitted[i - 1])
    expect([...new Set(emitted)]).toEqual([minute, minute + 60, minute + 120])
    expect(agg.current?.time).toBe(minute + 120)
  })
})

describe('KlineAggregator 子周期 bar 合成（IBKR 5 秒 bar）', () => {
  it('把多根 5 秒 bar 合并为 1 分钟 K 线（时间戳毫秒）', () => {
    const agg = new KlineAggregator('1m')
    const base = Math.floor(1_789_000_000 / 60) * 60
    const bars = [
      { time: base * 1000, open: 100, high: 101, low: 99, close: 100.5, volume: 1 },
      { time: (base + 5) * 1000, open: 100.5, high: 102, low: 100, close: 101, volume: 2 },
      { time: (base + 10) * 1000, open: 101, high: 103, low: 98, close: 99, volume: 3 },
    ]
    let last: ReturnType<KlineAggregator['pushBar']> = null
    for (const b of bars) last = agg.pushBar(b)
    expect(last).toEqual({ time: base, open: 100, high: 103, low: 98, close: 99, volume: 6 })
  })

  it('同一根子周期 bar 重复推送不重复累加 volume', () => {
    const agg = new KlineAggregator('1m')
    const base = Math.floor(1_789_000_000 / 60) * 60
    const bar = { time: base * 1000, open: 100, high: 101, low: 99, close: 100, volume: 4 }
    expect(agg.pushBar(bar)).not.toBeNull()
    expect(agg.pushBar(bar)).toBeNull()
    expect(agg.current?.volume).toBe(4)
  })

  it('子周期 bar 跨分钟时正确换线（新根时间 = 下一分钟，严格更大）', () => {
    const agg = new KlineAggregator('1m')
    const base = Math.floor(1_789_000_000 / 60) * 60
    const first = agg.pushBar({ time: (base + 55) * 1000, open: 100, high: 101, low: 99, close: 100.5, volume: 2 })
    const second = agg.pushBar({ time: (base + 60) * 1000, open: 100.5, high: 102, low: 100, close: 101, volume: 3 })
    expect(first?.time).toBe(base)
    expect(second?.time).toBe(base + 60)
    expect(second!.time).toBeGreaterThan(first!.time)
    // 换线后 volume 从新根重新计数（不与上一根累加）
    expect(second?.volume).toBe(3)
  })
})

describe('KlineAggregator 历史播种', () => {
  it('历史最后一根与实时同周期时续接（open 取历史、volume 相加、close 取实时）', () => {
    const agg = new KlineAggregator('1m')
    const base = Math.floor(1_789_000_000 / 60) * 60
    agg.seed({ time: base, open: 95, high: 102, low: 94, close: 100, volume: 30 })
    const bar = agg.push({ price: 98, size: 5, timestamp: base + 20 })
    expect(bar).toEqual({ time: base, open: 95, high: 102, low: 94, close: 98, volume: 35 })
  })

  it('历史与实时不同周期时忽略播种', () => {
    const agg = new KlineAggregator('1m')
    const base = Math.floor(1_789_000_000 / 60) * 60
    agg.push({ price: 100, size: 1, timestamp: base + 5 })
    expect(agg.seed({ time: base - 60, open: 1, high: 1, low: 1, close: 1, volume: 1 })).toBeNull()
    expect(agg.current).toEqual({ time: base, open: 100, high: 100, low: 100, close: 100, volume: 1 })
  })
})
