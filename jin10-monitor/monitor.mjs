#!/usr/bin/env node
/**
 * 金十红色新闻监控 - 彻底解决重复推送问题
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname, extname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCK_FILE = join(__dirname, '.lock');
const DEDUP_FILE = join(__dirname, 'dedup.json');
const STATE_FILE = join(__dirname, 'state.json');
const NEWS_FILE  = join(__dirname, 'news.json');
const DAILY_FILE = join(__dirname, 'daily_analysis.json');

// 配置
const JIN10_URL = 'https://www.jin10.com/';
const POLL_MS = 60_000;
const DEDUP_HOURS = 72;

// 动态配置（支持 Web 界面热更新，修改后无需重启即可生效；端口变更需重启）
function loadConfigFile() {
  if (!existsSync(join(__dirname, 'config.json'))) return {};
  try { return JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf-8')); } catch (e) {
    console.error(`[config] config.json parse error: ${e.message}`);
    return {};
  }
}
function saveConfigFile(newCfg) {
  writeFileSync(join(__dirname, 'config.json'), JSON.stringify(newCfg, null, 2));
}
let cfg = loadConfigFile();
const HTTP_PORT = cfg.WEB_PORT || 3000;
const HTTP_HOST = cfg.WEB_HOST || '0.0.0.0';

// AI 提供商配置（支持 minimax / openai / gemini / claude）
// 新格式：AI_PROVIDERS 数组，每项支持 type/apiKey/model/baseUrl；旧格式：MINIMAX_API_KEY（向后兼容）
function loadAiProviders(config) {
  const c = config || {};
  const providers = Array.isArray(c.AI_PROVIDERS)
    ? c.AI_PROVIDERS.filter(p => p && p.type && p.apiKey)
    : [];
  // 向后兼容：MINIMAX_API_KEY 仍可用，自动置于列表首位
  if (c.MINIMAX_API_KEY && !providers.some(p => p.type === 'minimax')) {
    providers.unshift({ type: 'minimax', apiKey: c.MINIMAX_API_KEY });
  }
  return providers;
}
let AI_PROVIDERS = loadAiProviders(cfg);

// 热重载配置（Web 界面修改后立即生效，端口变更需重启）
function reloadConfig() {
  cfg = loadConfigFile();
  AI_PROVIDERS = loadAiProviders(cfg);
  log(`🔄 配置已重新加载，${AI_PROVIDERS.length} 个 AI 提供商`);
  return cfg;
}

// 工具函数
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');

function log(m) { console.log(`[${ts()}] ${m}`); }
function logErr(m) { console.error(`[${ts()}] ERROR: ${m}`); appendFileSync(join(__dirname, 'errors.log'), `[${ts()}] ${m}\n`); }

// 确保只有一个实例
function acquireLock() {
  if (existsSync(LOCK_FILE)) {
    const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); process.exit(0); } catch {}
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid));
  process.on('exit', () => { try { unlinkSync(LOCK_FILE); } catch {} });
}

// 去重
function loadDedup() {
  if (!existsSync(DEDUP_FILE)) return {};
  try { return JSON.parse(readFileSync(DEDUP_FILE, 'utf-8')); } catch { return {}; }
}
function loadState() {
  if (!existsSync(STATE_FILE)) {
    return {
      ok: 0,
      fail: 0,
      consecutiveFail: 0,
      lastSuccessAt: null,
      lastPushAt: null,
      lastErrorAt: null,
      lastError: '',
      aiFailConsecutive: 0,
      aiDisabledUntil: null,
      pendingAnalyses: {},
    };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {
      ok: 0,
      fail: 0,
      consecutiveFail: 0,
      lastSuccessAt: null,
      lastPushAt: null,
      lastErrorAt: null,
      lastError: 'state.json parse error',
      aiFailConsecutive: 0,
      aiDisabledUntil: null,
      pendingAnalyses: {},
    };
  }
}

function saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

function saveDedup(d) { writeFileSync(DEDUP_FILE, JSON.stringify(d, null, 2)); }
function cleanDedup(d) {
  const cut = Date.now() - DEDUP_HOURS * 3600_000;
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v.ts > cut));
}
function getKey(item) { return createHash('sha1').update(item.time + '|' + item.content.substring(0,100)).digest('hex'); }

// 新闻存储（供 Web 页面展示）
function loadNews() {
  if (!existsSync(NEWS_FILE)) return [];
  try { return JSON.parse(readFileSync(NEWS_FILE, 'utf-8')).items || []; } catch { return []; }
}
function appendNews(entry) {
  const items = loadNews();
  items.unshift(entry);
  writeFileSync(NEWS_FILE, JSON.stringify({ items }, null, 2));
}

function updateNewsItem(id, updates) {
  const items = loadNews();
  const idx = items.findIndex(n => n.id === id);
  if (idx === -1) return false;
  items[idx] = { ...items[idx], ...updates };
  writeFileSync(NEWS_FILE, JSON.stringify({ items }, null, 2));
  return true;
}

// 广告过滤
const AD_PATTERNS = /(?:\d+折.*VIP|VIP[·\s]*\d*折|VIP.*折|立省\d+|立即抢购|限时|优惠|折扣|新春福利|解锁.*利器|领取.*礼|猜金价|竞猜.*赢|资金监测器)/;
function isAd(item) {
  const text = (item.title || '') + ' ' + (item.content || '');
  return AD_PATTERNS.test(text);
}

// 过滤「点击查看」类占位内容（通常是引流/截断，信息不完整）
const CLICK_TO_VIEW_PATTERNS = /(?:点击查看|点击查看详情|点击看详情|点击查看全文|查看更多|展开全文)/;
function isClickToView(item) {
  const text = (item.title || '') + ' ' + (item.content || '');
  return CLICK_TO_VIEW_PATTERNS.test(text);
}

// 过滤「周度/日历/预告」类信息（信息密度高但对交易决策增量很低，且经常触发模板化 AI 分析）
const CALENDAR_PREVIEW_PATTERNS = /(?:下周重要事件|本周重要事件|重要事件与数据预告|数据预告|日程预告|财经日历|一周前瞻|周度前瞻|本周大事|下周大事|数据与事件预告|宏观日历|期货·.*专题|局势专题|专题\b|VIP\b|金十数据整理|市场罗盘|图集|定价权解析|深度解析|科普|不是一条普通水道|杠杆点)/;
function isCalendarPreview(item) {
  const title = String(item.title || '').trim();
  const content = String(item.content || '').trim();
  const text = `${title} ${content}`;

  if (CALENDAR_PREVIEW_PATTERNS.test(text)) return true;

  // Heuristic: 长编号列表（1. 2. 3. ...）通常是“周度事件表”
  const head = content.slice(0, 600);
  const numberedLines = (head.match(/\n\s*\d+\./g) || []).length;
  if (numberedLines >= 4) return true;

  // Heuristic: 引流式“点击了解/点击查看”专题/合集，信息密度低
  if (/(?:点击了解|点击查看|点击详情|阅读全文|查看更多)/.test(text) && /(?:专题|合集|盘点|解读|怎么看|后市怎么看)/.test(text)) {
    return true;
  }

  // Heuristic: VIP 解读/提问式文案（“下一波会是什么？”这类），通常信息不完整或偏引导
  if (/(?:^|\s)VIP/.test(text) && /[？?]/.test(text)) {
    return true;
  }

  return false;
}

function extractTickersFromAnalysis(analysisText) {
  const m = String(analysisText || '').match(/^标的：\s*(.+)$/m);
  if (!m) return [];
  return m[1]
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function mapToTradingViewSymbol(ticker) {
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

  // HK stocks like "(01347.HK)" or "01347.HK" → HKEX-1347
  const hk = raw.match(/\(?\s*(\d{4,5})\.HK\s*\)?/i);
  if (hk) {
    const num = String(parseInt(hk[1], 10));
    return `HKEX:${num}`;
  }

  // If it looks like a US stock ticker, try it as-is.
  if (/^[A-Z]{1,5}$/.test(t)) return t;

  return null;
}

function tradingViewTechnicalsUrl(tvSymbol) {
  // TradingView uses different URL shapes for some symbols.
  if (tvSymbol === 'TVC:DXY') return 'https://www.tradingview.com/symbols/TVC-DXY/technicals/';
  if (tvSymbol === 'NASDAQ:NDX') return 'https://www.tradingview.com/symbols/NASDAQ-NDX/technicals/';
  if (tvSymbol === 'SPX') return 'https://www.tradingview.com/symbols/SPX/technicals/';
  if (tvSymbol === 'SPY') return 'https://www.tradingview.com/symbols/SPY/technicals/';
  if (tvSymbol === 'QQQ') return 'https://www.tradingview.com/symbols/QQQ/technicals/';

  // Exchange-prefixed symbols.
  // Example: HKEX:1347 → /symbols/HKEX-1347/technicals/
  const ex = String(tvSymbol || '').match(/^([A-Z]+):(\d+)$/);
  if (ex) return `https://www.tradingview.com/symbols/${ex[1]}-${ex[2]}/technicals/`;

  // default: /symbols/<SYMBOL>/technicals/
  return `https://www.tradingview.com/symbols/${encodeURIComponent(tvSymbol)}/technicals/`;
}

function parseTradingViewRows(lines) {
  const pat = /^(?<name>.*?)(?<value>[\d,\.\-−]+)(?<action>Strong sell|Strong buy|Sell|Buy|Neutral)$/;
  const out = {};
  for (const raw of lines || []) {
    const line = String(raw || '').replace(/\s+/g, ' ').trim();
    const m = line.replaceAll('−', '-').match(pat);
    if (!m) continue;
    const { name, value, action } = m.groups;
    out[name.trim()] = { value: value.replaceAll(',', ''), action };
  }
  return out;
}

async function fetchTradingViewTechnicals(tvSymbol) {
  const url = tradingViewTechnicalsUrl(tvSymbol);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(2500);
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('table tr')).map((r) => r.textContent));
  await browser.close();
  return { url, data: parseTradingViewRows(rows) };
}

function explainRsi(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '';
  if (v < 30) return '接近/进入超卖区（弱势，可能跌过头）';
  if (v < 40) return '偏弱（但未到超卖）';
  if (v <= 60) return '中性区间';
  if (v <= 70) return '偏强';
  return '接近/进入超买区（强势，可能涨过头）';
}

function explainTrend(ema20, ema50, sma200) {
  const a20 = ema20?.action;
  const a50 = ema50?.action;
  const a200 = sma200?.action;
  const actions = [a20, a50, a200].filter(Boolean);
  if (actions.length === 0) return '';

  const sell = actions.filter((x) => x === 'Sell' || x === 'Strong sell').length;
  const buy = actions.filter((x) => x === 'Buy' || x === 'Strong buy').length;

  if (sell >= 2) return '趋势偏空（多数均线信号为 Sell）';
  if (buy >= 2) return '趋势偏多（多数均线信号为 Buy）';
  return '趋势分歧（均线信号不一致）';
}

function fmtTechLine({ label, rsi, ema20, ema50, sma200 }) {
  if (!rsi && !ema20 && !ema50 && !sma200) return `${label}：缺数据`;

  const rsiVal = rsi ? Number(rsi.value).toFixed(1) : null;
  const rsiTxt = rsi ? `RSI14 ${rsiVal}（${explainRsi(rsi.value)}）` : 'RSI14 缺数据';
  const trendTxt = explainTrend(ema20, ema50, sma200) || '趋势缺数据';

  const maTxtParts = [];
  if (ema20) maTxtParts.push(`EMA20=${ema20.action}`);
  if (ema50) maTxtParts.push(`EMA50=${ema50.action}`);
  if (sma200) maTxtParts.push(`SMA200=${sma200.action}`);
  const maTxt = maTxtParts.length ? `均线：${maTxtParts.join(' / ')}` : '均线：缺数据';

  return `${label}：${trendTxt}；${rsiTxt}；${maTxt}`;
}

async function buildTechnicalSummary(analysisText) {
  const tickers = extractTickersFromAnalysis(analysisText)
    .map((t) => ({ raw: t, tv: mapToTradingViewSymbol(t) }))
    .filter((x) => x.tv);

  if (tickers.length === 0) return '';

  const targets = tickers.slice(0, 2);
  const lines = [];

  for (const t of targets) {
    try {
      const { data } = await fetchTradingViewTechnicals(t.tv);
      const rsi = data['Relative Strength Index (14)'];
      const ema20 = data['Exponential Moving Average (20)'];
      const ema50 = data['Exponential Moving Average (50)'];
      const sma200 = data['Simple Moving Average (200)'];
      lines.push(fmtTechLine({ label: t.raw, rsi, ema20, ema50, sma200 }));
    } catch {
      lines.push(`${t.raw}=缺数据`);
    }
  }

  return lines.join('\n');
}

// 各 AI 提供商调用函数

// 构建 API 端点：优先使用 baseUrl，否则使用默认地址
function buildEndpoint(baseUrl, defaultBase, path) {
  const base = baseUrl ? baseUrl.replace(/\/+$/, '') : defaultBase;
  return `${base}${path}`;
}

async function callMinimax(apiKey, model, prompt, timeoutMs, baseUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const endpoint = buildEndpoint(baseUrl, 'https://api.minimaxi.com/anthropic/v1', '/messages');
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model || 'MiniMax-M2.5', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
    const d = await r.json();
    if (d.content && Array.isArray(d.content)) {
      const blk = d.content.find(b => b.type === 'text' && b.text);
      if (blk) return { text: blk.text.trim(), source: `MiniMax/${model || 'MiniMax-M2.5'}` };
    }
    throw new Error(d.error?.message || 'empty response');
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenai(apiKey, model, prompt, timeoutMs, baseUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const endpoint = buildEndpoint(baseUrl, 'https://api.openai.com/v1', '/chat/completions');
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model || 'gpt-4o', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
    const d = await r.json();
    const txt = d.choices?.[0]?.message?.content?.trim();
    if (txt) return { text: txt, source: `OpenAI/${model || 'gpt-4o'}` };
    throw new Error(d.error?.message || 'empty response');
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(apiKey, model, prompt, timeoutMs, baseUrl) {
  const m = model || 'gemini-1.5-pro';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const base = buildEndpoint(baseUrl, 'https://generativelanguage.googleapis.com/v1beta', '');
  try {
    const r = await fetch(
      `${base}/models/${encodeURIComponent(m)}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: ctrl.signal,
      }
    );
    const d = await r.json();
    const txt = d.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (txt) return { text: txt, source: `Gemini/${m}` };
    throw new Error(d.error?.message || 'empty response');
  } finally {
    clearTimeout(timer);
  }
}

async function callClaude(apiKey, model, prompt, timeoutMs, baseUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const endpoint = buildEndpoint(baseUrl, 'https://api.anthropic.com/v1', '/messages');
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model || 'claude-3-5-sonnet-20241022', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
    const d = await r.json();
    if (d.content && Array.isArray(d.content)) {
      const blk = d.content.find(b => b.type === 'text' && b.text);
      if (blk) return { text: blk.text.trim(), source: `Claude/${model || 'claude-3-5-sonnet-20241022'}` };
    }
    throw new Error(d.error?.message || 'empty response');
  } finally {
    clearTimeout(timer);
  }
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

// AI 分析 - 依次尝试所有配置的提供商，保留格式校验和熔断机制
async function analyze(item, state) {
  const now = Date.now();
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

  // 两轮重试：第一轮 20s 超时，第二轮 30s 超时；每轮依次尝试所有提供商
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

  // 熔断：全部提供商连续失败 5 次后暂停 5 分钟
  const N = 5;
  const COOL_MS = 5 * 60_000;
  if (state.aiFailConsecutive >= N) {
    state.aiDisabledUntil = Date.now() + COOL_MS;
    state.aiFailConsecutive = 0;
  }
  saveState(state);

  return null;
}

// 每日新闻综合分析
function loadDailyAnalyses() {
  if (!existsSync(DAILY_FILE)) return {};
  try { return JSON.parse(readFileSync(DAILY_FILE, 'utf-8')); } catch { return {}; }
}

function saveDailyAnalysis(date, entry) {
  const all = loadDailyAnalyses();
  all[date] = entry;
  writeFileSync(DAILY_FILE, JSON.stringify(all, null, 2));
}

function getDateStr(epochMs) {
  return new Date(epochMs || Date.now()).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function getTodayDateStr() { return getDateStr(Date.now()); }

function getDayNewsItems(dateStr) {
  return loadNews().filter(item => getDateStr(item.createdAt) === dateStr);
}

async function generateDailyReport(dateStr) {
  const items = getDayNewsItems(dateStr);
  if (items.length === 0) {
    log(`📅 每日分析（${dateStr}）：当日无新闻数据`);
    return null;
  }
  if (AI_PROVIDERS.length === 0) {
    logErr('每日分析：未配置任何 AI 提供商');
    return null;
  }

  const newsList = items.slice().reverse()
    .map((item, i) => {
      const t = item.time || new Date(item.createdAt).toLocaleTimeString('zh-CN', {
        timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit',
      });
      return `${i + 1}. [${t}] ${item.title ? item.title + ' ' : ''}${item.content}`;
    })
    .join('\n');

  const prompt = `你是一名专业的金融市场分析师。以下是${dateStr}全天的重要财经快讯（共 ${items.length} 条），请对这些新闻进行全面的每日综合分析报告。

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
        const res = await callProvider(provider, prompt, timeoutMs);
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

// 解析 HTTP 请求体（JSON）
function readRequestBody(req, res) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Request body too large' }));
        }
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

// 抓取逻辑
const SCRAPE_EVAL = () => {
  const out = [];
  document.querySelectorAll('.jin-flash-item-container').forEach(el => {
    const fi = el.querySelector('.jin-flash-item');
    if (!fi || !fi.classList.contains('is-important')) return;
    const te = el.querySelector('.item-time');
    const ti = el.querySelector('.right-common-title');
    const co = el.querySelector('.right-content');
    if (!co) return;
    out.push({
      time: te?.textContent?.trim() || '',
      title: ti?.textContent?.trim() || '',
      content: co.textContent.trim(),
    });
  });
  return out;
};

// 浏览器 - 让 Playwright 自己管理而不是连接 CDP
let browser = null;
async function connectBrowser() {
  if (browser?.isConnected()) return true;
  if (browser) { try { await browser.close(); } catch {} }
  // 直接启动浏览器而不是连接 CDP
  browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  return true;
}

async function getPage() {
  if (!browser?.isConnected()) { await connectBrowser(); }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(JIN10_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(5000);
  return page;
}


// Web 服务器 - 提供 REST API 和静态页面
function startWebServer() {
  const publicDir = join(__dirname, 'public');
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.json': 'application/json',
    '.ico':  'image/x-icon',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);
      const pathname = url.pathname;

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      // ── API routes ──────────────────────────────────────────────────────────
      if (pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, time: new Date().toISOString() }));
        return;
      }

      if (pathname === '/api/status') {
        const state = loadState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...state }));
        return;
      }

      if (pathname === '/api/news') {
        const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '20', 10), 100);
        const before = parseInt(url.searchParams.get('before') || '0', 10);
        const items  = loadNews();
        const pool   = before > 0 ? items.filter(n => n.createdAt < before) : items;
        const page   = pool.slice(0, limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, items: page, total: items.length, hasMore: pool.length > limit }));
        return;
      }

      // ── Config API ────────────────────────────────────────────────────────
      if (pathname === '/api/config' && req.method === 'GET') {
        const current = loadConfigFile();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, config: current }));
        return;
      }

      if (pathname === '/api/config' && req.method === 'POST') {
        let body;
        try { body = await readRequestBody(req, res); } catch (e) {
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
          return;
        }
        // Validate structure
        if (body.AI_PROVIDERS !== undefined && !Array.isArray(body.AI_PROVIDERS)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'AI_PROVIDERS must be an array' }));
          return;
        }
        saveConfigFile(body);
        reloadConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, providers: AI_PROVIDERS.length }));
        return;
      }

      // ── Daily Analysis API ────────────────────────────────────────────────
      if (pathname === '/api/daily-analysis' && req.method === 'GET') {
        const date = url.searchParams.get('date') || getTodayDateStr();
        const all = loadDailyAnalyses();
        const entry = all[date] || null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, date, analysis: entry }));
        return;
      }

      if (pathname === '/api/daily-analysis/trigger' && req.method === 'POST') {
        let body = {};
        try { body = await readRequestBody(req, res); } catch {}
        const date = body.date || getTodayDateStr();
        // Run async - don't block the response
        generateDailyReport(date).then(entry => {
          if (entry) saveDailyAnalysis(date, entry);
        }).catch(e => logErr(`每日分析触发: ${e.message}`));
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: `正在生成 ${date} 的每日分析，请稍后刷新查看` }));
        return;
      }

      // ── Re-analyze a single news item ─────────────────────────────────────
      if (pathname === '/api/news/reanalyze' && req.method === 'POST') {
        let body;
        try { body = await readRequestBody(req, res); } catch (e) {
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
          return;
        }
        const { id } = body;
        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'id is required' }));
          return;
        }
        const newsItems = loadNews();
        const newsItem = newsItems.find(n => n.id === id);
        if (!newsItem) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '新闻条目不存在' }));
          return;
        }
        if (AI_PROVIDERS.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '未配置任何 AI 提供商，请先在配置页面添加 AI 提供商' }));
          return;
        }
        try {
          const state = loadState();
          const result = await analyze(newsItem, state);
          const analysisText = result?.text || '';
          const analysisSource = result?.source || '';
          const analysisError = analysisText ? '' : '暂不可用';
          const technical = analysisText ? await buildTechnicalSummary(analysisText) : '';
          updateNewsItem(id, { analysis: analysisText, analysisSource, analysisError, technical });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, analysis: analysisText, analysisSource, analysisError, technical }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // ── Static files ─────────────────────────────────────────────────────────
      const filePath = pathname === '/' ? '/index.html' : pathname;
      const fullPath = resolve(publicDir, '.' + filePath);
      const ext = extname(fullPath);

      // Prevent path traversal: resolved path must stay inside publicDir
      if (!fullPath.startsWith(publicDir + '/') && fullPath !== publicDir) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      if (existsSync(fullPath)) {
        try {
          const data = readFileSync(fullPath);
          res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
          res.end(data);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }
  });

  server.listen(HTTP_PORT, HTTP_HOST, () => {
    const displayHost = HTTP_HOST === '0.0.0.0' ? `localhost` : HTTP_HOST;
    log(`🌐 Web 服务器启动: http://${displayHost}:${HTTP_PORT} (监听 ${HTTP_HOST})`);
  });
  return server;
}

// 主程序
async function main() {
  acquireLock();
  log('🔴 金十监控启动');
  startWebServer();

  await connectBrowser();
  let page = await getPage();
  log(`   页面: ${page.url()}`);

  let dedup = loadDedup();
  let state = loadState();
  let loop = 0;

  while (true) {
    loop++;
    log(`--- #${loop} ---`);

    try {
      // page 可能被关/崩溃；如果不可用就重建
      if (page.isClosed()) {
        log('  ♻️ page 已关闭，重建');
        page = await getPage();
      }

      // 抓取
      let news = await page.evaluate(SCRAPE_EVAL);
      
      // 去重 - 基于内容
      const seen = new Set();
      news = news.filter(item => {
        const k = getKey(item);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      
      log(`  红色新闻: ${news.length} 条`);
      
      // 处理每条新闻
      for (const item of news) {
        const k = getKey(item);

        // 已推送过，跳过
        if (dedup[k]) {
          log(`  ⏭️ 跳过: ${item.time} ${item.title?.substring(0,20)}`);
          continue;
        }

        // 广告过滤
        if (isAd(item)) {
          log(`  🚫 广告过滤: ${item.title?.substring(0,30)}`);
          dedup[k] = { ts: Date.now(), ad: true };
          saveDedup(dedup);
          continue;
        }

        // 过滤「点击查看」占位内容
        if (isClickToView(item)) {
          log(`  🚫 点击查看过滤: ${item.time} ${item.title?.substring(0,30)}`);
          dedup[k] = { ts: Date.now(), click_to_view: true };
          saveDedup(dedup);
          continue;
        }

        // 过滤「周度/日历/预告」类内容
        if (isCalendarPreview(item)) {
          log(`  🚫 日历/预告过滤: ${item.time} ${item.title?.substring(0, 30)}`);
          dedup[k] = { ts: Date.now(), calendar_preview: true };
          saveDedup(dedup);
          continue;
        }

        // 生成 AI 分析（尽量在同一条消息里发出，避免补发/拆分）
        let analysisText = '';
        let analysisSource = '';
        let analysisError = '';
        if (AI_PROVIDERS.length > 0) {
          try {
            const res = await analyze(item, state);
            analysisText = res?.text || '';
            analysisSource = res?.source || '';
            if (!analysisText) analysisError = '暂不可用';
          } catch (e) {
            analysisError = e?.message ? String(e.message).slice(0, 120) : '暂不可用';
          }
        }

        const technical = await buildTechnicalSummary(analysisText);
        state.lastPushAt = Date.now();
        await sleep(500);

        // 立即保存
        dedup[k] = { ts: Date.now() };
        saveDedup(dedup);

        // 保存到新闻存储（供 Web 页面展示）
        appendNews({ id: k, time: item.time, title: item.title, content: item.content,
          analysis: analysisText, analysisSource, analysisError, technical,
          createdAt: Date.now() });

        log(`  ✅ 已处理`);
      }
      
      // 清理旧去重
      dedup = cleanDedup(dedup);
      saveDedup(dedup);

      state.ok = (state.ok || 0) + 1;
      state.consecutiveFail = 0;
      state.lastSuccessAt = Date.now();
      saveState(state);

      // 每日分析自动触发：每天 23:30 后自动生成（若当天尚未生成）
      const nowHour = parseInt(
        new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false }),
        10
      );
      if (nowHour >= 23) {
        const today = getTodayDateStr();
        const dailyAll = loadDailyAnalyses();
        if (!dailyAll[today]) {
          log('📅 触发每日自动分析...');
          const entry = await generateDailyReport(today);
          if (entry) saveDailyAnalysis(today, entry);
        }
      }

    } catch (e) {
      logErr(`loop: ${e.message}`);

      state.fail = (state.fail || 0) + 1;
      state.consecutiveFail = (state.consecutiveFail || 0) + 1;
      state.lastErrorAt = Date.now();
      state.lastError = String(e.message || e);
      saveState(state);
    }

    await sleep(POLL_MS);
  }
}

main().catch(e => { logErr(`crash: ${e.message}`); process.exit(1); });
