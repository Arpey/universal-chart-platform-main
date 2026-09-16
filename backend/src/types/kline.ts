export type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'

export interface Kline {
  /** Unix 时间戳（秒，10 位）；输出侧统一按当前周期向下取整对齐。 */
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/**
 * 实时 K 线聚合器的历史播种数据：
 * 可以是历史快照的最后一根 K 线，也可以是「稍后 resolve 的历史请求」
 * （异步到达不阻塞实时订阅，聚合器会把同周期的历史与实时数据合并）。
 */
export type KlineSeed = Kline | Promise<Kline | undefined>
