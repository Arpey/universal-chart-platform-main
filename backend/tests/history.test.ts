/**
 * 周期映射表 / 历史 K 线归一化 / 历史缓存 单元测试：
 * - 前后端共享的周期 → 秒数、IBKR barSizeSetting / durationStr 映射；
 * - normalizeBars：毫秒→秒、过滤非法行、同 time 去重（保留最后一条）、升序、只保留最近 limit 根；
 * - TtlCache：TTL 命中 / 并发去重 / 失败不缓存。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  HISTORY_BAR_LIMIT,
  HISTORY_BAR_LIMIT_MAX,
  IBKR_BAR_SIZE,
  INTERVAL_SECONDS,
  ibkrHistoryDuration,
  intervalSeconds,
  isInterval,
  resolveHistoryLimit,
} from '../src/core/intervals'
import { aggregateBars, normalizeBars } from '../src/core/KlineAggregator'
import { BaseAdapter } from '../src/adapters/BaseAdapter'
import { TtlCache } from '../src/core/HistoryCache'

describe('interval 映射表（与前端 src/constants/intervals.ts 对应）', () => {
  it('周期 → 秒数：1m/5m/15m/30m/1h/4h/1d', () => {
    expect(INTERVAL_SECONDS['1m']).toBe(60)
    expect(INTERVAL_SECONDS['5m']).toBe(300)
    expect(INTERVAL_SECONDS['15m']).toBe(900)
    expect(INTERVAL_SECONDS['30m']).toBe(1800)
    expect(INTERVAL_SECONDS['1h']).toBe(3600)
    expect(INTERVAL_SECONDS['4h']).toBe(14400)
    expect(INTERVAL_SECONDS['1d']).toBe(86400)
    expect(intervalSeconds('5m')).toBe(300)
    expect(intervalSeconds('unknown')).toBe(60)
  })

  it('IBKR barSizeSetting 映射为 BarSizeSetting 枚举原文', () => {
    expect(IBKR_BAR_SIZE).toEqual({
      '1m': '1 min',
      '5m': '5 mins',
      '15m': '15 mins',
      '30m': '30 mins',
      '1h': '1 hour',
      '4h': '4 hours',
      '1d': '1 day',
    })
  })

  it('IBKR durationStr 至少覆盖 100 根（按周期下限）', () => {
    expect(ibkrHistoryDuration('1m', 100)).toBe('2 D')
    expect(ibkrHistoryDuration('5m', 100)).toBe('2 D')
    expect(ibkrHistoryDuration('15m', 100)).toBe('5 D')
    expect(ibkrHistoryDuration('30m', 100)).toBe('5 D')
    expect(ibkrHistoryDuration('1h', 100)).toBe('1 W')
    expect(ibkrHistoryDuration('4h', 100)).toBe('1 M')
    expect(ibkrHistoryDuration('1d', 100)).toBe('1 Y')
  })

  it('请求更多根数时窗口放大且不超过各周期上限', () => {
    // 300 根 15m ≈ 4.7 天 → 仍在下限 5 D 之上；300 根 1h ≈ 18.75 天 → 放大为 3 W（21 D）
    expect(ibkrHistoryDuration('15m', 300)).toBe('5 D')
    expect(ibkrHistoryDuration('1h', 300)).toBe('3 W')
    // 上限封顶：1m 最多 2 D、1h 最多 1 M（避免触发 IBKR「duration 超出 barSize 上限」报错）
    expect(ibkrHistoryDuration('1m', 100_000)).toBe('2 D')
    expect(ibkrHistoryDuration('1h', 100_000)).toBe('1 M')
  })

  it('interval 参数校验与 limit 夹取', () => {
    expect(isInterval('5m')).toBe(true)
    expect(isInterval('30m')).toBe(false) // 映射表已支持但端到端暂未启用
    expect(isInterval('2h')).toBe(false)
    expect(resolveHistoryLimit(undefined)).toBe(HISTORY_BAR_LIMIT)
    expect(resolveHistoryLimit('200')).toBe(200)
    expect(resolveHistoryLimit('-5')).toBe(HISTORY_BAR_LIMIT)
    expect(resolveHistoryLimit('abc')).toBe(HISTORY_BAR_LIMIT)
    expect(resolveHistoryLimit(999_999)).toBe(HISTORY_BAR_LIMIT_MAX)
  })
})


describe('normalizeBars 历史 K 线归一化', () => {
  const base = Math.floor(1_789_000_000 / 300) * 300 // 5m 网格起点

  it('毫秒 → 10 位 Unix 秒，并按 time 升序输出', () => {
    const rows = [
      { time: (base + 300) * 1000, open: 2, high: 2, low: 2, close: 2, volume: 1 },
      { time: base * 1000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ]
    const bars = normalizeBars(rows, 100, '5m')
    expect(bars.map((b) => b.time)).toEqual([base, base + 300])
    expect(bars.every((b) => String(b.time).length === 10)).toBe(true)
  })

  it('同 time 去重保留最后一条，并过滤非法行', () => {
    const rows = [
      { time: base, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { time: base, open: 2, high: 3, low: 2, close: 2.5, volume: 9 }, // 后者覆盖前者
      { time: Number.NaN, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { time: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { time: base + 300, open: 0, high: 0, low: 0, close: 0, volume: 0 }, // OHLC 非法
    ]
    const bars = normalizeBars(rows, 100, '5m')
    expect(bars).toHaveLength(1)
    expect(bars[0]).toEqual({ time: base, open: 2, high: 3, low: 2, close: 2.5, volume: 9 })
  })

  it('只保留最近 limit 根（不多不少），且 OHLC 自洽', () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({
      time: base + i * 300,
      open: 10,
      high: 8, // high 低于 open/close → 归一化时必须修正
      low: 12, // low 高于 open/close → 同上
      close: 9,
      volume: 1,
    }))
    const bars = normalizeBars(rows, 100, '5m')
    expect(bars).toHaveLength(100)
    expect(bars[0].time).toBe(base + 50 * 300) // 最近 100 根
    expect(bars[99].time).toBe(base + 149 * 300)
    for (const bar of bars) {
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close))
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close))
    }
  })

  it('空输入 / 全部非法输入 → 空数组（数据源不支持历史时的容错路径）', () => {
    expect(normalizeBars([], 100)).toEqual([])
    expect(normalizeBars(null, 100)).toEqual([])
    expect(normalizeBars([{ time: 0, open: 0, high: 0, low: 0, close: 0, volume: 0 }], 100)).toEqual([])
  })
})

describe('TtlCache 历史缓存', () => {
  it('TTL 内命中缓存（不重复调用 loader），过期后重新加载', async () => {
    const cache = new TtlCache({ ttlMs: 30 })
    const loader = vi.fn(async () => [1, 2, 3])
    expect(await cache.get('MES|5m|100', loader)).toEqual([1, 2, 3])
    expect(await cache.get('MES|5m|100', loader)).toEqual([1, 2, 3])
    expect(loader).toHaveBeenCalledTimes(1)
    await new Promise((r) => setTimeout(r, 40))
    await cache.get('MES|5m|100', loader)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('同一 key 的并发请求共享同一个 Promise（避免同时打上游）', async () => {
    const cache = new TtlCache({ ttlMs: 1_000 })
    const loader = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5))
      return 'bars'
    })
    const [a, b] = await Promise.all([cache.get('k', loader), cache.get('k', loader)])
    expect(a).toBe('bars')
    expect(b).toBe('bars')
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('失败不缓存（下一次调用立即重试），clear 可按前缀清理', async () => {
    const cache = new TtlCache({ ttlMs: 1_000 })
    const failing = vi.fn(async () => { throw new Error('upstream down') })
    await expect(cache.get('MES|5m|100', failing)).rejects.toThrow('upstream down')
    const retry = vi.fn(async () => 'ok')
    await expect(cache.get('MES|5m|100', retry)).resolves.toBe('ok')
    expect(retry).toHaveBeenCalledTimes(1)
    cache.clear('MES|')
    expect(cache.size).toBe(0)
  })
})

describe('aggregateBars 小周期 → 大周期聚合（IBKR 4h 历史补齐）', () => {
  const base = Math.floor(1_789_000_000 / 14400) * 14400 // 4h 网格起点

  it('按 4h 网格聚合：open 取首根 / high-low 取极值 / close 取末根 / volume 累加', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      time: base + i * 3600,
      open: 100 + i,
      high: 101 + i,
      low: 99 - i,
      close: 100.5 + i,
      volume: 2,
    }))
    const bars = aggregateBars(rows, '4h', 100)
    expect(bars).toHaveLength(2)
    expect(bars[0]).toEqual({ time: base, open: 100, high: 104, low: 96, close: 103.5, volume: 8 })
    expect(bars[1]).toEqual({ time: base + 14400, open: 104, high: 108, low: 92, close: 107.5, volume: 8 })
  })

  it('只保留最近 limit 根，输出严格升序且无重复', () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      time: base + i * 3600,
      open: 10, high: 11, low: 9, close: 10.5, volume: 1,
    }))
    const bars = aggregateBars(rows, '4h', 10)
    expect(bars).toHaveLength(10)
    for (let i = 1; i < bars.length; i += 1) {
      expect(bars[i].time).toBeGreaterThan(bars[i - 1].time)
    }
    expect(bars[bars.length - 1].time).toBe(base + 74 * 14400) // 300 根 1h → 75 根 4h 的最后一根
  })

  it('空输入 / 非法周期 → 空数组（补齐失败时不影响上游原始数据）', () => {
    expect(aggregateBars([], '4h', 100)).toEqual([])
    expect(aggregateBars(null, '4h', 100)).toEqual([])
    expect(aggregateBars([{ time: base, open: 1, high: 1, low: 1, close: 1, volume: 1 }], 0, 100)).toEqual([])
  })
})

describe('BaseAdapter.fetchHistoricalBars 分页（endTime）', () => {
  const base = Math.floor(1_789_000_000 / 300) * 300
  /** 假适配器：模拟上游「返回最近 limit 根 / 返回 endTime 之前的最近 limit 根」的分页语义。 */
  class FakeAdapter extends BaseAdapter {
    constructor(private readonly total: number) { super() }
    override async getKlines(_symbol: string, _interval: any, limit: number, endTime?: number): Promise<any[]> {
      const bars = Array.from({ length: this.total }, (_, i) => ({
        time: base + i * 300, open: 1, high: 1, low: 1, close: 1, volume: 1,
      }))
      return endTime ? bars.filter((b) => b.time < endTime).slice(-limit) : bars.slice(-limit)
    }
    async getTicker(): Promise<any> { return {} }
    subscribe(): () => void { return () => {} }
  }
  const adapter = new FakeAdapter(300)

  it('不传 endTime：返回最近 limit 根（首屏行为不变）', async () => {
    const bars = await adapter.fetchHistoricalBars('X', '5m', 100)
    expect(bars).toHaveLength(100)
    expect(bars[0].time).toBe(base + 200 * 300)
    expect(bars[99].time).toBe(base + 299 * 300)
  })

  it('传 endTime：只返回严格早于它的最近 limit 根，且与上一页无重叠', async () => {
    const first = await adapter.fetchHistoricalBars('X', '5m', 100)
    const oldest = first[0].time
    const second = await adapter.fetchHistoricalBars('X', '5m', 100, oldest)
    expect(second).toHaveLength(100)
    expect(second.every((bar) => bar.time < oldest)).toBe(true)
    expect(second[second.length - 1].time).toBe(base + 199 * 300)
    const previous = new Set(first.map((bar) => bar.time))
    expect(second.some((bar) => previous.has(bar.time))).toBe(false)
  })

  it('endTime 之前的可用数据不足 limit → 返回实际数量（路由据此给出 hasMore=false）', async () => {
    const bars = await adapter.fetchHistoricalBars('X', '5m', 100, base + 30 * 300)
    expect(bars).toHaveLength(30)
    expect(bars[bars.length - 1].time).toBe(base + 29 * 300)
  })
})

