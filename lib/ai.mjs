/**
 * AI 提供商调用与分析模块
 */
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getAiProviders, getAiDebug } from './config.mjs';
import { log, logErr, sleep } from './utils.mjs';
import { saveState } from './dedup.mjs';

const AI_FAIL_THRESHOLD = 5;
const AI_PAUSE_MS = 5 * 60_000;
const ANALYZE_TIMEOUTS = [30_000, 60_000];

async function callProvider(provider, prompt, timeoutMs) {
  const { type, apiKey, model, baseUrl } = provider;

  if (type === 'minimax') {
    const usedModel = model || 'MiniMax-M2.5';
    const client = new Anthropic({
      apiKey,
      baseURL: baseUrl ? baseUrl.replace(/\/+$/, '') : 'https://api.minimaxi.com/anthropic/v1',
    });
    const msg = await client.messages.create({
      model: usedModel, max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }, { timeout: timeoutMs });
    const blk = msg.content?.find(b => b.type === 'text' && b.text);
    if (blk) return { text: blk.text.trim(), source: `MiniMax/${usedModel}` };
    throw new Error('empty response');
  }

  if (type === 'openai') {
    const usedModel = model || 'gpt-4o';
    const client = new OpenAI({
      apiKey, ...(baseUrl ? { baseURL: baseUrl.replace(/\/+$/, '') } : {}),
    });
    const res = await client.chat.completions.create({
      model: usedModel, max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }, { timeout: timeoutMs });
    const txt = res.choices?.[0]?.message?.content?.trim();
    if (txt) return { text: txt, source: `OpenAI/${usedModel}` };
    throw new Error('empty response');
  }

  if (type === 'gemini') {
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

  if (type === 'claude') {
    const usedModel = model || 'claude-sonnet-4-20250514';
    const client = new Anthropic({
      apiKey, ...(baseUrl ? { baseURL: baseUrl.replace(/\/+$/, '') } : {}),
    });
    const msg = await client.messages.create({
      model: usedModel, max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }, { timeout: timeoutMs });
    const blk = msg.content?.find(b => b.type === 'text' && b.text);
    if (blk) return { text: blk.text.trim(), source: `Claude/${usedModel}` };
    throw new Error('empty response');
  }

  throw new Error(`unknown provider type: ${type}`);
}

function buildPrompt(item) {
  const title = item.title ? `标题：${item.title}\n` : '';
  const content = `内容：${item.content}`;
  return `你是一名专业的金融市场分析师，请对以下财经快讯进行简洁的结构化分析。

${title}${content}

请严格按以下格式输出（每项独立一行，字段名后接"："，不要添加多余内容）：
标的：受影响的主要交易标的（股票/指数/货币/大宗商品，逗号分隔）
方向：利好或利空，后跟"置信度"和0-100的数字
逻辑链：新闻事件 → 市场预期变化 → 资金流向 → 标的价格影响（用箭头连接）
核心驱动：一个词或短语，点明核心市场定价因子
关键风险：可能导致判断失误的1-2个风险因素（逗号分隔）
确认信号：用于验证方向的1-2个市场信号（逗号分隔）
技术面：主要标的当前技术面简述（趋势、RSI、均线等）`;
}

export async function analyze(item, state) {
  // Check if AI is temporarily disabled due to consecutive failures
  if (state && state.aiDisabledUntil && Date.now() < state.aiDisabledUntil) {
    const remaining = Math.ceil((state.aiDisabledUntil - Date.now()) / 1000);
    log(`⏸️ AI 分析暂停中（剩余 ${remaining}s），跳过分析`);
    return null;
  }

  const AI_PROVIDERS = getAiProviders();
  if (AI_PROVIDERS.length === 0) return null;

  const aiDebug = getAiDebug();
  const prompt = buildPrompt(item);
  if (aiDebug) {
    log(`[AI DEBUG] 分析请求:\n${prompt}`);
  }

  for (const timeoutMs of ANALYZE_TIMEOUTS) {
    for (const provider of AI_PROVIDERS) {
      try {
        const result = await callProvider(provider, prompt, timeoutMs);
        if (!result?.text) throw new Error('empty response');
        if (aiDebug) {
          log(`[AI DEBUG] ${result.source} 响应:\n${result.text}`);
        }
        // Reset failure counter on success
        if (state) {
          state.aiFailConsecutive = 0;
          state.aiDisabledUntil = null;
          saveState(state);
        }
        log(`🤖 AI 分析完成 (${result.source}): ${item.title?.substring(0, 30) || item.content?.substring(0, 30)}`);
        return result;
      } catch (e) {
        logErr(`AI 分析失败 (${provider.type}, timeout=${timeoutMs}ms): ${e.message}`);
        await sleep(500);
      }
    }
  }

  // All providers failed — update consecutive failure count
  if (state) {
    state.aiFailConsecutive = (state.aiFailConsecutive || 0) + 1;
    if (state.aiFailConsecutive >= AI_FAIL_THRESHOLD) {
      state.aiDisabledUntil = Date.now() + AI_PAUSE_MS;
      logErr(`AI 连续失败 ${state.aiFailConsecutive} 次，暂停 ${AI_PAUSE_MS / 60_000} 分钟后自动恢复`);
    }
    saveState(state);
  }

  return null;
}

export async function buildTechnicalSummary(analysisText) {
  if (!analysisText) return '';
  const lines = analysisText.split('\n');
  const techLine = lines.find(l => /^技术面[：:]/.test(l));
  if (!techLine) return '';
  return techLine.replace(/^技术面[：:]/, '').trim();
}
