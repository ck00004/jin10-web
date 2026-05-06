/**
 * 新闻存储与每日报告模块
 */
import { readFileSync, existsSync, renameSync } from 'fs';
import { writeFileSync } from 'fs';
import Database from 'better-sqlite3';
import { DAILY_FILE, DB_FILE, NEWS_FILE } from './config.mjs';
import { getDailyAnalysisAiProviders } from './config.mjs';
import { getDayClsTelegraphs } from './cls-telegraph.mjs';
import { sleep, log, logErr } from './utils.mjs';

// ── 数据库初始化与迁移 ──────────────────────────────────────────

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS news (
    id TEXT PRIMARY KEY,
    flashId TEXT,
    createdAt INTEGER,
    important INTEGER,
    skipped INTEGER,
    deleted INTEGER,
    raw_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_news_createdAt ON news(createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_news_flashId ON news(flashId);
`);

if (existsSync(NEWS_FILE)) {
  try {
    const backupFile = NEWS_FILE + '.bak';
    log(`检测到旧版 JSON 数据文件，开始迁移到 SQLite: ${NEWS_FILE}`);
    const data = JSON.parse(readFileSync(NEWS_FILE, 'utf-8'));
    const items = data.items || [];
    
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO news (id, flashId, createdAt, important, skipped, deleted, raw_json)
      VALUES (@id, @flashId, @createdAt, @important, @skipped, @deleted, @raw_json)
    `);
    
    const insertMany = db.transaction((newsItems) => {
      for (const entry of newsItems) {
        insertStmt.run({
          id: entry.id || String(Date.now() + Math.random()),
          flashId: entry.flashId || '',
          createdAt: Number(entry.createdAt || 0),
          important: entry.important ? 1 : 0,
          skipped: entry.skipped ? 1 : 0,
          deleted: entry.deleted ? 1 : 0,
          raw_json: JSON.stringify(entry)
        });
      }
    });
    
    insertMany(items);
    renameSync(NEWS_FILE, backupFile);
    log(`迁移完成！旧文件已备份为: ${backupFile}`);
  } catch (e) {
    logErr(`数据自动迁移失败: ${e.message}`);
  }
}

// ── 辅助函数 ───────────────────────────────────────────────────────


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

// ── 新闻存储 ───────────────────────────────────────────────────────

export function loadNews() {
  const rows = db.prepare('SELECT raw_json FROM news ORDER BY createdAt DESC').all();
  return rows.map(r => JSON.parse(r.raw_json));
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

  let whereClauses = [];
  let params = {};

  if (!includeSkipped) whereClauses.push('skipped = 0');
  if (!includeDeleted) whereClauses.push('deleted = 0');
  if (importantOnly) whereClauses.push('important = 1');

  const normalizedDate = normalizeDateInput(date);
  const normalizedStartTime = normalizeTimeInput(startTime);
  const normalizedEndTime = normalizeTimeInput(endTime);

  if (normalizedDate) {
    const startMs = toShanghaiEpochMs(normalizedDate, normalizedStartTime || '00:00:00');
    const endMs = toShanghaiEpochMs(normalizedDate, normalizedEndTime || '23:59:59');
    if (startMs !== null) {
      whereClauses.push('createdAt >= @startMs');
      params.startMs = startMs;
    }
    if (endMs !== null) {
      whereClauses.push('createdAt <= @endMs');
      params.endMs = endMs;
    }
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const totalRow = db.prepare(`SELECT COUNT(*) as count FROM news ${whereSql}`).get(params);
  const total = totalRow.count;

  if (Number(before || 0) > 0) {
    whereClauses.push('createdAt < @before');
    params.before = Number(before);
  }

  const poolWhereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const poolCountRow = db.prepare(`SELECT COUNT(*) as count FROM news ${poolWhereSql}`).get(params);
  
  const safeLimit = Math.min(Math.max(parseInt(String(limit || '20'), 10) || 20, 1), 200);

  const rows = db.prepare(`
    SELECT raw_json FROM news
    ${poolWhereSql}
    ORDER BY createdAt DESC
    LIMIT @limit
  `).all({ ...params, limit: safeLimit });

  let page = rows.map(r => JSON.parse(r.raw_json));
  
  if (normalizedDate) {
    page = page.filter(item => getDateStr(item.createdAt) === normalizedDate);
  }

  return {
    items: page,
    total,
    hasMore: poolCountRow.count > safeLimit,
  };
}

export function appendNews(entry) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO news (id, flashId, createdAt, important, skipped, deleted, raw_json)
    VALUES (@id, @flashId, @createdAt, @important, @skipped, @deleted, @raw_json)
  `).run({
    id: entry.id,
    flashId: entry.flashId,
    createdAt: Number(entry.createdAt || 0),
    important: entry.important ? 1 : 0,
    skipped: entry.skipped ? 1 : 0,
    deleted: entry.deleted ? 1 : 0,
    raw_json: JSON.stringify(entry)
  });
  return result.changes > 0;
}

export function updateNewsItem(id, updates) {
  const row = db.prepare('SELECT raw_json FROM news WHERE id = ?').get(id);
  if (!row) return false;
  const oldItem = JSON.parse(row.raw_json);
  const nextItem = { ...oldItem, ...updates };

  db.prepare(`
    UPDATE news SET
      important = @important,
      skipped = @skipped,
      deleted = @deleted,
      raw_json = @raw_json
    WHERE id = @id
  `).run({
    id,
    important: nextItem.important ? 1 : 0,
    skipped: nextItem.skipped ? 1 : 0,
    deleted: nextItem.deleted ? 1 : 0,
    raw_json: JSON.stringify(nextItem)
  });
  return true;
}

export function updateNewsByFlashId(flashId, newContent, extraUpdates) {
  const row = db.prepare('SELECT raw_json FROM news WHERE flashId = ? ORDER BY createdAt DESC LIMIT 1').get(flashId);
  if (!row) return false;
  const old = JSON.parse(row.raw_json);
  const historyEntry = {
    at: Date.now(),
    oldContent: old.content || '',
    newContent: newContent || '',
  };
  const editHistory = Array.isArray(old.editHistory) ? [...old.editHistory, historyEntry] : [historyEntry];
  const nextItem = { ...old, content: newContent || old.content, editHistory, ...(extraUpdates || {}) };
  
  db.prepare(`
    UPDATE news SET
      important = @important,
      skipped = @skipped,
      deleted = @deleted,
      raw_json = @raw_json
    WHERE flashId = @flashId
  `).run({
    flashId,
    important: nextItem.important ? 1 : 0,
    skipped: nextItem.skipped ? 1 : 0,
    deleted: nextItem.deleted ? 1 : 0,
    raw_json: JSON.stringify(nextItem)
  });
  return true;
}

export function markDeletedByFlashId(flashId) {
  const row = db.prepare('SELECT raw_json FROM news WHERE flashId = ? ORDER BY createdAt DESC LIMIT 1').get(flashId);
  if (!row) return false;
  const old = JSON.parse(row.raw_json);
  const nextItem = { ...old, deleted: true, deletedAt: Date.now() };
  
  db.prepare(`
    UPDATE news SET
      deleted = 1,
      raw_json = @raw_json
    WHERE flashId = @flashId
  `).run({
    flashId,
    raw_json: JSON.stringify(nextItem)
  });
  return true;
}

// ── 每日分析 ───────────────────────────────────────────────────────

function normalizeDailySource(source) {
  return String(source || '').trim().toLowerCase() === 'cls' ? 'cls' : 'news';
}

function getDailySourceLabel(source) {
  return normalizeDailySource(source) === 'cls' ? 'CLS 电报' : '金十新闻';
}

function getDailyItemLabel(source) {
  return normalizeDailySource(source) === 'cls' ? '电报' : '新闻';
}

function normalizeDailyStore(raw) {
  const normalized = {};
  if (!raw || typeof raw !== 'object') return normalized;
  for (const [date, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    if (typeof value.text === 'string') {
      normalized[date] = { news: value };
      continue;
    }
    const scoped = {};
    if (value.news && typeof value.news === 'object' && typeof value.news.text === 'string') scoped.news = value.news;
    if (value.cls && typeof value.cls === 'object' && typeof value.cls.text === 'string') scoped.cls = value.cls;
    if (Object.keys(scoped).length > 0) normalized[date] = scoped;
  }
  return normalized;
}

function loadDailyAnalysisStore() {
  if (!existsSync(DAILY_FILE)) return {};
  try {
    const raw = JSON.parse(readFileSync(DAILY_FILE, 'utf-8'));
    return normalizeDailyStore(raw);
  } catch {
    return {};
  }
}

export function loadDailyAnalyses(source = 'news') {
  const normalizedSource = normalizeDailySource(source);
  const store = loadDailyAnalysisStore();
  const entries = {};
  for (const [date, scoped] of Object.entries(store)) {
    if (scoped[normalizedSource]) {
      entries[date] = scoped[normalizedSource];
    }
  }
  return entries;
}

export function saveDailyAnalysis(date, entry, source = 'news') {
  const normalizedSource = normalizeDailySource(source);
  const store = loadDailyAnalysisStore();
  const scoped = store[date] && typeof store[date] === 'object' ? store[date] : {};
  scoped[normalizedSource] = entry;
  store[date] = scoped;
  writeFileSync(DAILY_FILE, JSON.stringify(store, null, 2));
}

export function getDateStr(epochMs) {
  return new Date(epochMs || Date.now()).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

export function getTodayDateStr() { return getDateStr(Date.now()); }

export function getDayNewsItems(dateStr) {
  const startMs = toShanghaiEpochMs(dateStr, '00:00:00');
  const endMs = toShanghaiEpochMs(dateStr, '23:59:59');
  if (startMs === null || endMs === null) return [];
  const rows = db.prepare(`SELECT raw_json FROM news WHERE createdAt >= ? AND createdAt <= ? ORDER BY createdAt DESC`).all(startMs, endMs);
  return rows.map(r => JSON.parse(r.raw_json));
}

function getDailySourceItems(dateStr, source) {
  const normalizedSource = normalizeDailySource(source);
  if (normalizedSource === 'cls') return getDayClsTelegraphs(dateStr);
  return getDayNewsItems(dateStr);
}

function buildDailyItemLine(item, source) {
  const normalizedSource = normalizeDailySource(source);
  if (normalizedSource === 'cls') {
    const t = item.ctime ? new Date(Number(item.ctime) * 1000).toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit',
    }) : '00:00';
    const level = item.level ? `[${item.level}] ` : '';
    const title = item.title ? `${item.title} ` : '';
    return `[${t}] ${level}${title}${item.content || ''}`.trim();
  }
  const t = item.time || new Date(item.createdAt).toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit',
  });
  return `[${t}] ${item.title ? item.title + ' ' : ''}${item.content}`;
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

export async function generateDailyReport(dateStr, source = 'news') {
  const normalizedSource = normalizeDailySource(source);
  const sourceLabel = getDailySourceLabel(normalizedSource);
  const itemLabel = getDailyItemLabel(normalizedSource);
  const items = getDailySourceItems(dateStr, normalizedSource);
  if (items.length === 0) {
    log(`📅 每日分析（${sourceLabel} ${dateStr}）：当日无${itemLabel}数据`);
    return null;
  }
  const AI_PROVIDERS = getDailyAnalysisAiProviders();
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

  // Drop non-important items (oldest first) before touching important ones.
  const dropQueue = [
    ...sortedItems.filter(item => !item.important),
    ...sortedItems.filter(item => item.important),
  ];
  const lineLengths = new Map(sortedItems.map(item => [item, buildDailyItemLine(item, normalizedSource).length + 1]));
  const droppedSet = new Set();
  let totalChars = sortedItems.reduce((sum, item) => sum + lineLengths.get(item), 0);
  for (const item of dropQueue) {
    if (totalChars <= MAX_NEWS_CHARS) break;
    totalChars -= lineLengths.get(item);
    droppedSet.add(item);
  }
  const droppedCount = droppedSet.size;
  const includedItems = sortedItems.filter(item => !droppedSet.has(item));
  const newsList = includedItems.map((item, i) => `${i + 1}. ${buildDailyItemLine(item, normalizedSource)}`).join('\n');
  const includedCount = includedItems.length;
  const truncationNote = droppedCount > 0
    ? `\n（注：当日共 ${items.length} 条${itemLabel}，因长度限制已省略 ${droppedCount} 条（优先省略非重要${itemLabel}），以下为 ${includedCount} 条）`
    : '';

  const prompt = `你是一名专业的金融市场分析师。以下是${dateStr}全天的${sourceLabel}资讯（共 ${includedCount} 条），请对这些${itemLabel}进行全面的每日综合分析报告。${truncationNote}

${sourceLabel}列表：
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
        log(`📅 每日分析 (${sourceLabel}/${res.source}): ${dateStr} 生成成功，共 ${items.length} 条${itemLabel}`);
        return {
          text: res.text,
          source: res.source,
          generatedAt: Date.now(),
          newsCount: items.length,
          itemCount: items.length,
          itemLabel,
          dataSource: normalizedSource,
          dataSourceLabel: sourceLabel,
        };
      } catch (e) {
        logErr(`每日分析 (${provider.type}): ${e.message}`);
        await sleep(500);
      }
    }
  }
  logErr(`每日分析 (${sourceLabel} ${dateStr}): 全部提供商均失败`);
  return null;
}
