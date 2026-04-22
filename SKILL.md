---
name: jin10-monitor
description: "金十数据红色新闻监控，推送重要财经新闻并提供 AI 分析，内置瀑布式 Web 展示页面。监控美国/中国股市、黄金、原油、加密货币等品种的重要资讯。"
metadata: {"version":"2.0.0","clawdbot":{"emoji":"📊","os":["darwin","linux"],"channels":["telegram","discord","whatsapp"]}}
repository: "https://github.com/ck00004/jin10-web"
---

# Jin10 Monitor Skill

金十数据红色新闻监控，自动推送重要财经资讯并生成 AI 分析，同时提供内置 Web 展示页面。

## 功能

- 🔴 监控金十财经红色快讯
- 🤖 AI 分析新闻影响（标的、利好/利空方向、逻辑链、核心驱动等）
- 🌐 内置 Web 瀑布式展示页面（http://localhost:3000）
- 📱 推送到 Telegram/Discord/WhatsApp
- 🔄 自动去重（72小时）

## 快速开始

```bash
cd jin10-monitor
npm install
node monitor.mjs
```

启动后访问 http://localhost:3000 查看 Web 展示页面。

## 配置

创建 `jin10-monitor/config.json`：

```json
{
  "TELEGRAM_BOT_TOKEN": "your-bot-token",
  "TELEGRAM_CHAT_ID": "your-chat-id",
  "MINIMAX_API_KEY": "your-api-key",
  "WEB_PORT": 3000
}
```

## AI 分析格式

每条新闻都会生成 7 字段 AI 分析：

```
📊 AI 分析（MiniMax-M2.5）
标的：纳指
方向：利空 (78%)
逻辑链：鹰派发言 → 降息预期推后 → 长端利率上行 → 科技股承压
核心驱动：利率预期
关键风险：就业数据超预期走弱
确认信号：2Y美债收益率、FOMC会议纪要
技术面：纳指：RSI14 51.2（中性区间）
```

## 故障排除

### 没有收到推送

1. 检查 config.json 配置是否正确
2. 检查 Bot Token 是否有权限
3. 查看日志：`tail -f jin10-monitor/errors.log`

### AI 分析失败

1. 确认 MINIMAX_API_KEY 配置正确
2. 检查 API 额度是否用完
3. 检查 state.json 中的熔断状态（aiDisabledUntil）

### 重复推送

```bash
echo '{}' > jin10-monitor/dedup.json
```

## Web API

| 接口 | 说明 |
|------|------|
| GET /api/news | 获取新闻列表 |
| GET /api/status | 获取监控状态 |
| GET /api/health | 健康检查 |
