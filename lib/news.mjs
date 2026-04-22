/**
 * 新闻存储与每日报告模块
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { NEWS_FILE, DAILY_FILE } from './config.mjs';
import { getAiProviders } from './config.mjs';
import { sleep, log, logErr } from './utils.mjs';

// ── 新闻存储 ───────────────────────────────────────────────────────

export function loadNews() {
  if (!existsSync(NEWS_FILE)) return [];
  try { return JSON.parse(readFileSync(NEWS_FILE, 'utf-8')).items || []; } catch { return []; }
}

<<<<<<< HEAD
function normalizeDateInput(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function normalizeTimeInput(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d{2}:\d{2}$/.test(text)) return `${text}:00`;
  return /^\d{2}:\d{2}:\d{2}$/.test(text) ? text : '';
}

function toShanghaiEpochMs(dateStr, timeStr) {
  const normalizedDate = normalizeDateInput(dateStr);
  const normalizedTime = normalizeTimeInput(timeStr || '00:00:00');
  if (!normalizedDate || !normalizedTime) return null;
  const parsed = Date.parse(`${normalizedDate}T${normalizedTime}+08:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

function itemCreatedAt(item) {
  const numeric = Number(item?.createdAt || 0);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function queryNewsItems(options = {}) {
  const {
    limit = 20,
    before = 0,
    includeSkipped = false,
    includeDeleted = false,
    importantOnly = false,
    date = '',
    startTime = '',
    endTime = '',
  } = options;

  const allItems = loadNews();
  let filtered = includeSkipped ? allItems : allItems.filter(item => !item.skipped);
  if (!includeDeleted) filtered = filtered.filter(item => !item.deleted);
  if (importantOnly) filtered = filtered.filter(item => !!item.important);

  const normalizedDate = normalizeDateInput(date);
  const normalizedStartTime = normalizeTimeInput(startTime);
  const normalizedEndTime = normalizeTimeInput(endTime);

  if (normalizedDate) {
    const startMs = toShanghaiEpochMs(normalizedDate, normalizedStartTime || '00:00:00');
    const endMs = toShanghaiEpochMs(normalizedDate, normalizedEndTime || '23:59:59');
    filtered = filtered.filter(item => {
      const createdAt = itemCreatedAt(item);
      if (createdAt === null) return false;
      if (startMs !== null && createdAt < startMs) return false;
      if (endMs !== null && createdAt > endMs) return false;
      return getDateStr(createdAt) === normalizedDate;
    });
  }

  const numericBefore = Number(before || 0);
  const pool = numericBefore > 0
    ? filtered.filter(item => Number(item?.createdAt || 0) < numericBefore)
    : filtered;
  const safeLimit = Math.min(Math.max(parseInt(String(limit || '20'), 10) || 20, 1), 200);
  const page = pool.slice(0, safeLimit);

  return {
    items: page,
    total: filtered.length,
    hasMore: pool.length > safeLimit,
  };
}

=======
>>>>>>> 48d53d6a6935e3c7147355d946d872b05a94a93a
export function appendNews(entry) {
  const items = loadNews();
  items.unshift(entry);
  writeFileSync(NEWS_FILE, JSON.stringify({ items }, null, 2));
}

export function updateNewsItem(id, updates) {
  const items = loadNews();
  const idx = items.findIndex(n => n.id === id);
  if (idx === -1) return false;
  items[idx] = { ...items[idx], ...updates };
  writeFileSync(NEWS_FILE, JSON.stringify({ items }, null, 2));
  return true;
}

/**
 * 按金十原始 flashId 更新新闻内容，并保留修改历史
 */
export function updateNewsByFlashId(flashId, newContent, extraUpdates) {
  const items = loadNews();
  const idx = items.findIndex(n => n.flashId === flashId);
  if (idx === -1) return false;
  const old = items[idx];
  const historyEntry = {
    at: Date.now(),
    oldContent: old.content || '',
    newContent: newContent || '',
  };
  const editHistory = Array.isArray(old.editHistory) ? [...old.editHistory, historyEntry] : [historyEntry];
  items[idx] = { ...old, content: newContent || old.content, editHistory, ...extraUpdates };
  writeFileSync(NEWS_FILE, JSON.stringify({ items }, null, 2));
  return true;
}

/**
 * 按金十原始 flashId 标记删除
 */
export function markDeletedByFlashId(flashId) {
  const items = loadNews();
  const idx = items.findIndex(n => n.flashId === flashId);
  if (idx === -1) return false;
  items[idx] = { ...items[idx], deleted: true, deletedAt: Date.now() };
  writeFileSync(NEWS_FILE, JSON.stringify({ items }, null, 2));
  return true;
}

// ── 每日分析 ───────────────────────────────────────────────────────

export function loadDailyAnalyses() {
  if (!existsSync(DAILY_FILE)) return {};
  try { return JSON.parse(readFileSync(DAILY_FILE, 'utf-8')); } catch { return {}; }
}

export function saveDailyAnalysis(date, entry) {
  const all = loadDailyAnalyses();
  all[date] = entry;
  writeFileSync(DAILY_FILE, JSON.stringify(all, null, 2));
}

export function getDateStr(epochMs) {
  return new Date(epochMs || Date.now()).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

export function getTodayDateStr() { return getDateStr(Date.now()); }

export function getDayNewsItems(dateStr) {
  return loadNews().filter(item => getDateStr(item.createdAt) === dateStr);
}

// AI 提供商调用（内部复用，避免循环依赖）
async function callProviderForReport(provider, prompt, timeoutMs) {
  // 动态导入避免循环依赖
  const { default: OpenAI } = await import('openai');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
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

export async function generateDailyReport(dateStr) {
  const items = getDayNewsItems(dateStr);
  if (items.length === 0) {
    log(`📅 每日分析（${dateStr}）：当日无新闻数据`);
    return null;
  }
  const AI_PROVIDERS = getAiProviders();
  if (AI_PROVIDERS.length === 0) {
    logErr('每日分析：未配置任何 AI 提供商');
    return null;
  }

  // Estimate token count: ~2 chars per token for mixed Chinese/English text.
  // Target a maximum of 120,000 tokens for the news list portion to stay safely
  // within the 131,072 token model limit (leaving room for the prompt template).
  const MAX_NEWS_CHARS = 240_000;
  // Sort oldest-first so that within each priority tier we drop the oldest entries.
  const sortedItems = items.slice().reverse();

  function itemLine(item) {
    const t = item.time || new Date(item.createdAt).toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit',
    });
    return `[${t}] ${item.title ? item.title + ' ' : ''}${item.content}`;
  }

  // Drop non-important items (oldest first) before touching important ones.
  const dropQueue = [
    ...sortedItems.filter(item => !item.important),
    ...sortedItems.filter(item => item.important),
  ];
  const lineLengths = new Map(sortedItems.map(item => [item, itemLine(item).length + 1]));
  const droppedSet = new Set();
  let totalChars = sortedItems.reduce((sum, item) => sum + lineLengths.get(item), 0);
  for (const item of dropQueue) {
    if (totalChars <= MAX_NEWS_CHARS) break;
    totalChars -= lineLengths.get(item);
    droppedSet.add(item);
  }
  const droppedCount = droppedSet.size;
  const includedItems = sortedItems.filter(item => !droppedSet.has(item));
  const newsList = includedItems.map((item, i) => `${i + 1}. ${itemLine(item)}`).join('\n');
  const includedCount = includedItems.length;
  const truncationNote = droppedCount > 0
    ? `\n（注：当日共 ${items.length} 条新闻，因长度限制已省略 ${droppedCount} 条（优先省略非重要新闻），以下为 ${includedCount} 条）`
    : '';

  const prompt = `你是一名专业的金融市场分析师。以下是${dateStr}全天的重要财经快讯（共 ${includedCount} 条），请对这些新闻进行全面的每日综合分析报告。${truncationNote}

新闻列表：
${newsList}

请严格按以下格式输出（每项独立一行，字段名后接"："）：
市场概述：3-5句话总结今日整体市场情况与重大事件
主要主题：今日最重要的3-5个市场主题（分号分隔）
利好资产：受利好影响的主要交易标的及简要原因（逗号分隔）
利空资产：受利空影响的主要交易标的及简要原因（逗号分隔）
核心驱动：一句话点名今日最核心的市场定价因子
明日关注：明日需重点关注的事件、数据或价格关口（分号分隔）
风险提示：今日暴露的1-2条主要市场风险`;

  const timeouts = [60_000, 90_000];
  for (const timeoutMs of timeouts) {
    for (const provider of AI_PROVIDERS) {
      try {
        const res = await callProviderForReport(provider, prompt, timeoutMs);
        if (!res?.text) throw new Error('empty response');
        log(`📅 每日分析 (${res.source}): ${dateStr} 生成成功，共 ${items.length} 条新闻`);
        return { text: res.text, source: res.source, generatedAt: Date.now(), newsCount: items.length };
      } catch (e) {
        logErr(`每日分析 (${provider.type}): ${e.message}`);
        await sleep(500);
      }
    }
  }
  logErr(`每日分析 (${dateStr}): 全部提供商均失败`);
  return null;
}
