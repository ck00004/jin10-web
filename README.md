# Jin10 Monitor

[English](#english) | [中文](#中文)

---

## English

A real-time financial news monitor for jin10.com with AI-powered analysis. Monitors red-flag important news and saves them for web display.

### Features

- 🔴 Real-time monitoring of jin10.com important financial news
- 🤖 AI analysis (target, sentiment, detailed explanation)
- 🌐 Built-in web server for news display
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
  "AI_PROVIDERS": [
    { "type": "minimax", "apiKey": "your-minimax-api-key", "model": "MiniMax-M2.5" },
    { "type": "openai",  "apiKey": "your-openai-api-key",  "model": "gpt-4o" },
    { "type": "gemini",  "apiKey": "your-gemini-api-key",  "model": "gemini-1.5-pro" },
    { "type": "claude",  "apiKey": "your-claude-api-key",  "model": "claude-3-5-sonnet-20241022" }
  ],
  "WEB_PORT": 3000
}
```

You only need to configure the AI providers you actually use. Providers are tried in order; the first successful response is used.

> **Legacy support:** `MINIMAX_API_KEY` is still accepted for backwards compatibility.

#### Supported AI Providers

| type | API Endpoint | Sign up |
|------|-------------|---------|
| `minimax` | https://api.minimaxi.com | https://platform.minimaxi.com |
| `openai`  | https://api.openai.com | https://platform.openai.com |
| `gemini`  | https://generativelanguage.googleapis.com | https://aistudio.google.com |
| `claude`  | https://api.anthropic.com | https://console.anthropic.com |

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
| news.json | Stored news items (for web display) |
| errors.log | Error log |

### Troubleshooting | 故障排除

**AI analysis failed:**
- Verify your API key(s) in `config.json`
- Check API quota
- Check errors.log

---

## 中文

金十数据红色新闻实时监控，带 AI 分析功能。监控重要财经快讯并通过内置 Web 页面展示。

### 功能

- 🔴 实时监控金十财经红色快讯
- 🤖 AI 分析（标的、判断、详细说明）
- 🌐 内置 Web 服务器展示新闻
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
  "AI_PROVIDERS": [
    { "type": "minimax", "apiKey": "你的MiniMax API密钥", "model": "MiniMax-M2.5" },
    { "type": "openai",  "apiKey": "你的OpenAI API密钥",  "model": "gpt-4o" },
    { "type": "gemini",  "apiKey": "你的Gemini API密钥",  "model": "gemini-1.5-pro" },
    { "type": "claude",  "apiKey": "你的Claude API密钥",  "model": "claude-3-5-sonnet-20241022" }
  ],
  "WEB_PORT": 3000
}
```

只需配置你实际使用的 AI 提供商。系统会按顺序尝试，第一个成功的结果即被采用。

> **向后兼容：** 仍支持直接配置 `MINIMAX_API_KEY`。

#### 支持的 AI 提供商

| type | API Endpoint | 注册地址 |
|------|-------------|---------|
| `minimax` | https://api.minimaxi.com | https://platform.minimaxi.com |
| `openai`  | https://api.openai.com | https://platform.openai.com |
| `gemini`  | https://generativelanguage.googleapis.com | https://aistudio.google.com |
| `claude`  | https://api.anthropic.com | https://console.anthropic.com |

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
| news.json | 新闻存储（供 Web 展示） |
| errors.log | 错误日志 |

### 故障排除

**AI 分析失败：**
- 确认 `config.json` 中 API 密钥配置正确
- 检查 API 配额
- 查看 errors.log

---

## License | 许可证

MIT

## Author | 作者

OpenClaw User
