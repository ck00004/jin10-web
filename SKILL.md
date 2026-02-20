---
name: jin10-monitor
description: "金十数据红色新闻监控，推送重要财经新闻并提供 AI 分析。监控美国/中国股市、黄金、原油、加密货币等品种的重要资讯。"
metadata: {"version":"1.0.0","clawdbot":{"emoji":"📊","os":["darwin","linux"],"channels":["telegram","discord","whatsapp"]}}
repository: "https://github.com/winglight9/jin10-monitor"
---

# Jin10 Monitor Skill

金十数据红色新闻监控，自动推送重要财经资讯并生成 AI 分析。

## 功能

- 🔴 监控金十财经红色快讯
- 🤖 AI 分析新闻影响（标的、判断、详细说明）
- 📱 推送到 Telegram/Discord/WhatsApp
- 🔄 自动去重（72小时）

## 快速开始

```
帮我启动金十监控
```

或手动启动：

```bash
cd ~/.openclaw/workspace/jin10-monitor
node monitor.mjs
```

## 配置

首次运行前需要配置：

1. **Telegram Bot Token** - @BotFather 创建
2. **Telegram Chat ID** - 你的 Telegram ID
3. **MiniMax API Key** - 用于 AI 分析

创建 `~/.openclaw/workspace/jin10-monitor/config.json`：

```json
{
  "TELEGRAM_BOT_TOKEN": "your-bot-token",
  "TELEGRAM_CHAT_ID": "your-chat-id",
  "MINIMAX_API_KEY": "your-api-key"
}
```

## AI 分析格式

每条新闻都会生成 AI 分析：

```
📊 AI 分析
标的：纳指
判断：利好
说明：详细说明具体影响原因和市场预期...
```

## 命令

| 命令 | 说明 |
|------|------|
| 启动金十监控 | 启动监控进程 |
| 停止金十监控 | 停止监控进程 |
| 金十状态 | 查看监控状态 |
| 清空金十去重 | 重新推送所有历史新闻 |

## 故障排除

### 没有收到推送

1. 检查 config.json 配置是否正确
2. 检查 Bot Token 是否有权限
3. 查看日志：`tail -f ~/.openclaw/workspace/jin10-monitor/errors.log`

### AI 分析失败

1. 确认 MINIMAX_API_KEY 配置正确
2. 检查 API 额度是否用完

### 重复推送

运行清空去重：

```bash
echo '{}' > ~/.openclaw/workspace/jin10-monitor/dedup.json
```

## 文件位置

- 监控脚本：`~/.openclaw/workspace/jin10-monitor/monitor.mjs`
- 配置文件：`~/.openclaw/workspace/jin10-monitor/config.json`
- 去重文件：`~/.openclaw/workspace/jin10-monitor/dedup.json`
- 错误日志：`~/.openclaw/workspace/jin10-monitor/errors.log`
