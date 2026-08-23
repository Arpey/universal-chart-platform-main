# 适配器

实现 `MarketAdapter` 的三个方法：`getKlines`、`getTicker` 和 `subscribe`。在 `MarketManager` 中注入新适配器，并保持 `Kline` 与 `Ticker` 的统一数据模型。

- 可选扩展：`subscribeQuote` / `subscribeDOM` / `subscribeTick`（实时报价 / 盘口 / 逐笔流，Tradovate 等数据源实现）。
- `subscribe` 支持第 4 个回调 `onHist(klines)` 用于全量历史批量替换（Tradovate 的 `hist`）。
- 双数据源：`binance`（默认，USDT-M 永续）+ `tradovate`（美股指/期货，详见 [TRADOVATE.md](TRADOVATE.md)）。
  通过 REST `/api/*?datasource=...` 与 WS `/ws?datasource=...` 路由。

