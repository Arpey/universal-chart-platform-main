# 架构

前端通过 REST 获取初始 K 线和 24 小时 ticker，再通过 WebSocket 接收当前周期的增量 K 线。后端的 `MarketAdapter` 抽象允许替换数据源，实现其他市场（美股、A 股、期货）适配器时无需改动前端协议。

```text
Vue 3 + TradingView lightweight-charts -> Express REST / WebSocket -> MarketAdapter -> Binance USDT-M Futures
                                            (ProxyAgent / HttpsProxyAgent)
```

- **默认适配器**：`BinanceFuturesAdapter`（U 本位永续，`fapi.binance.com` + `fstream.binance.com`）。
- **代理**：`utils/config.ts` 读取 `HTTPS_PROXY`（默认 `http://127.0.0.1:10808`）。REST 用 `undici` 的 `ProxyAgent`，WebSocket 用 `ws` + `HttpsProxyAgent`。
- **交易对搜索**：前端 `SymbolSearchModal.vue`（TradingView 风格居中弹窗：实时搜索、数据源 Tab、↑↓/Enter/Esc 键盘导航）与右侧常驻 `Watchlist.vue` 共用 `useSymbolRows()`，通过 `/api/symbols`（合约列表）+ `/api/tickers`（实时行情）合并列表，选择后写入 `marketStore.symbol`，触发图表刷新与 WS 重订阅，两处列表高亮与当前标的自始至终同步。
- **图表（TradingView 风格）**：`TradingChart.vue` 使用 TradingView 官方开源库 `lightweight-charts` 渲染 K 线与成交量；当前未收盘 K 线随 tick 增量刷新（`series.update`）。左侧 `LineDrawingPrimitive` 叠加层提供画线工具（趋势线/射线/水平线/垂直线/斐波那契回撤），支持放置、拖动锚点、双击删除与一键清除。
