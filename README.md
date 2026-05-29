# 金十财经快讯监控

金十数据实时快讯监控系统，通过 WebSocket 连接金十数据源，自动采集所有快讯，并对红色重要新闻进行 AI 智能分析。内置 Web 服务器，提供新闻展示页面和配置管理界面。

## 功能特性

- 实时监控金十财经全部快讯（普通快讯 + 红色重要快讯 + 日历事件）
- 红色重要新闻自动触发 AI 分析（标的、方向、逻辑链、核心驱动、关键风险、确认信号、技术面）
- 内置 Web 服务器，提供新闻展示页面和在线配置管理页面
- 新增 CLS 默认电报页镜像监控，包含初始化首屏、增量 update、refresh 修正与 recovery 标记
- 支持快讯的新增、修改、删除实时同步
- 自动过滤广告、"点击查看"占位内容、日历预告类内容
- 自动去重（72 小时内）
- 每日自动生成当日新闻分析报告（每晚 23 点后自动触发）
- 支持单条新闻重新分析
- 快讯日志记录（按日期存储在 `logs/` 目录）
- WebSocket 断线自动重连（指数退避策略）
- 支持多种 AI 提供商，按顺序尝试，首个成功即采用

## 支持的 AI 提供商

| 类型 | 默认模型 | API 地址 | 注册地址 |
|------|---------|---------|---------|
| `minimax` | MiniMax-M2.5 | https://api.minimaxi.com | https://platform.minimaxi.com |
| `openai` | gpt-4o | https://api.openai.com | https://platform.openai.com |
| `gemini` | gemini-2.0-flash | https://generativelanguage.googleapis.com | https://aistudio.google.com |
| `claude` | claude-sonnet-4-20250514 | https://api.anthropic.com | https://console.anthropic.com |

所有提供商均支持自定义 `baseUrl`，可接入兼容的第三方代理。

## 安装

```bash
npm install
```

依赖包：
- `ws` — WebSocket 客户端
- `openai` — OpenAI SDK
- `@anthropic-ai/sdk` — Anthropic SDK（同时用于 MiniMax 和 Claude）
- `@google/generative-ai` — Google Gemini SDK

## 配置

创建 `config.json`：

```json
{
  "NEWS_ANALYSIS_AI_PROVIDERS": [
    { "type": "minimax", "apiKey": "你的API密钥", "model": "MiniMax-M2.5" },
    { "type": "openai",  "apiKey": "你的API密钥", "model": "gpt-4o" },
    { "type": "gemini",  "apiKey": "你的API密钥", "model": "gemini-2.0-flash" }
  ],
  "DAILY_ANALYSIS_AI_PROVIDERS": [
    { "type": "openai",  "apiKey": "你的API密钥", "model": "gpt-4o" },
    { "type": "gemini",  "apiKey": "你的API密钥", "model": "gemini-2.0-flash" },
    { "type": "claude",  "apiKey": "你的API密钥", "model": "claude-sonnet-4-20250514" }
  ],
  "WEB_PORT": 3000,
  "WEB_HOST": "0.0.0.0"
}
```

`NEWS_ANALYSIS_AI_PROVIDERS` 用于单条新闻分析，`DAILY_ANALYSIS_AI_PROVIDERS` 用于每日综合分析。两组都会按数组顺序依次尝试，第一个成功返回的结果即被采用。

> 向后兼容：仍支持旧版 `AI_PROVIDERS` 与 `MINIMAX_API_KEY` 字段；服务下次启动读取配置时，会自动迁移本地 `config.json` 到新格式。

配置也可通过 Web 管理页面在线修改（访问 `/config.html`）。

新增 CLS 电报页面访问地址：`/cls.html`

CLS 页面现已与 Jin10 主页面保持同构布局：
- 共用同一套配置页
- 共用同一套每日分析接口
- 通过 `source=news|cls` 区分分析数据源

## 使用

```bash
# 启动监控
node monitor.mjs

# 或使用 npm
npm start

# 后台运行
nohup node monitor.mjs > /tmp/jin10.log 2>&1 &

# 停止
pkill -f "monitor.mjs"
```

启动后自动开启 Web 服务器，默认访问地址：`http://localhost:3000`

同一进程内会并行启动两套监控：
- Jin10 WebSocket 快讯监控
- CLS 默认电报页轮询监控

## AI 分析格式

每条红色重要新闻会生成 7 行结构化 AI 分析：

```
标的：纳指, 英伟达
方向：利好 置信度75
逻辑链：新闻事件 → 市场预期变化 → 资金流向 → 标的价格影响
核心驱动：盈利预期
关键风险：后续数据不及预期、市场情绪反转
确认信号：期指走势、成交量变化
技术面：纳指：趋势偏多；RSI14 55.2（中性区间）；均线：EMA20=Buy / EMA50=Buy / SMA200=Buy
```

## API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/status` | GET | 监控状态（连接状态、错误信息等） |
| `/api/news` | GET | 获取新闻列表（支持 `limit`、`before`、`includeSkipped`、`includeDeleted`、`importantOnly`、`date`、`startTime`、`endTime`、`includeAnalysis` 参数） |
| `/api/news/reanalyze` | POST | 重新分析单条新闻（参数：`id`） |
| `/api/cls/status` | GET | 获取 CLS 电报监控状态 |
| `/api/cls/telegraphs` | GET | 获取 CLS 电报列表（支持 `limit`、`beforeCtime`、`beforeId`、`startCtime`、`endCtime`、`importantOnly`、`onlyRecovered`、`minLevel`、`subject`、`tag`、`stock`、`keyword`、`source=temp`） |
| `/api/cls/telegraphs/:id` | GET | 获取单条 CLS 电报详情，附带 firstSeenAt / lastSeenAt / updatedAt 等持久化元信息 |
| `/api/cls/export` | GET | 批量导出 CLS 电报，默认返回 JSON，支持 `format=jsonl` 以及与列表相同的过滤、时间范围和游标参数 |
| `/api/cls/sync` | POST | 手动触发 CLS update/refresh（参数：`mode=update|refresh|both`） |
| `/api/cls/consume` | POST | 清空 CLS 未读新增计数与最近新增批次 |
| `/api/config` | GET | 获取当前配置 |
| `/api/config` | POST | 更新配置 |
| `/api/daily-analysis/dates` | GET | 获取已有每日分析的日期列表（参数：`source=news|cls`，默认 `news`） |
| `/api/daily-analysis` | GET | 获取指定日期的每日分析（参数：`date`、`source=news|cls`，默认 `news`） |
| `/api/daily-analysis/trigger` | POST | 手动触发生成每日分析报告（参数：`date`、`source=news|cls`，默认 `news`） |

> CLS 电报监控当前跟随财联社默认电报页，使用 `/api/cache?name=refreshTenTelegraph` 作为上游数据源。旧版 CLS 电报接口已下线，不再使用。

## 文件说明

| 文件/目录 | 说明 |
|----------|------|
| `monitor.mjs` | 主入口文件 |
| `lib/config.mjs` | 配置管理模块 |
| `lib/websocket.mjs` | 金十 WebSocket 协议与连接模块 |
| `lib/ai.mjs` | AI 提供商调用与分析模块 |
| `lib/news.mjs` | 新闻存储与每日分析模块 |
| `lib/cls-telegraph.mjs` | CLS 默认电报页状态机、轮询与存储模块，当前按网页逻辑读取 `refreshTenTelegraph` 缓存接口 |
| `lib/dedup.mjs` | 去重与状态管理模块 |
| `lib/filters.mjs` | 广告/占位/预告内容过滤模块 |
| `lib/server.mjs` | HTTP/API 服务器模块 |
| `lib/flashlog.mjs` | 快讯日志记录模块 |
| `lib/utils.mjs` | 工具函数（日志、进程锁等） |
| `public/index.html` | 新闻展示前端页面 |
| `public/cls.html` | CLS 电报页面，沿用 Jin10 主页面结构与每日分析面板 |
| `public/js/news.js` | Jin10 / CLS 共用页面脚本，按 source 切换数据源 |
| `public/config.html` | 在线配置管理页面 |
| `config.json` | 配置文件（不提交到 git） |
| `news.json` | 新闻数据存储 |
| `dedup.json` | 去重缓存 |
| `state.json` | 运行状态记录 |
| `daily_analysis.json` | 每日分析报告存储 |
| `logs/` | 快讯日志目录（按日期存储） |
| `errors.log` | 错误日志 |

## 去重机制

系统自动对 72 小时内的快讯进行去重，每小时自动清理过期记录。手动清除去重缓存：

```bash
echo '{}' > dedup.json
```

## 故障排除

**AI 分析失败：**
- 确认 `config.json` 中 API 密钥配置正确
- 检查 API 配额是否用尽
- 查看 `errors.log` 了解详细错误信息
- 连续失败 5 次后系统会自动暂停 AI 分析 5 分钟，之后自动恢复

**WebSocket 连接失败：**
- 检查网络连接
- 系统会自动重连，重连间隔逐渐递增（最长 30 秒）
- 查看 `state.json` 中的连接状态信息

## 许可证

ISC
