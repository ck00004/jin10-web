# 金十红色新闻监控 + AI 分析 + Web 展示

实时监控 [金十数据](https://www.jin10.com/) 的红色重要新闻，自动推送到 Telegram，附带 AI 分析；
同时内置独立 Web 服务器，以瀑布式页面展示所有新闻与 AI 分析结果。

## 功能概览

```
金十网页 → Playwright 抓取 → 去重过滤 → AI 分析（MiniMax） → 广告过滤 → Telegram 推送
                                                                    ↓
                                                          保存到 news.json
                                                                    ↓
                                                  内置 Web 服务器（默认 :3000）
                                                                    ↓
                                                         瀑布式 Web 页面展示
```

### 核心功能

| 功能 | 说明 |
|------|------|
| 🔴 红色新闻抓取 | 每 60s 轮询金十数据网页，抓取 `is-important` 红色新闻 |
| 🤖 AI 分析 | MiniMax-M2.5 分析（标的/方向/逻辑链/核心驱动/关键风险/确认信号/技术面 7 字段） |
| 🌐 Web 展示 | 内置 HTTP 服务器，提供瀑布式新闻展示页面（自动刷新）|
| 📡 Telegram 推送 | 实时推送到指定 Telegram 账号 |
| 🚫 多层过滤 | 自动过滤广告、「点击查看」占位内容、周度日历/预告等低信息密度内容 |
| 🔁 去重 | 72 小时去重窗口，避免重复推送 |
| 🛡️ 熔断器 | AI 连续失败 5 次后暂停 5 分钟，保护下游 API |
| 🔒 PID 锁 | 防止多实例同时运行 |

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
    "analysis": "标的：原油\n方向：利空 (85%)\n...", "analysisSource": "MiniMax-M2.5",
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
├── news.json         # 新闻存储（运行时自动生成，最多 500 条）
├── dedup.json        # 去重数据（运行时自动生成）
└── state.json        # 运行状态（运行时自动生成）
```

## 配置

创建 `config.json`：

```json
{
  "TELEGRAM_BOT_TOKEN": "your-bot-token",
  "TELEGRAM_CHAT_ID":   "your-chat-id",
  "MINIMAX_API_KEY":    "your-minimax-api-key",
  "WEB_PORT":           3000
}
```

| 字段 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `TELEGRAM_BOT_TOKEN` | ❌ | — | Telegram Bot API Token（不配则不推送）|
| `TELEGRAM_CHAT_ID` | ❌ | — | 推送目标 Chat ID |
| `MINIMAX_API_KEY` | ❌ | — | MiniMax API Key（不配则跳过 AI 分析）|
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
- 新闻及 AI 分析实时保存到 `news.json`，Web 页面自动刷新展示

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

## 关键参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `POLL_MS` | 60,000ms | 轮询间隔 |
| `DEDUP_HOURS` | 72h | 去重窗口 |
| `MAX_NEWS_ITEMS` | 500 | news.json 最大保留条数 |
| `HTTP_PORT` | 3000 | Web 服务器端口（`WEB_PORT` 配置）|

## API 依赖

| 服务 | 用途 | 必填 |
|------|------|------|
| jin10.com | 新闻抓取来源 | ✅ |
| MiniMax API | AI 分析 | ❌ |
| Telegram Bot API | 消息推送 | ❌ |
| TradingView | 技术面指标抓取 | ❌ |
