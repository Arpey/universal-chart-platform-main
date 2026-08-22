# 部署

开发环境可使用 `docker compose up --build`。生产环境建议为前端构建静态文件并由 Nginx 提供，后端单独运行并通过反向代理暴露 `/api` 与 `/ws`；请按部署环境配置 CORS 和数据源地址。
