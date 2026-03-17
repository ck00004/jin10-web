# 金十红色新闻监控 + AI 分析 + Web 展示

实时监控 [金十数据](https://www.jin10.com/) 的红色重要新闻，自动推送到 Telegram，附带 AI 分析；
同时内置独立 Web 服务器，以瀑布式页面展示所有新闻与 AI 分析结果。

## 功能概览

```
金十网页 → Playwright 抓取 → 去重过滤 → AI 分析（多提供商）→ 广告过滤 → Telegram 推送
                                                                     ↓
                                                           保存到 news.json（无上限）
                                                                     ↓
                                                   内置 Web 服务器（默认 :3000）
                                                                     ↓
                                                          瀑布式 Web 页面展示
```

### 核心功能

| 功能 | 说明 |
|------|------|
| 🔴 红色新闻抓取 | 每 60s 轮询金十数据网页，抓取 `is-important` 红色新闻 |
| �� 多提供商 AI | 支持 MiniMax / OpenAI / Gemini / Claude，依次尝试直到成功 |
| 🌐 Web 展示 | 内置 HTTP 服务器，提供瀑布式新闻展示页面（自动刷新）|
| 📡 Telegram 推送 | 实时推送到指定 Telegram 账号 |
| 🚫 多层过滤 | 自动过滤广告、「点击查看」占位内容、周度日历/预告等低信息密度内容 |
| 🔁 去重 | 72 小时去重窗口，避免重复推送 |
| 🛡️ 熔断器 | 所有提供商连续失败 5 次后暂停 5 分钟 |
| 🔒 PID 锁 | 防止多实例同时运行 |
| 💾 无上限存储 | news.json 无条数上限，历史新闻完整保留 |

## Web 页面

启动后访问 `http://localhost:3000`，即可看到：

- 📌 瀑布式三列卡片布局（自适应屏幕宽度）
- ⏰ 每 30 秒自动刷新，新内容自动置顶
- 🎨 深色主题 + 颜色标注（利好=绿 / 利空=红 / 中性=灰）
- 📊 每条新闻附带可折叠 AI 分析块（标的 / 方向 / 逻辑链 / 核心驱动 / 关键风险 / 确认信号 / 技术面）
- 📈 TradingView 技术面指标（RSI14/EMA20/EMA50/SMA200）展示
- 🔻 加载更多（游标分页）

## REST API 接口

Web 服务器同时对外暴露以下 API 接口（可供第三方集成）：

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/news` | GET | 获取新闻列表（支持 `limit` / `before` 分页参数）|
| `/api/status` | GET | 获取监控运行状态（推送次数、失败次数、最近错误等）|
| `/api/health` | GET | 健康检查 |

### `/api/news` 查询参数

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `limit` | int | 20 | 每页条数（最大 100） |
| `before` | int | 0 | 游标分页：返回 `createdAt < before` 的条目 |

### 响应示例

```json
{
  "ok": true,
  "total": 42,
  "hasMore": true,
  "items": [{ "id": "abc123", "time": "14:13:25", "title": "...", "content": "...",
    "analysis": "标的：原油\n方向：利空 (85%)\n...", "analysisSource": "OpenAI/gpt-4o",
    "technical": "...", "createdAt": 1710640405000 }]
}
```

## 目录结构

```
jin10-monitor/
├── monitor.mjs       # 主程序（监控 + Web 服务器）
├── public/
│   └── index.html    # 瀑布式 Web 页面
├── config.json       # 配置（需自行创建）
├── package.json      # 依赖
├── news.json         # 新闻存储（运行时自动生成，无上限）
├── dedup.json        # 去重数据（运行时自动生成）
└── state.json        # 运行状态（运行时自动生成）
```

## 配置

创建 `config.json`（推荐多提供商配置）：

```json
{
  "TELEGRAM_BOT_TOKEN": "your-bot-token",
  "TELEGRAM_CHAT_ID":   "your-chat-id",
  "WEB_PORT": 3000,
  "AI_PROVIDERS": [
    { "type": "openai",   "apiKey": "sk-...",     "model": "gpt-4o" },
    { "type": "gemini",   "apiKey": "AIza...",    "model": "gemini-1.5-pro" },
    { "type": "claude",   "apiKey": "sk-ant-...", "model": "claude-3-5-sonnet-20241022" },
    { "type": "minimax",  "apiKey": "your-minimax-api-key" }
  ]
}
```

提供商按数组顺序尝试，第一个成功即返回，其余跳过。

### 单提供商（向后兼容）

旧配置格式仍可用，`MINIMAX_API_KEY` 会自动作为唯一 MiniMax 提供商：

```json
{
  "MINIMAX_API_KEY": "your-minimax-api-key"
}
```

### AI 提供商配置说明

| `type` | 默认模型 | API 文档 |
|--------|----------|----------|
| `minimax` | MiniMax-M2.5 | https://api.minimaxi.com |
| `openai` | gpt-4o | https://platform.openai.com/docs |
| `gemini` | gemini-1.5-pro | https://ai.google.dev |
| `claude` | claude-3-5-sonnet-20241022 | https://docs.anthropic.com |

每个提供商配置项：

| 字段 | 必填 | 说明 |
|------|------|------|
| `type` | ✅ | 提供商类型（见上表）|
| `apiKey` | ✅ | 对应平台的 API Key |
| `model` | ❌ | 模型名称（不填使用上表默认值）|

### 其他配置项

| 字段 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `TELEGRAM_BOT_TOKEN` | ❌ | — | Telegram Bot API Token（不配则不推送）|
| `TELEGRAM_CHAT_ID` | ❌ | — | 推送目标 Chat ID |
| `WEB_PORT` | ❌ | 3000 | Web 服务器监听端口 |

## 运行

### 前置条件
- Node.js 18+（推荐 22+）

### 启动

```bash
cd jin10-monitor
npm install          # 首次安装依赖
node monitor.mjs     # 前台运行
# 或后台运行
nohup node monitor.mjs >> stdout.log 2>> stderr.log &
```

启动后：
- 监控程序开始抓取金十数据
- Web 服务器在 `http://localhost:3000` 启动
- 新闻及 AI 分析实时保存到 `news.json`（无上限），Web 页面自动刷新展示

### 停止

```bash
# 通过 PID 文件发送终止信号
node -e "process.exit(parseInt(require('fs').readFileSync('.lock','utf-8')))"
# 或通过进程名搜索
pkill -f monitor.mjs
```

### 查看日志

```bash
tail -f stdout.log   # 实时日志
cat state.json       # 运行统计（推送次数、最近错误等）
```

## 关键参数（代码内）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `POLL_MS` | 60,000ms | 轮询间隔 |
| `DEDUP_HOURS` | 72h | 去重窗口 |
| `HTTP_PORT` | 3000 | Web 服务器端口（`WEB_PORT` 配置）|

## AI 提供商对比

| 提供商 | 优点 | 适用场景 |
|--------|------|----------|
| OpenAI GPT-4o | 综合能力强，格式遵循好 | 首选主力 |
| Gemini 1.5 Pro | 速度快，成本低 | 备用/大量分析 |
| Claude | 格式严谨，中文表达好 | 高质量分析 |
| MiniMax | 国内网络友好 | 国内环境备用 |

## API 依赖

| 服务 | 用途 | 必填 |
|------|------|------|
| jin10.com | 新闻抓取来源 | ✅ |
| OpenAI / Gemini / Claude / MiniMax | AI 分析（至少配一个）| ❌ |
| Telegram Bot API | 消息推送 | ❌ |
| TradingView | 技术面指标抓取 | ❌ |
