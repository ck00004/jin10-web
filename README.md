# Jin10 Monitor

[English](#english) | [中文](#中文)

---

## English

A real-time financial news monitor for jin10.com with AI-powered analysis. Monitors red-flag important news and sends notifications via Telegram/Discord/WhatsApp.

### Features

- 🔴 Real-time monitoring of jin10.com important financial news
- 🤖 AI analysis (target, sentiment, detailed explanation)
- 📱 Push notifications to Telegram/Discord/WhatsApp
- 🔄 Auto deduplication (72 hours)
- 📊 Supports: US/China stocks, gold, oil, cryptocurrency, forex

### Installation | 安装

```bash
cd ~/.openclaw/workspace
git clone https://github.com/YOUR_USERNAME/jin10-monitor.git
# or create manually and copy monitor.mjs
```

### Configuration | 配置

Create `config.json`:

```json
{
  "TELEGRAM_BOT_TOKEN": "your-bot-token",
  "TELEGRAM_CHAT_ID": "your-chat-id",
  "MINIMAX_API_KEY": "your-api-key"
}
```

#### Get Telegram Bot Token
1. Open @BotFather on Telegram
2. Send `/newbot` to create a bot
3. Copy the token

#### Get Telegram Chat ID
1. Open @userinfobot on Telegram
2. Send any message
3. Copy your Chat ID

#### Get MiniMax API Key
Sign up at https://platform.minimaxi.com

### Usage | 使用

```bash
# Start monitoring
node monitor.mjs

# Run in background
nohup node monitor.mjs > /tmp/jin10.log 2>&1 &

# Stop
pkill -f "monitor.mjs"
```

### AI Analysis Format | AI 分析格式

Each news item includes AI analysis:

```
📊 AI Analysis
Target: NASDAQ
Sentiment: Bullish
Explanation: Detailed explanation of market impact...
```

### Deduplication | 去重

The system automatically deduplicates news within 72 hours. To clear deduplication:

```bash
echo '{}' > dedup.json
```

### Files | 文件

| File | Description |
|------|-------------|
| monitor.mjs | Main monitoring script |
| config.json | Configuration (not in git) |
| dedup.json | Deduplication cache |
| errors.log | Error log |

### Troubleshooting | 故障排除

**No notifications received:**
- Check config.json is correct
- Verify Bot Token has permissions
- Check errors.log

**AI analysis failed:**
- Verify MINIMAX_API_KEY is correct
- Check API quota

---

## 中文

金十数据红色新闻实时监控，带 AI 分析功能。监控重要财经快讯并通过 Telegram/Discord/WhatsApp 推送通知。

### 功能

- 🔴 实时监控金十财经红色快讯
- 🤖 AI 分析（标的、判断、详细说明）
- 📱 推送到 Telegram/Discord/WhatsApp
- 🔄 自动去重（72小时）
- 📊 支持：中美股市、黄金、原油、加密货币、外汇

### 安装

```bash
cd ~/.openclaw/workspace
git clone https://github.com/YOUR_USERNAME/jin10-monitor.git
# 或手动创建并复制 monitor.mjs
```

### 配置

创建 `config.json`:

```json
{
  "TELEGRAM_BOT_TOKEN": "你的机器人Token",
  "TELEGRAM_CHAT_ID": "你的Chat ID",
  "MINIMAX_API_KEY": "你的API密钥"
}
```

#### 获取 Telegram Bot Token
1. 在 Telegram 打开 @BotFather
2. 发送 `/newbot` 创建机器人
3. 复制 Token

#### 获取 Telegram Chat ID
1. 在 Telegram 打开 @userinfobot
2. 发送任意消息
3. 复制你的 Chat ID

#### 获取 MiniMax API Key
在 https://platform.minimaxi.com 注册

### 使用

```bash
# 启动监控
node monitor.mjs

# 后台运行
nohup node monitor.mjs > /tmp/jin10.log 2>&1 &

# 停止
pkill -f "monitor.mjs"
```

### AI 分析格式

每条新闻都会生成 AI 分析：

```
📊 AI 分析
标的：纳指
判断：利好
说明：详细说明具体影响原因和市场预期...
```

### 去重

系统自动去重 72 小时内的新闻。清除去重：

```bash
echo '{}' > dedup.json
```

### 文件说明

| 文件 | 说明 |
|------|------|
| monitor.mjs | 主监控脚本 |
| config.json | 配置文件（不提交到 git） |
| dedup.json | 去重缓存 |
| errors.log | 错误日志 |

### 故障排除

**没有收到推送：**
- 检查 config.json 配置是否正确
- 验证 Bot Token 是否有权限
- 查看 errors.log

**AI 分析失败：**
- 确认 MINIMAX_API_KEY 正确
- 检查 API 配额

---

## License | 许可证

MIT

## Author | 作者

OpenClaw User
