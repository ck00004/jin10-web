# 金十红色新闻监控 + AI 分析

实时监控 [金十数据](https://www.jin10.com/) 的红色重要新闻，自动推送到 Telegram，并附带 AI 分析（标的、利好/利空判断、简要说明）。

## 功能概览

```
金十网页 → Playwright 抓取 → 去重过滤 → AI 分析 → 广告过滤 → Telegram 推送
```

### 核心功能

| 功能 | 说明 |
|------|------|
| 🔴 红色新闻抓取 | 每 60s 轮询金十数据网页，抓取标记为 `is-important` 的红色新闻 |
| 🤖 AI 分析 | 使用 MiniMax-M2.5 模型分析每条新闻的标的、利好/利空及原因 |
| 🚫 广告过滤 | 自动过滤金十营销广告（VIP、猜金价、竞猜等活动） |
| 📡 Telegram 推送 | 实时推送到指定 Telegram 账号 |
| 🔁 去重 | 72 小时去重窗口，避免重复推送 |
| 🛡️ 容错 | AI 分析失败时静默跳过，不影响新闻推送 |
| 🔒 PID 锁 | 防止多实例同时运行，启动时自动清理旧进程 |

## 推送效果

```
📡 金十重要新闻推送
⏰ 14:13:25
📌 英媒：若美国愿意解除制裁 伊朗将考虑就核谈判做出妥协
伊朗高级官员表示...

📊 AI 分析
标的：原油(WTI)
判断：利空
说明：美伊和解或促伊朗原油重返市场，增加供应预期压低油价。
```

## 技术架构

### 数据采集
- **方式**：Playwright 直接启动 headless Chromium 抓取网页（不依赖 OpenClaw 浏览器/CDP）
- **目标页面**：`https://www.jin10.com/`
- **抓取选择器**：`.jin-flash-item-container` 中带 `.is-important` 类的条目
- **提取字段**：时间（`.item-time`）、标题（`.right-common-title`）、内容（`.right-content`）

### AI 分析
- **模型**：MiniMax-M2.5（通过 Anthropic 兼容 API）
- **API 地址**：`https://api.minimaxi.com/anthropic/v1/messages`
- **超时**：15 秒
- **容错**：API 超时/限流/返回异常时，跳过分析，直接推送原始新闻
- **分析格式**：
  ```
  标的：原油(WTI)
  判断：利好/利空/中性
  说明：一句话说明原因
  ```

### 广告过滤
自动过滤包含以下关键词的新闻：
- `VIP` + 数字/折
- `猜金价`、`竞猜...赢`
- `领取...礼`、`解锁...利器`
- `新春福利`

过滤的新闻会记录到去重，但不会推送到 Telegram。

### 去重机制
- **存储**：`dedup.json`（SHA1 hash 作为 key）
- **窗口**：72 小时（超过自动清理）
- **key 计算**：元素 ID 或 `sha1(时间 + 内容)`

### 进程管理
- **PID 锁文件**：`monitor.pid`，防止多实例
- **启动清理**：每次启动时自动 `pkill` 清理所有旧实例
- **信号处理**：SIGINT / SIGTERM 时清理锁文件
- **浏览器重连**：最多 10 次尝试，失败后退出

## 目录结构

```
jin10-monitor/
├── monitor.mjs      # 主程序
├── config.json      # 配置（Telegram token、MiniMax API key）
├── package.json     # 依赖
├── README.md        # 本文件
├── dedup.json       # 去重数据（自动生成）
├── monitor.pid      # PID 锁文件（运行时自动生成）
├── stdout.log       # 标准输出日志
├── stderr.log       # 标准错误日志
└── errors.log       # 应用级错误日志
```

## 配置

`config.json`：

```json
{
  "TELEGRAM_BOT_TOKEN": "your-bot-token",
  "TELEGRAM_CHAT_ID": "your-chat-id",
  "MINIMAX_API_KEY": "your-minimax-api-key"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `TELEGRAM_BOT_TOKEN` | ✅ | Telegram Bot API Token |
| `TELEGRAM_CHAT_ID` | ✅ | 推送目标的 Telegram Chat ID |
| `MINIMAX_API_KEY` | ❌ | MiniMax API Key（不配则跳过 AI 分析） |

## 运行

### 前置条件
- Node.js 22+
- OpenClaw 浏览器已启动（`openclaw browser` 的 `openclaw` profile，CDP 端口 18800）
- 金十数据页面已在浏览器中打开

### 启动

```bash
cd jin10-monitor
npm install          # 首次安装依赖
node monitor.mjs     # 前台运行

# 或后台运行（会自动清理旧实例）
nohup node monitor.mjs >> stdout.log 2>> stderr.log &
```

### 停止

```bash
kill $(cat monitor.pid)
# 或
pkill -f "jin10-monitor/monitor.mjs"
```

### 查看日志

```bash
tail -f stdout.log   # 实时日志
tail -f stderr.log   # 错误日志
```

## 关键参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `POLL_MS` | 60,000 (60s) | 轮询间隔 |
| `JITTER_MS` | 5,000 (5s) | 轮询抖动范围（±5s） |
| `CDP_PORT` | 18800 | Chrome CDP 端口 |
| `DEDUP_HOURS` | 72 | 去重窗口（小时） |
| `AI_TIMEOUT_MS` | 15,000 (15s) | AI 分析超时 |
| `AI_MODEL` | MiniMax-M2.5 | AI 模型 |
| `AI_MAX_TOKENS` | 1024 | AI 分析响应最大 token 数 |
| `maxReconnectAttempts` | 10 | 浏览器最大重连次数 |

## 注意事项

1. **不要关闭浏览器中的金十页面**，监控依赖 CDP 连接该页面抓取数据
2. AI 分析使用 MiniMax API，有额度限制。**超额时自动跳过分析，推送不受影响**
3. 长消息（>4000 字符）会自动拆分为多条推送
4. 所有错误仅记录本地日志，**绝不会发送到 Telegram**
5. 启动时会自动清理旧实例，确保只有一个进程运行

## API 依赖

- **Telegram Bot API**：推送消息到 Telegram
- **MiniMax API**（可选）：AI 分析功能，不配置则跳过
- **OpenClaw 浏览器**：通过 CDP 协议抓取金十网页内容
