#!/usr/bin/env node
/**
 * 金十红色新闻监控 - 彻底解决重复推送问题
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCK_FILE = join(__dirname, '.lock');
const DEDUP_FILE = join(__dirname, 'dedup.json');

// 配置
const JIN10_URL = 'https://www.jin10.com/';
const POLL_MS = 60_000;
const CDP_PORT = 18800;
const DEDUP_HOURS = 72;

// 从 config.json 读取配置
const cfg = existsSync(join(__dirname, 'config.json')) 
  ? JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf-8')) : {};

// AI 提供商配置（支持 minimax / openai / gemini / claude）
// 新格式：AI_PROVIDERS 数组；旧格式：MINIMAX_API_KEY（向后兼容）
function loadAiProviders() {
  const providers = Array.isArray(cfg.AI_PROVIDERS)
    ? cfg.AI_PROVIDERS.filter(p => p && p.type && p.apiKey)
    : [];
  if (cfg.MINIMAX_API_KEY && !providers.some(p => p.type === 'minimax')) {
    providers.unshift({ type: 'minimax', apiKey: cfg.MINIMAX_API_KEY });
  }
  return providers;
}
const AI_PROVIDERS = loadAiProviders();

// AI 超时（两轮重试：第一轮较短，第二轮宽松）
const AI_TIMEOUT_FIRST_MS = 15_000;
const AI_TIMEOUT_RETRY_MS = 30_000;

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
function saveDedup(d) { writeFileSync(DEDUP_FILE, JSON.stringify(d, null, 2)); }
function cleanDedup(d) {
  const cut = Date.now() - DEDUP_HOURS * 3600_000;
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v.ts > cut));
}
function getKey(item) { return createHash('sha1').update(item.time + '|' + item.content.substring(0,100)).digest('hex'); }

// 广告过滤
const AD_PATTERNS = /VIP[·\s]*\d*折|猜金价|竞猜.*赢|领取.*礼|解锁.*利器|新春福利/;
function isAd(item) {
  const text = (item.title || '') + ' ' + (item.content || '');
  return AD_PATTERNS.test(text);
}

// 各 AI 提供商调用函数

async function callMinimax(apiKey, model, prompt, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('https://api.minimaxi.com/anthropic/v1/messages', {
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

async function callOpenai(apiKey, model, prompt, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
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

async function callGemini(apiKey, model, prompt, timeoutMs) {
  const m = model || 'gemini-1.5-pro';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${apiKey}`,
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

async function callClaude(apiKey, model, prompt, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
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
  const { type, apiKey, model } = provider;
  switch (type) {
    case 'minimax': return callMinimax(apiKey, model, prompt, timeoutMs);
    case 'openai':  return callOpenai(apiKey, model, prompt, timeoutMs);
    case 'gemini':  return callGemini(apiKey, model, prompt, timeoutMs);
    case 'claude':  return callClaude(apiKey, model, prompt, timeoutMs);
    default: throw new Error(`unknown provider type: ${type}`);
  }
}

// AI 分析
async function analyze(item) {
  if (AI_PROVIDERS.length === 0) {
    logErr('AI: 未配置任何 AI 提供商（请在 config.json 中设置 AI_PROVIDERS 或 MINIMAX_API_KEY）');
    return null;
  }
  const prompt = `分析这条金融新闻，必须输出以下格式（严格按照，不要空行）：

标的：具体交易品种，如"纳指"、"道指"、"上证指数"、"深证成指"、"恒生指数"、"黄金"、"白银"、"原油"、"美元指数"、"比特币"、"以太坊"、"美股"、"A股"、"港股"等，不要写"宏观"
判断：利好/利空/中性（简要判断对标的的影响方向）
说明：详细说明具体影响原因和市场预期，越详细越好

新闻："${item.title || ''} ${item.content}"`;
  const timeouts = [AI_TIMEOUT_FIRST_MS, AI_TIMEOUT_RETRY_MS];
  for (const timeoutMs of timeouts) {
    for (const provider of AI_PROVIDERS) {
      try {
        const res = await callProvider(provider, prompt, timeoutMs);
        if (res?.text) {
          log(`  🤖 AI (${res.source}): ${res.text.replace(/\n/g, ' | ')}`);
          return res.text;
        }
      } catch (e) {
        logErr(`AI (${provider.type}): ${e.message}`);
        await sleep(500);
      }
    }
  }
  return null;
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

// 主程序
async function main() {
  acquireLock();
  log('🔴 金十监控启动');
  
  await connectBrowser();
  const page = await getPage();
  log(`   页面: ${page.url()}`);
  
  let dedup = loadDedup();
  let loop = 0;
  
  while (true) {
    loop++;
    log(`--- #${loop} ---`);
    
    try {
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
        
        // AI 分析
        const analysis = await analyze(item);
        if (!analysis) {
          log(`  ⚠️ AI 分析失败`);
        }
        
        // 立即保存
        dedup[k] = { ts: Date.now() };
        saveDedup(dedup);
        log(`  ✅ 已处理`);
      }
      
      // 清理旧去重
      dedup = cleanDedup(dedup);
      
    } catch (e) {
      logErr(`loop: ${e.message}`);
    }
    
    await sleep(POLL_MS);
  }
}

main().catch(e => { logErr(`crash: ${e.message}`); process.exit(1); });
