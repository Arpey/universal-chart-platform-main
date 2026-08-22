/** EMA 单点（time 为秒级时间戳，value 为指标值）。 */
export interface EMAValue {
  time: number
  value: number
}

/**
 * 指数移动平均线（EMA）：
 *   Multiplier = 2 / (N + 1)
 *   EMA_today = Close_today × Multiplier + EMA_yesterday × (1 − Multiplier)
 *
 * 前 N 根以简单均值（SMA）作为种子；数据不足 N 根时以首根收盘价为种子退化递推，
 * 保证曲线在任何数据长度下始终可见（与 TradingView 的预烧期行为近似）。
 */
export function calculateEMA(klines: { time: number; close: number }[], length: number): EMAValue[] {
  const n = Math.max(1, Math.floor(length))
  if (!klines.length) return []
  const multiplier = 2 / (n + 1)
  const out: EMAValue[] = []
  if (klines.length >= n) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += klines[i].close
    let prev = sum / n
    out.push({ time: klines[n - 1].time, value: prev })
    for (let i = n; i < klines.length; i++) {
      prev = klines[i].close * multiplier + prev * (1 - multiplier)
      out.push({ time: klines[i].time, value: prev })
    }
  } else {
    let prev = klines[0].close
    out.push({ time: klines[0].time, value: prev })
    for (let i = 1; i < klines.length; i++) {
      prev = klines[i].close * multiplier + prev * (1 - multiplier)
      out.push({ time: klines[i].time, value: prev })
    }
  }
  return out
}
