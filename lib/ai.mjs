/**
 * AI 提供商调用与分析模块
 */
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getNewsAiProviders } from './config.mjs';
import { saveState } from './dedup.mjs';
import { sleep, log, logErr } from './utils.mjs';

// ── AI 提供商调用函数 ──────────────────────────────────────────────

async function callMinimax(apiKey, model, prompt, timeoutMs, baseUrl) {
  const usedModel = model || 'MiniMax-M2.5';
  const client = new Anthropic({
    apiKey,
    baseURL: baseUrl ? baseUrl.replace(/\/+$/, '') : 'https://api.minimaxi.com/anthropic/v1',
  });
  const msg = await client.messages.create({
    model: usedModel,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  }, { timeout: timeoutMs });
  const blk = msg.content?.find(b => b.type === 'text' && b.text);
  if (blk) return { text: blk.text.trim(), source: `MiniMax/${usedModel}` };
  throw new Error('empty response');
}

async function callOpenai(apiKey, model, prompt, timeoutMs, baseUrl) {
  const usedModel = model || 'gpt-4o';
  const client = new OpenAI({
    apiKey,
    ...(baseUrl ? { baseURL: baseUrl.replace(/\/+$/, '') } : {}),
  });
  const res = await client.chat.completions.create({
    model: usedModel,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  }, { timeout: timeoutMs });
  const txt = res.choices?.[0]?.message?.content?.trim();
  if (txt) return { text: txt, source: `OpenAI/${usedModel}` };
  throw new Error('empty response');
}

async function callGemini(apiKey, model, prompt, timeoutMs, baseUrl) {
  const m = model || 'gemini-2.0-flash';
  const genAI = new GoogleGenerativeAI(apiKey);
  const genModel = genAI.getGenerativeModel({ model: m }, baseUrl ? { baseUrl: baseUrl.replace(/\/+$/, '') } : undefined);
  const result = await genModel.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 1024 },
  }, { timeout: timeoutMs });
  const txt = result.response?.text()?.trim();
  if (txt) return { text: txt, source: `Gemini/${m}` };
  throw new Error('empty response');
}

async function callClaude(apiKey, model, prompt, timeoutMs, baseUrl) {
  const usedModel = model || 'claude-sonnet-4-20250514';
  const client = new Anthropic({
    apiKey,
    ...(baseUrl ? { baseURL: baseUrl.replace(/\/+$/, '') } : {}),
  });
  const msg = await client.messages.create({
    model: usedModel,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  }, { timeout: timeoutMs });
  const blk = msg.content?.find(b => b.type === 'text' && b.text);
  if (blk) return { text: blk.text.trim(), source: `Claude/${usedModel}` };
  throw new Error('empty response');
}

async function callProvider(provider, prompt, timeoutMs) {
  const { type, apiKey, model, baseUrl } = provider;
  switch (type) {
    case 'minimax': return callMinimax(apiKey, model, prompt, timeoutMs, baseUrl);
    case 'openai':  return callOpenai(apiKey, model, prompt, timeoutMs, baseUrl);
    case 'gemini':  return callGemini(apiKey, model, prompt, timeoutMs, baseUrl);
    case 'claude':  return callClaude(apiKey, model, prompt, timeoutMs, baseUrl);
    default: throw new Error(`unknown provider type: ${type}`);
  }
}

// ── AI 分析主逻辑 ──────────────────────────────────────────────────

export async function analyze(item, state) {
  const now = Date.now();
  const AI_PROVIDERS = getNewsAiProviders();
  if (state?.aiDisabledUntil && now < state.aiDisabledUntil) return null;
  if (AI_PROVIDERS.length === 0) return null;

  const prompt = `你是一个"可交易"的金融快讯分析器。请严格按下面格式输出，仅允许这 7 行（每行一句），不允许出现其他行/空行/项目符号。注意：第二行的字段名必须是"方向："，不要输出"判断：/说明：/结论："。

标的：给出最相关的交易标的（1-3 个），优先：美股/指数/中概/加密/港股/A股；用逗号分隔；不确定就写"未知"
方向：只允许输出"利好/利空/中性 + 置信度(0-100)"，不要写"判断/说明/结论"
逻辑链：用"→"写 3-5 步因果链，从新闻到标的价格
核心驱动：一句话点名定价因子（利率预期/风险偏好/盈利预期/监管/资金面/供需/汇率等）
关键风险：只写 1-2 条，必须具体
确认信号：只写 1-2 个，必须可验证（例如 2Y/10Y、DXY、期指、成交量、后续数据/发言）
技术面：对"标的"里最相关的 1-2 个给出 RSI(14)/EMA20/EMA50/SMA200（仅用 TradingView 技术面数据；拿不到就写"缺数据"）

新闻："${item.title || ''} ${item.content}"`;

  const looksOk = (t) => {
    const s = String(t || '').trim();
    const hasRequired = (
      /^标的：/m.test(s) &&
      /^方向：/m.test(s) &&
      /^逻辑链：/m.test(s) &&
      /^核心驱动：/m.test(s) &&
      /^关键风险：/m.test(s) &&
      /^确认信号：/m.test(s) &&
      /^技术面：/m.test(s)
    );
    const hasLegacy = (
      /^结论：/m.test(s) ||
      /^驱动：/m.test(s) ||
      /^风险：/m.test(s) ||
      /^关注：/m.test(s)
    );
    return hasRequired && !hasLegacy;
  };

  const timeouts = [20_000, 30_000];
  for (const timeoutMs of timeouts) {
    for (const provider of AI_PROVIDERS) {
      try {
        const res = await callProvider(provider, prompt, timeoutMs);
        if (!looksOk(res?.text)) throw new Error('bad format (missing required fields)');
        state.aiFailConsecutive = 0;
        state.aiDisabledUntil = null;
        saveState(state);
        log(`🤖 AI (${res.source}): OK`);
        return res;
      } catch (e) {
        logErr(`AI (${provider.type}): ${e.message}`);
        await sleep(500);
      }
    }
  }

  state.aiFailConsecutive = (state.aiFailConsecutive || 0) + 1;
  state.lastErrorAt = Date.now();
  state.lastError = 'AI: all providers failed';

  const N = 5;
  const COOL_MS = 5 * 60_000;
  if (state.aiFailConsecutive >= N) {
    state.aiDisabledUntil = Date.now() + COOL_MS;
    state.aiFailConsecutive = 0;
  }
  saveState(state);

  return null;
}

// ── TradingView 技术面分析辅助函数 ───────────────────────────────────

export function extractTickersFromAnalysis(analysisText) {
  const m = String(analysisText || '').match(/^标的：\s*(.+)$/m);
  if (!m) return [];
  return m[1]
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);
}

export function mapToTradingViewSymbol(ticker) {
  const raw = String(ticker || '').trim();
  const t = raw.toUpperCase();
  const direct = {
    XAUUSD: 'XAUUSD',
    GOLD: 'XAUUSD',
    '黄金': 'XAUUSD',
    BTC: 'BTCUSD',
    BTCUSD: 'BTCUSD',
    ETH: 'ETHUSD',
    ETHUSD: 'ETHUSD',
    DXY: 'TVC:DXY',
    '美元指数DXY': 'TVC:DXY',
    '美元指数': 'TVC:DXY',
    SPX: 'SPX',
    '标普500': 'SPX',
    '标普500指数': 'SPX',
    NDX: 'NASDAQ:NDX',
    '纳斯达克100': 'NASDAQ:NDX',
    '纳斯达克100指数': 'NASDAQ:NDX',
  };
  if (direct[t]) return direct[t];

  const hk = raw.match(/\(?\s*(\d{4,5})\.HK\s*\)?/i);
  if (hk) {
    const num = String(parseInt(hk[1], 10));
    return `HKEX:${num}`;
  }

  if (/^[A-Z]{1,5}$/.test(t)) return t;

  return null;
}

function tradingViewTechnicalsUrl(tvSymbol) {
  if (tvSymbol === 'TVC:DXY') return 'https://www.tradingview.com/symbols/TVC-DXY/technicals/';
  if (tvSymbol === 'NASDAQ:NDX') return 'https://www.tradingview.com/symbols/NASDAQ-NDX/technicals/';
  if (tvSymbol === 'SPX') return 'https://www.tradingview.com/symbols/SPX/technicals/';
  if (tvSymbol === 'SPY') return 'https://www.tradingview.com/symbols/SPY/technicals/';
  if (tvSymbol === 'QQQ') return 'https://www.tradingview.com/symbols/QQQ/technicals/';

  const ex = String(tvSymbol || '').match(/^([A-Z]+):(\d+)$/);
  if (ex) return `https://www.tradingview.com/symbols/${ex[1]}-${ex[2]}/technicals/`;

  return `https://www.tradingview.com/symbols/${encodeURIComponent(tvSymbol)}/technicals/`;
}

/**
 * 解析 TradingView 技术指标行
 * 格式示例: "RSI(14)   55.2   Neutral" / "EMA(20)   Buy"
 * 返回 { 'RSI(14)': { value: '55.2', signal: 'Neutral' }, 'EMA(20)': { signal: 'Buy' }, ... }
 */
export function parseTradingViewRows(lines) {
  const pat = /^((?:RSI|EMA|SMA|MACD|Stoch(?:\.\w+)?)(?:\(\d+\))?)\s+([\d.]+)?\s*(Buy|Sell|Neutral|Strong Buy|Strong Sell|Overbought|Oversold)?/i;
  const result = {};
  for (const line of (lines || [])) {
    const m = String(line).trim().match(pat);
    if (m) {
      const key = m[1].replace(/\s+/g, '');
      result[key] = { value: m[2] || '', signal: m[3] || '' };
    }
  }
  return result;
}

/**
 * 从 AI 分析文本中提取技术面摘要。
 * 直接取 AI 生成的 "技术面：" 行内容，因为 AI 已被要求提供
 * RSI(14)/EMA20/EMA50/SMA200 等指标（若无数据则写"缺数据"）。
 */
export function buildTechnicalSummary(analysisText) {
  if (!analysisText) return '';
  const lines = String(analysisText).split('\n');
  const techLine = lines.find(l => /^技术面[：:]/.test(l));
  if (!techLine) return '';
  return techLine.replace(/^技术面[：:]/, '').trim();
}
