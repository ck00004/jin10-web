/**
 * Jin10 Monitor — News Page Application
 */
import { esc, fmtTime } from './utils.js';

// ── State ────────────────────────────────────────────────────────────────────
let allItems = [];
let oldestCreatedAt = 0;
let hasMore = false;
let autoRefreshTimer = null;
let showSkipped = false;
let importantOnly = false;
const PAGE_SIZE = 20;

// ── DOM references ───────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ── Helpers ──────────────────────────────────────────────────────────────────
function skippedParam() {
  return showSkipped ? '&includeSkipped=1' : '';
}

function setStatus(state, text) {
  $('status-dot').className = `status-dot ${state}`;
  $('status-text').textContent = text;
}

// ── Toggle handlers ──────────────────────────────────────────────────────────
window.toggleSkipped = function () {
  showSkipped = !showSkipped;
  $('skipped-toggle').classList.toggle('active', showSkipped);
  loadNews(true);
};

window.toggleImportantOnly = function () {
  importantOnly = !importantOnly;
  $('important-toggle').classList.toggle('active', importantOnly);
  reRenderAll();
};

function reRenderAll() {
  const filtered = importantOnly ? allItems.filter(n => n.important === true) : allItems;
  const grid = $('news-grid');
  grid.innerHTML = '';
  if (filtered.length === 0) {
    grid.innerHTML = '<div class="loading-placeholder">📭 暂无匹配的新闻数据</div>';
  } else {
    const fragment = document.createDocumentFragment();
    for (const item of filtered) {
      fragment.appendChild(buildCard(item));
    }
    grid.appendChild(fragment);
  }
  $('load-more-wrap').style.display = hasMore ? 'block' : 'none';
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
async function init() {
  await loadNews(true);
  updateStatusBar();
  scheduleAutoRefresh();
}

function scheduleAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(refresh, 30_000);
}

// ── Fetch news ───────────────────────────────────────────────────────────────
async function loadNews(reset = false) {
  const btn = $('refresh-btn');
  btn.disabled = true;

  try {
    const before = reset ? 0 : (oldestCreatedAt || 0);
    const url = `/api/news?limit=${PAGE_SIZE}&includeAnalysis=1${skippedParam()}` + (before > 0 ? `&before=${before}` : '');
    const res = await fetch(url);
    const data = await res.json();

    if (!data.ok) throw new Error('API error');

    if (reset) {
      allItems = data.items;
    } else {
      allItems = allItems.concat(data.items);
    }

    if (allItems.length > 0) {
      oldestCreatedAt = allItems[allItems.length - 1].createdAt;
    }
    hasMore = data.hasMore;

    renderCards(data.items, !reset);
    $('load-more-wrap').style.display = hasMore ? 'block' : 'none';
    setStatus('ok', `共 ${data.total} 条 · ${fmtTime(new Date())}`);
  } catch (e) {
    setStatus('err', `加载失败: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

window.refresh = async function () {
  const btn = $('refresh-btn');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/news?limit=${PAGE_SIZE}&includeAnalysis=1${skippedParam()}`);
    const data = await res.json();
    if (!data.ok) throw new Error('API error');

    const existingIds = new Set(allItems.map(n => n.id));
    const newItems = data.items.filter(n => !existingIds.has(n.id));

    if (newItems.length > 0) {
      allItems = newItems.concat(allItems);
      renderCards(newItems, false, true);
    }

    hasMore = data.hasMore;
    $('load-more-wrap').style.display = hasMore ? 'block' : 'none';
    setStatus('ok', `共 ${data.total} 条 · ${fmtTime(new Date())}`);
  } catch (e) {
    setStatus('err', `刷新失败: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
};

window.loadMore = async function () {
  const btn = $('load-more-btn');
  btn.disabled = true;
  btn.textContent = '加载中…';
  await loadNews(false);
  btn.disabled = false;
  btn.textContent = '加载更多';
};

// ── Render ───────────────────────────────────────────────────────────────────
function renderCards(items, append = false, prepend = false) {
  const grid = $('news-grid');

  // Remove loading placeholder
  const placeholder = grid.querySelector('.loading-placeholder');
  if (placeholder) placeholder.remove();

  // Filter
  const filtered = importantOnly ? items.filter(n => n.important === true) : items;

  // Reset mode
  if (!append && !prepend) {
    grid.innerHTML = '';
    if (filtered.length === 0) {
      grid.innerHTML = '<div class="loading-placeholder">📭 暂无新闻数据</div>';
      return;
    }
  }

  if (filtered.length === 0) return;

  const fragment = document.createDocumentFragment();
  for (const item of filtered) {
    fragment.appendChild(buildCard(item));
  }

  if (prepend) {
    grid.insertBefore(fragment, grid.firstChild);
  } else {
    grid.appendChild(fragment);
  }
}

// ── Card Builder ─────────────────────────────────────────────────────────────
function buildCard(item) {
  const card = document.createElement('div');
  const isImportant = item.important === true;
  const isDeleted = item.deleted === true;
  let cls = 'card news-card';
  if (item.skipped) cls += ' skipped';
  else if (isDeleted) cls += ' deleted-card';
  else if (isImportant) cls += ' important';
  card.className = cls;
  card.dataset.id = item.id;

  // Time + badges
  const timeEl = document.createElement('div');
  timeEl.className = 'card-time';
  let timeHtml = esc(item.time || fmtTime(new Date(item.createdAt)));
  if (isImportant) timeHtml += `<span class="badge badge-important">重要</span>`;
  if (isDeleted) timeHtml += `<span class="badge badge-deleted">已删除</span>`;
  if (item.skipped) timeHtml += `<span class="badge badge-skip">${esc(item.skipReason || '已跳过')}</span>`;
  if (item.flashId) timeHtml += `<span class="flash-id">ID: ${esc(item.flashId)}</span>`;
  if (item.source) timeHtml += `<span class="card-source">(${esc(item.source)})</span>`;
  timeEl.innerHTML = timeHtml;
  card.appendChild(timeEl);

  // Tags + hot tag
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const hotTag = item.hotTag || '';
  if (tags.length > 0 || hotTag) {
    const tagsEl = document.createElement('div');
    tagsEl.className = 'card-tags';
    for (const tag of tags) {
      const span = document.createElement('span');
      span.className = 'badge';
      if (tag === 'VIP' || tag === 'VIP·锁定') span.classList.add('badge-vip');
      else if (tag === '广告') span.classList.add('badge-ad');
      else if (tag === '直播') span.classList.add('badge-live');
      else if (tag === '精英') span.classList.add('badge-elite');
      else span.classList.add('badge-default');
      span.textContent = tag;
      tagsEl.appendChild(span);
    }
    if (hotTag) {
      const span = document.createElement('span');
      span.className = `badge badge-hot badge-hot-${hotTag}`;
      span.textContent = hotTag;
      tagsEl.appendChild(span);
    }
    card.appendChild(tagsEl);
  }

  // Title
  if (item.title) {
    const titleEl = document.createElement('div');
    titleEl.className = 'card-title';
    titleEl.textContent = item.title;
    card.appendChild(titleEl);
  }

  // Content
  const contentEl = document.createElement('div');
  contentEl.className = 'card-content';
  contentEl.textContent = item.content;
  card.appendChild(contentEl);

  // Calendar data
  if (item.calendarData) {
    const cd = item.calendarData;
    const calEl = document.createElement('div');
    calEl.className = 'calendar-data';
    const unit = cd.unit || '';
    const fmtVal = (v) => {
      if (v == null || v === '--') return '--';
      const s = v === 0 ? '0' : String(v);
      return unit === '%' ? s + '%' : s;
    };
    calEl.innerHTML = `<span class="calendar-data-item">前值: <strong>${esc(fmtVal(cd.previous))}</strong></span>`
      + `<span class="calendar-data-item">预期: <strong>${esc(fmtVal(cd.forecast))}</strong></span>`
      + `<span class="calendar-data-item">公布: <strong>${esc(fmtVal(cd.actual))}</strong></span>`;
    if (cd.revised != null) {
      calEl.innerHTML += `<span class="calendar-data-item">修正: <strong>${esc(fmtVal(cd.revised))}</strong></span>`;
    }
    if (typeof cd.star === 'number' && cd.star > 0) {
      const stars = '★'.repeat(cd.star) + '☆'.repeat(Math.max(0, 5 - cd.star));
      calEl.innerHTML += `<span class="calendar-star">${stars}</span>`;
    }
    card.appendChild(calEl);
  }

  // Affect
  if (item.affect) {
    const affEl = document.createElement('div');
    affEl.className = 'card-affect';
    if (item.affect.includes('利多')) affEl.classList.add('affect-bull');
    else if (item.affect.includes('利空')) affEl.classList.add('affect-bear');
    else affEl.classList.add('affect-neutral');
    affEl.textContent = item.affect;
    card.appendChild(affEl);
  }

  // VIP info
  if (item.vipTitle || item.vipDesc) {
    const vipEl = document.createElement('div');
    vipEl.className = 'card-vip-info';
    if (item.vipTitle) vipEl.innerHTML += `<div class="card-vip-title">VIP: ${esc(item.vipTitle)}</div>`;
    if (item.vipDesc) vipEl.innerHTML += `<div class="card-vip-desc">解读: ${esc(item.vipDesc)}</div>`;
    card.appendChild(vipEl);
  }

  // Link
  if (item.link) {
    const linkEl = document.createElement('div');
    linkEl.className = 'card-link';
    linkEl.textContent = `链接: ${item.link}`;
    card.appendChild(linkEl);
  }

  // Remarks
  const remarks = Array.isArray(item.remarks) ? item.remarks : [];
  if (remarks.length > 0) {
    const rmBlock = document.createElement('div');
    rmBlock.className = 'card-remarks';
    for (const rm of remarks) {
      const rmEl = document.createElement('div');
      rmEl.className = 'remark-item';
      const typeLabel = { link: '链接', topic: '话题', quotes: '行情', news: '新闻', content: '注解' };
      const typeClass = `remark-type-${rm.type}`;
      let html = `<span class="remark-type ${typeClass}">${esc(typeLabel[rm.type] || rm.type)}</span>`;
      if (rm.type === 'content') {
        html += `<span class="remark-text">${esc(rm.content || '')}</span>`;
      } else {
        html += `<span class="remark-text">${esc(rm.title || '')}</span>`;
        if (rm.symbol) html += `<span class="remark-symbol">(${esc(rm.symbol)})</span>`;
        if (rm.link) html += `<span class="remark-link">${esc(rm.link)}</span>`;
      }
      rmEl.innerHTML = html;
      rmBlock.appendChild(rmEl);
    }
    card.appendChild(rmBlock);
  }

  // Edit history
  if (Array.isArray(item.editHistory) && item.editHistory.length > 0) {
    card.appendChild(buildEditHistoryBlock(item.editHistory));
  }

  // Skipped / deleted: no AI block or actions
  if (item.skipped || isDeleted) return card;

  // AI analysis block
  if (item.analysis) {
    card.appendChild(buildAiBlock(item.analysis, item.analysisSource, item.technical));
  } else if (item.analysisError) {
    const noAi = document.createElement('div');
    noAi.className = 'ai-block';
    noAi.innerHTML = `<div class="ai-no-analysis">🤖 AI 分析暂不可用：${esc(item.analysisError)}</div>`;
    card.appendChild(noAi);
  }

  // Card actions
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  if (item.analysis) {
    const reBtn = document.createElement('button');
    reBtn.className = 'btn btn-secondary btn-sm';
    reBtn.textContent = '🔄 重新AI分析';
    reBtn.onclick = () => reanalyzeNews(item.id);
    actions.appendChild(reBtn);
  } else {
    const aiBtn = document.createElement('button');
    aiBtn.className = 'btn btn-secondary btn-sm';
    aiBtn.textContent = isImportant ? '🔄 重新AI分析' : '🤖 AI分析';
    aiBtn.onclick = () => reanalyzeNews(item.id);
    actions.appendChild(aiBtn);
  }
  card.appendChild(actions);

  return card;
}

// ── Edit History Block ───────────────────────────────────────────────────────
function buildEditHistoryBlock(editHistory) {
  const block = document.createElement('div');
  block.className = 'edit-history-block';

  const header = document.createElement('div');
  header.className = 'edit-history-header';
  header.innerHTML = `<span>📝 修改记录 (${editHistory.length}次)</span><span class="edit-history-toggle">▼</span>`;

  const body = document.createElement('div');
  body.className = 'edit-history-body collapsed';

  for (const entry of editHistory) {
    const entryEl = document.createElement('div');
    entryEl.className = 'edit-history-entry';

    const timeEl = document.createElement('div');
    timeEl.className = 'edit-history-time';
    timeEl.textContent = new Date(entry.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    entryEl.appendChild(timeEl);

    const diffEl = document.createElement('div');
    diffEl.className = 'edit-history-diff';
    if (entry.oldContent) {
      diffEl.innerHTML += `<span class="diff-label">旧：</span><span class="diff-old">${esc(entry.oldContent.substring(0, 200))}</span>`;
    }
    if (entry.newContent) {
      diffEl.innerHTML += `<span class="diff-label">新：</span><span class="diff-new">${esc(entry.newContent.substring(0, 200))}</span>`;
    }
    entryEl.appendChild(diffEl);
    body.appendChild(entryEl);
  }

  block.appendChild(header);
  block.appendChild(body);

  header.addEventListener('click', () => {
    const collapsed = body.classList.toggle('collapsed');
    header.querySelector('.edit-history-toggle').classList.toggle('open', !collapsed);
  });

  return block;
}

// ── AI Analysis Block ────────────────────────────────────────────────────────
function buildAiBlock(analysisText, source, technical) {
  const parsed = parseAnalysis(analysisText);
  const dir = detectDirection(parsed.direction || '');

  const block = document.createElement('div');
  block.className = 'ai-block';

  // Header
  const header = document.createElement('div');
  header.className = 'ai-header';

  const label = document.createElement('span');
  label.className = 'ai-header-label';
  label.textContent = `📊 AI 分析${source ? '（' + source + '）' : ''}`;

  const badge = document.createElement('span');
  badge.className = `direction-badge ${dir.cls}`;
  badge.textContent = dir.short;

  const toggle = document.createElement('span');
  toggle.className = 'ai-toggle open';
  toggle.textContent = '▼';

  header.appendChild(label);
  header.appendChild(badge);
  header.appendChild(toggle);

  // Body
  const body = document.createElement('div');
  body.className = 'ai-body';

  const FIELD_LABELS = [
    ['target', '标的'],
    ['direction', '方向'],
    ['logic', '逻辑链'],
    ['driver', '核心驱动'],
    ['risk', '关键风险'],
    ['signal', '确认信号'],
    ['tech', '技术面'],
  ];
  for (const [key, lbl] of FIELD_LABELS) {
    if (parsed[key]) {
      const row = document.createElement('div');
      row.className = 'ai-row';
      row.innerHTML = `<span class="ai-row-label">${esc(lbl)}：</span><span class="ai-row-value">${esc(parsed[key])}</span>`;
      body.appendChild(row);
    }
  }

  // If we couldn't parse structured fields, show raw text
  if (!Object.values(parsed).some(Boolean)) {
    const raw = document.createElement('div');
    raw.className = 'ai-body-raw';
    raw.textContent = analysisText;
    body.appendChild(raw);
  }

  // Technical analysis
  if (technical) {
    const techBlock = document.createElement('div');
    techBlock.className = 'tech-block';
    techBlock.textContent = technical;
    body.appendChild(techBlock);
  }

  block.appendChild(header);
  block.appendChild(body);

  // Toggle collapse
  header.addEventListener('click', () => {
    const collapsed = body.classList.toggle('collapsed');
    toggle.classList.toggle('open', !collapsed);
  });

  return block;
}

// ── Analysis Parser ──────────────────────────────────────────────────────────
function parseAnalysis(text) {
  if (!text) return {};
  const result = {};
  const MAP = {
    '标的': 'target',
    '方向': 'direction',
    '逻辑链': 'logic',
    '核心驱动': 'driver',
    '关键风险': 'risk',
    '确认信号': 'signal',
    '技术面': 'tech',
  };
  const lines = text.split('\n');
  let currentKey = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let matched = false;
    for (const [cn, en] of Object.entries(MAP)) {
      if (trimmed.startsWith(cn + '：') || trimmed.startsWith(cn + ':')) {
        currentKey = en;
        result[en] = trimmed.slice(cn.length + 1).trim();
        matched = true;
        break;
      }
    }
    if (!matched && currentKey && result[currentKey] !== undefined) {
      result[currentKey] += ' ' + trimmed;
    }
  }
  return result;
}

function detectDirection(dirText) {
  const t = dirText || '';
  if (/利好/.test(t)) return { cls: 'bull', short: '利好 📈' };
  if (/利空/.test(t)) return { cls: 'bear', short: '利空 📉' };
  if (/中性/.test(t)) return { cls: 'neutral', short: '中性 ➡️' };
  return { cls: 'neutral', short: dirText ? dirText.slice(0, 6) : '—' };
}

// ── Status Bar ───────────────────────────────────────────────────────────────
async function updateStatusBar() {
  try {
    const res = await fetch('/api/status');
    const d = await res.json();
    if (d.ok) {
      const info = `推送 ${d.ok || 0} 次 · 失败 ${d.fail || 0} 次`;
      setStatus('ok', info + ' · ' + fmtTime(new Date()));
    }
  } catch { /* ignore */ }
}

// ── Re-analyze ───────────────────────────────────────────────────────────────
async function reanalyzeNews(id) {
  const card = document.querySelector(`.news-card[data-id="${CSS.escape(id)}"]`);
  const btn = card?.querySelector('.card-actions .btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '分析中…';
  }
  try {
    const res = await fetch('/api/news/reanalyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || '分析失败');

    if (card) {
      const oldBlock = card.querySelector('.ai-block');
      if (oldBlock) oldBlock.remove();

      const actions = card.querySelector('.card-actions');
      if (d.analysis) {
        const newBlock = buildAiBlock(d.analysis, d.analysisSource, d.technical);
        card.insertBefore(newBlock, actions);
      } else if (d.analysisError) {
        const noAi = document.createElement('div');
        noAi.className = 'ai-block';
        noAi.innerHTML = `<div class="ai-no-analysis">🤖 AI 分析暂不可用：${esc(d.analysisError)}</div>`;
        card.insertBefore(noAi, actions);
      }
    }

    // Update local cache
    const idx = allItems.findIndex(n => n.id === id);
    if (idx !== -1) {
      const { analysis, analysisSource, analysisError, technical } = d;
      allItems[idx] = { ...allItems[idx], analysis, analysisSource, analysisError, technical };
    }
  } catch (e) {
    alert(`重新AI分析失败: ${e.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔄 重新AI分析';
    }
  }
}

// ── Scroll to top ────────────────────────────────────────────────────────────
window.addEventListener('scroll', () => {
  const btn = $('scroll-top-btn');
  if (btn) btn.classList.toggle('visible', window.scrollY > 400);
}, { passive: true });

// ── Daily Analysis (Calendar) ────────────────────────────────────────────────
let dailyPanelVisible = false;
let calendarYear = new Date().getFullYear();
let calendarMonth = new Date().getMonth();
let calendarDatesWithAnalysis = new Set();
let selectedDate = '';

window.toggleDailyPanel = function () {
  dailyPanelVisible = !dailyPanelVisible;
  const panel = $('daily-panel');
  panel.classList.toggle('visible', dailyPanelVisible);
  if (dailyPanelVisible) {
    loadCalendarDates().then(() => renderCalendar());
  }
};

async function loadCalendarDates() {
  try {
    const res = await fetch('/api/daily-analysis/dates');
    const d = await res.json();
    if (d.ok) {
      calendarDatesWithAnalysis = new Set(d.dates);
    }
  } catch { /* ignore */ }
}

function getTodayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function renderCalendar() {
  const grid = $('calendar-grid');
  const label = $('calendar-month-label');
  grid.innerHTML = '';
  label.textContent = `${calendarYear} 年 ${calendarMonth + 1} 月`;

  const todayStr = getTodayStr();
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  for (const wd of weekdays) {
    const el = document.createElement('div');
    el.className = 'calendar-weekday';
    el.textContent = wd;
    grid.appendChild(el);
  }

  const firstDay = new Date(calendarYear, calendarMonth, 1).getDay();
  const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();

  for (let i = 0; i < firstDay; i++) {
    const el = document.createElement('div');
    el.className = 'calendar-day empty';
    grid.appendChild(el);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const el = document.createElement('div');
    el.className = 'calendar-day';
    el.textContent = d;

    if (dateStr === todayStr) el.classList.add('today');
    if (calendarDatesWithAnalysis.has(dateStr)) el.classList.add('has-analysis');
    if (dateStr === selectedDate) el.classList.add('selected');

    el.addEventListener('click', () => {
      selectedDate = dateStr;
      renderCalendar();
      loadDailyForDate(dateStr);
    });

    grid.appendChild(el);
  }
}

window.calendarPrev = function () {
  calendarMonth--;
  if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
  renderCalendar();
};

window.calendarNext = function () {
  calendarMonth++;
  if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
  renderCalendar();
};

window.calendarToday = function () {
  const now = new Date();
  calendarYear = now.getFullYear();
  calendarMonth = now.getMonth();
  selectedDate = getTodayStr();
  renderCalendar();
  loadDailyForDate(selectedDate);
};

window.loadDailyForSelected = function () {
  if (selectedDate) {
    loadCalendarDates().then(() => {
      renderCalendar();
      loadDailyForDate(selectedDate);
    });
  }
};

async function loadDailyForDate(dateStr) {
  const meta = $('daily-meta');
  const rows = $('daily-rows');
  const empty = $('daily-empty');
  meta.textContent = '加载中…';
  rows.innerHTML = '';
  empty.style.display = 'none';
  try {
    const res = await fetch(`/api/daily-analysis?date=${encodeURIComponent(dateStr)}`);
    const d = await res.json();
    if (!d.ok) throw new Error('API error');
    const entry = d.analysis;
    if (!entry) {
      meta.textContent = `日期：${d.date} · 暂无分析`;
      empty.style.display = 'block';
      return;
    }
    const genAt = new Date(entry.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    meta.textContent = `日期：${d.date} · 共 ${entry.newsCount} 条新闻 · 生成于 ${genAt} · 来源：${entry.source || '—'}`;
    rows.innerHTML = '';
    const DAILY_FIELDS = [
      ['市场概述', '市场概述'],
      ['主要主题', '主要主题'],
      ['利好资产', '利好资产'],
      ['利空资产', '利空资产'],
      ['核心驱动', '核心驱动'],
      ['明日关注', '明日关注'],
      ['风险提示', '风险提示'],
    ];
    const parsed = parseDailyAnalysis(entry.text);
    let hasAny = false;
    for (const [key, lbl] of DAILY_FIELDS) {
      if (parsed[key]) {
        hasAny = true;
        const row = document.createElement('div');
        row.className = 'daily-row';
        row.innerHTML = `<span class="daily-row-label">${esc(lbl)}：</span><span>${esc(parsed[key])}</span>`;
        rows.appendChild(row);
      }
    }
    if (!hasAny) {
      const raw = document.createElement('div');
      raw.className = 'daily-body-raw';
      raw.textContent = entry.text;
      rows.appendChild(raw);
    }
  } catch (e) {
    meta.textContent = `加载失败: ${e.message}`;
  }
}

function parseDailyAnalysis(text) {
  if (!text) return {};
  const result = {};
  const keys = ['市场概述', '主要主题', '利好资产', '利空资产', '核心驱动', '明日关注', '风险提示'];
  const lines = text.split('\n');
  let currentKey = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let matched = false;
    for (const k of keys) {
      if (trimmed.startsWith(k + '：') || trimmed.startsWith(k + ':')) {
        currentKey = k;
        result[k] = trimmed.slice(k.length + 1).trim();
        matched = true;
        break;
      }
    }
    if (!matched && currentKey && currentKey in result) {
      result[currentKey] += ' ' + trimmed;
    }
  }
  return result;
}

window.triggerDailyAnalysis = async function () {
  const date = selectedDate || getTodayStr();
  const btn = $('daily-trigger-btn');
  btn.disabled = true;
  btn.textContent = '生成中…';
  try {
    const res = await fetch('/api/daily-analysis/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date }),
    });
    const d = await res.json();
    $('daily-meta').textContent = d.message || '已触发，请稍后刷新';
  } catch (e) {
    $('daily-meta').textContent = `触发失败: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🤖 生成当日分析';
  }
};

// ── Initialize ───────────────────────────────────────────────────────────────
init();
