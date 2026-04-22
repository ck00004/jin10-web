/**
 * Jin10 Monitor — Config Page Application
 *
 * Manages AI provider configuration, server settings, and AI debug mode.
 * Merges with existing config on save to preserve unknown fields.
 */
import { esc, showToast } from './utils.js';

// ── State ────────────────────────────────────────────────────────────────────
let newsProviders = [];
let dailyProviders = [];
let existingConfig = {}; // store the full config to merge on save

/** Default models & base URLs — must match the server-side defaults */
const TYPE_DEFAULTS = {
  openai:  { model: 'gpt-4o',                     baseUrl: 'https://api.openai.com/v1' },
  claude:  { model: 'claude-sonnet-4-20250514',    baseUrl: 'https://api.anthropic.com/v1' },
  gemini:  { model: 'gemini-2.0-flash',            baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  minimax: { model: 'MiniMax-M2.5',                baseUrl: 'https://api.minimaxi.com/anthropic/v1' },
};

// ── DOM helpers ──────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const toast = () => $('toast');

// ── Load config from API ─────────────────────────────────────────────────────
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const d = await res.json();
    if (!d.ok) throw new Error('API error');
    const cfg = d.config || {};
    existingConfig = cfg;
    const legacyProviders = (cfg.AI_PROVIDERS || []).map(p => ({ ...p }));
    newsProviders = (cfg.NEWS_ANALYSIS_AI_PROVIDERS || legacyProviders).map(p => ({ ...p }));
    dailyProviders = (cfg.DAILY_ANALYSIS_AI_PROVIDERS || legacyProviders).map(p => ({ ...p }));
    $('port-input').value = cfg.WEB_PORT || '';
    $('host-input').value = cfg.WEB_HOST || '';
    // AI Debug toggle
    const debugToggle = $('debug-toggle');
    if (cfg.AI_DEBUG) {
      debugToggle.classList.add('active');
    } else {
      debugToggle.classList.remove('active');
    }
    renderProviders('news');
    renderProviders('daily');
    showToast(toast(), 'ok', '配置已加载');
  } catch (e) {
    showToast(toast(), 'err', '加载失败：' + e.message);
  }
}
// Expose to global for onclick handlers
window.loadConfig = loadConfig;

// ── Render provider cards ────────────────────────────────────────────────────
function getProvidersByKind(kind) {
  return kind === 'daily' ? dailyProviders : newsProviders;
}

function getListId(kind) {
  return kind === 'daily' ? 'daily-providers-list' : 'news-providers-list';
}

function renderProviders(kind) {
  const providers = getProvidersByKind(kind);
  const list = $(getListId(kind));
  list.innerHTML = '';
  if (providers.length === 0) {
    list.innerHTML = '<div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:12px;">暂无 AI 提供商，点击下方按钮添加</div>';
    return;
  }
  providers.forEach((p, i) => {
    const prefix = `${kind}-${i}`;
    const card = document.createElement('div');
    card.className = 'provider-card';
    card.innerHTML = `
      <div class="provider-header">
        <span class="provider-num">#${i + 1}</span>
        <span class="provider-type-badge" id="badge-${prefix}">${p.type || '—'}</span>
        <button class="btn btn-danger btn-sm" onclick="removeProvider('${kind}', ${i})">✕ 删除</button>
      </div>
      <div class="form-row">
        <label>类型</label>
        <select id="type-${prefix}" onchange="onTypeChange('${kind}', ${i})">
          <option value="openai"  ${p.type === 'openai'  ? 'selected' : ''}>openai</option>
          <option value="claude"  ${p.type === 'claude'  ? 'selected' : ''}>claude</option>
          <option value="gemini"  ${p.type === 'gemini'  ? 'selected' : ''}>gemini</option>
          <option value="minimax" ${p.type === 'minimax' ? 'selected' : ''}>minimax</option>
        </select>
      </div>
      <div class="form-row">
        <label>API Key</label>
        <input type="password" id="key-${prefix}" value="${esc(p.apiKey || '')}" placeholder="必填" autocomplete="off" />
      </div>
      <div class="form-row">
        <label>模型</label>
        <input type="text" id="model-${prefix}" value="${esc(p.model || '')}" placeholder="留空使用默认：${(TYPE_DEFAULTS[p.type] || TYPE_DEFAULTS.openai).model}" />
      </div>
      <div class="form-row">
        <label>远程地址</label>
        <input type="url" id="baseurl-${prefix}" value="${esc(p.baseUrl || '')}" placeholder="留空使用官方默认地址" />
      </div>
      <div class="form-row">
        <span></span>
        <span class="form-hint">远程地址示例：<span id="hint-${prefix}">${getHint(p.type)}</span></span>
      </div>
    `;
    list.appendChild(card);
  });
}

function getHint(type) {
  return (TYPE_DEFAULTS[type] || TYPE_DEFAULTS.openai).baseUrl;
}

window.onTypeChange = function (kind, i) {
  const prefix = `${kind}-${i}`;
  const type = $(`type-${prefix}`).value;
  $(`badge-${prefix}`).textContent = type;
  $(`hint-${prefix}`).textContent = getHint(type);
  const modelInput = $(`model-${prefix}`);
  if (!modelInput.value) {
    modelInput.placeholder = `留空使用默认：${(TYPE_DEFAULTS[type] || {}).model || ''}`;
  }
};

function addProvider(kind) {
  const providers = getProvidersByKind(kind);
  providers.push({ type: 'openai', apiKey: '', model: '', baseUrl: '' });
  renderProviders(kind);
  const list = $(getListId(kind));
  list.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

window.addNewsProvider = function () { addProvider('news'); };
window.addDailyProvider = function () { addProvider('daily'); };

window.removeProvider = function (kind, i) {
  const providers = getProvidersByKind(kind);
  providers.splice(i, 1);
  renderProviders(kind);
};

window.toggleDebug = function () {
  const el = $('debug-toggle');
  el.classList.toggle('active');
};

// ── Collect provider data from DOM ───────────────────────────────────────────
function collectProviders(kind) {
  const providers = getProvidersByKind(kind);
  const result = [];
  for (let i = 0; i < providers.length; i++) {
    const prefix = `${kind}-${i}`;
    const type    = $(`type-${prefix}`)?.value?.trim() || 'openai';
    const apiKey  = $(`key-${prefix}`)?.value?.trim() || '';
    const model   = $(`model-${prefix}`)?.value?.trim() || '';
    const baseUrl = $(`baseurl-${prefix}`)?.value?.trim() || '';
    if (!apiKey) continue;
    const p = { type, apiKey };
    if (model) p.model = model;
    if (baseUrl) p.baseUrl = baseUrl;
    result.push(p);
  }
  return result;
}

// ── Save config ──────────────────────────────────────────────────────────────
window.saveConfig = async function () {
  const btn = $('save-btn');
  btn.disabled = true;
  try {
    const port = parseInt($('port-input').value, 10);
    const host = $('host-input').value.trim();
    const aiDebug = $('debug-toggle').classList.contains('active');
    const nextNewsProviders = collectProviders('news');
    const nextDailyProviders = collectProviders('daily');

    // Merge with existing config to preserve unknown fields
    const body = { ...existingConfig };
    body.NEWS_ANALYSIS_AI_PROVIDERS = nextNewsProviders;
    body.DAILY_ANALYSIS_AI_PROVIDERS = nextDailyProviders;
    delete body.AI_PROVIDERS;
    if (port >= 1 && port <= 65535) {
      body.WEB_PORT = port;
    } else {
      delete body.WEB_PORT;
    }
    if (host) {
      body.WEB_HOST = host;
    } else {
      delete body.WEB_HOST;
    }
    body.AI_DEBUG = aiDebug;

    // Remove legacy MINIMAX_API_KEY if AI_PROVIDERS handles it
    // (keep it if user hasn't migrated yet)

    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'save failed');
    existingConfig = body; // update local cache
    showToast(toast(), 'ok', `✅ 配置已保存，新闻分析 ${d.newsProviders} 个模型，每日分析 ${d.dailyProviders} 个模型（立即生效，端口/地址变更需重启）`);
  } catch (e) {
    showToast(toast(), 'err', '保存失败：' + e.message);
  } finally {
    btn.disabled = false;
  }
};

// ── Initialize ───────────────────────────────────────────────────────────────
loadConfig();
