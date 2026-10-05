export interface Kline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface H2L2Result {
  time: number;
  ema20: number;
  signal: 'H2' | 'L2' | null;
}

/**
 * 实时增量状态追踪器（基于标准 Price Action 价格行为学）
 */
export class H2L2Tracker {
  private period: number;
  private prevEMA: number | null = null;
  
  // 趋势与回调状态控制
  private trend: number = 0;          // 1: 多头突破 20 EMA, -1: 空头突破 20 EMA, 0: 无趋势
  private count: number = 0;          // 记录尝试次数：1 -> H1/L1, 2 -> H2/L2
  private isPullback: boolean = false; // 当前是否处于回调结构中
  private prevBar: Kline | null = null;

  constructor(period = 20) {
    this.period = period;
  }

  public update(bar: Kline): H2L2Result {
    const k = 2 / (this.period + 1);
    
    // 1. 计算 20 EMA
    const ema20 = this.prevEMA === null ? bar.close : (bar.close - this.prevEMA) * k + this.prevEMA;
    this.prevEMA = ema20;

    let signal: 'H2' | 'L2' | null = null;

    if (this.prevBar) {
      // 2. 检测突破 20 EMA
      let brokeOut = false;
      
      // 向上突破 20 EMA
      if (this.prevBar.close <= ema20 && bar.close > ema20) {
        this.trend = 1;
        this.count = 0;
        this.isPullback = false;
        brokeOut = true;
      } 
      // 向下突破 20 EMA
      else if (this.prevBar.close >= ema20 && bar.close < ema20) {
        this.trend = -1;
        this.count = 0;
        this.isPullback = false;
        brokeOut = true;
      }

      // 3. 突破「之后」的回调与 H1/H2、L1/L2 逻辑
      if (!brokeOut) {
        // ----------------- 多头趋势 (Trend == 1) -----------------
        if (this.trend === 1) {
          // 规则 A：失效判定 —— 低点跌破 20 EMA 则趋势与计数清零
          if (bar.low < ema20) {
            this.trend = 0;
            this.count = 0;
            this.isPullback = false;
          } else {
            // 规则 B：检测回调过程
            // 当前 K 线最高价小于前一根最高价，说明上涨暂停，正在进行回调
            if (bar.high < this.prevBar.high) {
              this.isPullback = true;
            } 
            // 规则 C：突破回调 —— 在回调状态中，价格首次向上突破前一根 K 线最高价
            else if (this.isPullback && bar.high > this.prevBar.high) {
              this.count++;
              this.isPullback = false; // 结束本次回调状态，等待下一次回调发生

              if (this.count === 2) {
                signal = 'H2';
                this.count = 0; // 触发 H2 后重置计数
              }
            }
          }
        } 
        // ----------------- 空头趋势 (Trend == -1) -----------------
        else if (this.trend === -1) {
          // 规则 A：失效判定 —— 最高价突破 20 EMA 则趋势与计数清零
          if (bar.high > ema20) {
            this.trend = 0;
            this.count = 0;
            this.isPullback = false;
          } else {
            // 规则 B：检测回调过程（空头回调指价格反弹/最低价高于前一根最低价）
            if (bar.low > this.prevBar.low) {
              this.isPullback = true;
            } 
            // 规则 C：突破回调 —— 在回调状态中，价格首次向下跌破前一根 K 线最低价
            else if (this.isPullback && bar.low < this.prevBar.low) {
              this.count++;
              this.isPullback = false; // 结束本次回调状态

              if (this.count === 2) {
                signal = 'L2';
                this.count = 0; // 触发 L2 后重置计数
              }
            }
          }
        }
      }
    }

    this.prevBar = bar;
    return { time: bar.time, ema20, signal };
  }
}

/**
 * 历史全量计算函数
 */
export function calculateH2L2All(klines: Kline[], period = 20): H2L2Result[] {
  const tracker = new H2L2Tracker(period);
  return klines.map(bar => tracker.update(bar));
}