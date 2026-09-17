/**
 * 极简 TTL 内存缓存（历史 K 线专用）。
 *
 * 目的：
 * - 用户快速来回切换 symbol / interval 时，避免反复打上游（IBKR 历史数据有 pacing 限制，
 *   短时间大量请求会被判为「请求过于频繁」而直接失败）；
 * - 同一 (symbol, interval, limit) 的并发请求共享同一个 Promise（in-flight 去重）——
 *   前端 REST 预加载与后端实时订阅播种都会读历史，去重后只打上游一次。
 *
 * 失败不缓存（下一次调用立即重试）；容量超限时淘汰最旧一项。
 */
export interface TtlCacheOptions {
  /** 缓存有效期（毫秒），默认 15s（10~30s 区间内取中值）。 */
  ttlMs?: number
  /** 最多缓存多少个 key（超出淘汰最旧），默认 200。 */
  maxEntries?: number
}

/** 历史 K 线缓存默认 TTL：15s。 */
export const HISTORY_CACHE_TTL_MS = 15_000

export class TtlCache {
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly entries = new Map<string, { at: number; promise: Promise<unknown> }>()

  constructor(options: TtlCacheOptions = {}) {
    this.ttlMs = Math.max(0, options.ttlMs ?? HISTORY_CACHE_TTL_MS)
    this.maxEntries = Math.max(1, options.maxEntries ?? 200)
  }

  /**
   * 取缓存（未过期直接返回；过期 / 未命中则调用 loader 并写入）。
   * 同一 key 的并发调用共享同一个 Promise，因此不会重复请求上游。
   */
  get<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key)
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.promise as Promise<T>
    const promise = loader().catch((err: unknown) => {
      // 失败不缓存：让下一次调用立即重试（避免把一次性网络抖动缓存 15s）
      this.entries.delete(key)
      throw err
    })
    this.entries.set(key, { at: Date.now(), promise })
    this.evictIfNeeded()
    return promise
  }

  /** 清空缓存（可选按 key 前缀清理，如切换数据源 / 标的时）。 */
  clear(prefix?: string): void {
    if (prefix === undefined) {
      this.entries.clear()
      return
    }
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key)
    }
  }

  /** 当前缓存条目数（诊断用）。 */
  get size(): number {
    return this.entries.size
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxEntries) return
    let oldestKey: string | null = null
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [key, entry] of this.entries) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at
        oldestKey = key
      }
    }
    if (oldestKey !== null) this.entries.delete(oldestKey)
  }
}
