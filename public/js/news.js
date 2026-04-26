/**
 * Jin10 Monitor — News Page Application
 */
import { esc, fmtTime } from './utils.js';

// ── State ────────────────────────────────────────────────────────────────────
const SOURCE = document.body.dataset.source === 'cls' ? 'cls' : 'news';
const IS_CLS = SOURCE === 'cls';
let allItems = [];
let oldestCreatedAt = 0;
let oldestId = 0;
let hasMore = false;
let autoRefreshTimer = null;
let showSkipped = false;
let importantOnly = false;
const PAGE_SIZE = IS_CLS ? 30 : 20;

// ── DOM references ───────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ── Helpers ──────────────────────────────────────────────────────────────────
function skippedParam() {
  if (IS_CLS) return '';
  return showSkipped ? '&includeSkipped=1' : '';
}

function importantParam() {
  return importantOnly ? '&importantOnly=1' : '';
}

function getItemKey(item) {
  return String(item?.id || '');
}

function buildListUrl(reset = false) {
  if (IS_CLS) {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    if (importantOnly) params.set('importantOnly', '1');
    if (!reset && oldestCreatedAt > 0) {
      params.set('beforeCtime', String(oldestCreatedAt));
      params.set('beforeId', String(oldestId || 0));
    }
    return `/api/cls/telegraphs?${params.toString()}`;
  }

  const before = reset ? 0 : (oldestCreatedAt || 0);
  return `/api/news?limit=${PAGE_SIZE}&includeAnalysis=1${skippedParam()}${importantParam()}` + (before > 0 ? `&before=${before}` : '');
}

function setStatus(state, text) {
  $('status-dot').className = `status-dot ${state}`;
  $('status-text').textContent = text;
}

// ── Toggle handlers ──────────────────────────────────────────────────────────
window.toggleSkipped = function () {
  if (IS_CLS) return;
  showSkipped = !showSkipped;
  $('skipped-toggle').classList.toggle('active', showSkipped);
  loadNews(true);
};

window.toggleImportantOnly = function () {
  importantOnly = !importantOnly;
  $('important-toggle').classList.toggle('active', importantOnly);
  loadNews(true);
};

function reRenderAll() {
  const filtered = importantOnly ? allItems.filter(n => n.important === true) : allItems;
  const grid = $('news-grid');
  grid.innerHTML = '';
  if (filtered.length === 0) {
    grid.innerHTML = `<div class="loading-placeholder">${IS_CLS ? '📭 暂无匹配的电报数据' : '📭 暂无匹配的新闻数据'}</div>`;
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
  autoRefreshTimer = setInterval(() => {
    if (IS_CLS) {
      void pollClsPage();
      return;
    }
    void refresh();
  }, 30_000);
}

async function pollClsPage() {
  await loadNews(true);
  await updateStatusBar();
}

// ── Fetch news ───────────────────────────────────────────────────────────────
async function loadNews(reset = false) {
  const btn = $('refresh-btn');
  btn.disabled = true;

  try {
    const url = buildListUrl(reset);
    const res = await fetch(url);
    const data = await res.json();

    if (!data.ok) throw new Error('API error');

    const items = Array.isArray(data.items) ? data.items : [];
    if (reset) {
      allItems = items;
    } else {
      allItems = allItems.concat(items);
    }

    if (allItems.length > 0) {
      const lastItem = allItems[allItems.length - 1];
      oldestCreatedAt = Number(IS_CLS ? lastItem.ctime : lastItem.createdAt) || 0;
      oldestId = Number(lastItem.id || 0);
    }
    hasMore = data.hasMore;

    renderCards(items, !reset);
    $('load-more-wrap').style.display = hasMore ? 'block' : 'none';
    setStatus('ok', `共 ${data.total} 条${IS_CLS ? '电报' : ''} · ${fmtTime(new Date())}`);
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
    if (IS_CLS) {
      const syncRes = await fetch('/api/cls/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'both' }),
      });
      const syncData = await syncRes.json();
      if (!syncData.ok) throw new Error(syncData.error || 'sync failed');
    }

    const res = await fetch(buildListUrl(true));
    const data = await res.json();
    if (!data.ok) throw new Error('API error');

    const existingIds = new Set(allItems.map(getItemKey));
    const latestItems = Array.isArray(data.items) ? data.items : [];
    const newItems = latestItems.filter(n => !existingIds.has(getItemKey(n)));

    if (newItems.length > 0) {
      allItems = newItems.concat(allItems);
      renderCards(newItems, false, true);
    }

    hasMore = data.hasMore;
    $('load-more-wrap').style.display = hasMore ? 'block' : 'none';
    setStatus('ok', `共 ${data.total} 条${IS_CLS ? '电报' : ''} · ${fmtTime(new Date())}`);
    if (IS_CLS) {
      await updateStatusBar();
    }
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
      grid.innerHTML = `<div class="loading-placeholder">${IS_CLS ? '📭 暂无电报数据' : '📭 暂无新闻数据'}</div>`;
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
  if (IS_CLS) return buildClsCard(item);

  return buildNewsCard(item);
}

function buildNewsCard(item) {
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

function buildClsCard(item) {
  const card = document.createElement('div');
  const isImportant = item.important === true;
  const isRecovered = item.recovery === true;
  let cls = 'card news-card cls-card';
  if (isImportant) cls += ' important';
  if (isRecovered) cls += ' recovered';
  card.className = cls;
  card.dataset.id = item.id;

  const timeEl = document.createElement('div');
  timeEl.className = 'card-time';
  let timeHtml = esc(new Date(Number(item.ctime || 0) * 1000).toLocaleString('zh-CN', { hour12: false }));
  timeHtml += `<span class="flash-id">ID: ${esc(item.id)}</span>`;
  if (item.level) timeHtml += `<span class="badge badge-default">Level ${esc(item.level)}</span>`;
  if (isImportant) timeHtml += '<span class="badge badge-important">重要</span>';
  if (isRecovered) timeHtml += '<span class="badge badge-skip">Recovery</span>';
  if (Number(item.recommend || 0) === 1) timeHtml += '<span class="badge badge-hot">Recommend</span>';
  if (Number(item.jpush || 0) === 1) timeHtml += '<span class="badge badge-vip">JPush</span>';
  timeEl.innerHTML = timeHtml;
  card.appendChild(timeEl);

  if (item.title) {
    const titleEl = document.createElement('div');
    titleEl.className = 'card-title';
    titleEl.textContent = item.title;
    card.appendChild(titleEl);
  }

  const contentEl = document.createElement('div');
  contentEl.className = 'card-content';
  contentEl.textContent = item.content || '';
  card.appendChild(contentEl);

  if (item.shareurl) {
    const linkEl = document.createElement('div');
    linkEl.className = 'card-link';
    linkEl.innerHTML = `<a href="${esc(item.shareurl)}" target="_blank" rel="noreferrer">${esc(item.shareurl)}</a>`;
    card.appendChild(linkEl);
  }

  const subjects = Array.isArray(item.subjects) ? item.subjects : [];
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const stocks = Array.isArray(item.stock_list) ? item.stock_list : [];
  if (subjects.length > 0 || tags.length > 0 || stocks.length > 0) {
    const metaRow = document.createElement('div');
    metaRow.className = 'meta-row';

    for (const subject of subjects) {
      const chip = document.createElement('span');
      chip.className = 'meta-chip subject';
      chip.textContent = subject.subject_name || '';
      metaRow.appendChild(chip);
    }
    for (const tag of tags) {
      const chip = document.createElement('span');
      chip.className = 'meta-chip tag';
      chip.textContent = typeof tag === 'string' ? tag : (tag?.name || tag?.tag_name || tag?.title || '');
      metaRow.appendChild(chip);
    }
    for (const stock of stocks) {
      const chip = document.createElement('span');
      chip.className = 'meta-chip stock';
      const code = stock?.StockID || stock?.stock_id || stock?.secu_code || '';
      const name = stock?.name || stock?.secu_name || '';
      chip.textContent = name && code ? `${name} (${code})` : (name || code);
      metaRow.appendChild(chip);
    }

    card.appendChild(metaRow);
  }

  if (item.analysis) {
    card.appendChild(buildAiBlock(item.analysis, item.analysisSource, item.technical));
  } else if (item.analysisError) {
    const noAi = document.createElement('div');
    noAi.className = 'ai-block';
    noAi.innerHTML = `<div class="ai-no-analysis">🤖 AI 分析暂不可用：${esc(item.analysisError)}</div>`;
    card.appendChild(noAi);
  }

  if (isImportant) {
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const aiBtn = document.createElement('button');
    aiBtn.className = 'btn btn-secondary btn-sm';
    aiBtn.textContent = item.analysis ? '🔄 重新AI分析' : '🤖 AI分析';
    aiBtn.onclick = () => reanalyzeCls(item.id);
    actions.appendChild(aiBtn);
    card.appendChild(actions);
  }

  return card;
}

async function reanalyzeCls(id) {
  const card = document.querySelector(`.news-card[data-id="${CSS.escape(id)}"]`);
  const btn = card?.querySelector('.card-actions .btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '分析中…';
  }
  try {
    const res = await fetch('/api/cls/reanalyze', {
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

    const index = allItems.findIndex(item => String(item?.id || '') === String(id));
    if (index !== -1) {
      allItems[index] = {
        ...allItems[index],
        analysis: d.analysis || '',
        analysisSource: d.analysisSource || '',
        analysisError: d.analysisError || '',
        technical: d.technical || '',
      };
    }
  } catch (e) {
    alert(`CLS 重新AI分析失败: ${e.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔄 重新AI分析';
    }
  }
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
  if (IS_CLS) {
    try {
      const res = await fetch('/api/cls/status');
      const d = await res.json();
      if (d.ok) {
        const monitor = d.monitor || {};
        updateClsSummary(monitor);
        if (monitor.status === 'running') {
          setStatus('ok', `运行中 · update ${fmtTime(monitor.lastUpdateAt ? new Date(monitor.lastUpdateAt) : new Date())}`);
        } else if (monitor.status === 'degraded') {
          setStatus('warn', `降级运行 · ${monitor.lastError || '最近一次轮询失败'}`);
        } else if (monitor.status === 'error') {
          setStatus('err', monitor.lastError || '初始化失败');
        } else {
          setStatus('', '初始化中…');
        }
      }
    } catch {
      /* ignore */
    }
    return;
  }

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
  if (IS_CLS) return;
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

function updateClsSummary(monitor) {
  const statusEl = $('cls-summary-status');
  const newEl = $('cls-summary-new');
  const refreshEl = $('cls-summary-refresh');
  const windowEl = $('cls-summary-window');
  if (!statusEl || !newEl || !refreshEl || !windowEl) return;

  statusEl.textContent = monitor?.status || 'idle';
  newEl.textContent = String(monitor?.newNumber || 0);
  refreshEl.textContent = String(monitor?.lastRefreshTouchedCount || 0);
  const range = monitor?.lastRefreshRange;
  if (range?.startCtime && range?.endCtime) {
    windowEl.textContent = `${new Date(range.startCtime * 1000).toLocaleTimeString('zh-CN', { hour12: false })} - ${new Date(range.endCtime * 1000).toLocaleTimeString('zh-CN', { hour12: false })}`;
  } else {
    windowEl.textContent = '—';
  }
}

window.consumeNewItems = async function () {
  if (!IS_CLS) return;
  const btn = $('consume-btn');
  if (!btn) return;
  btn.disabled = true;
  try {
    await fetch('/api/cls/consume', { method: 'POST' });
    await updateStatusBar();
  } finally {
    btn.disabled = false;
  }
};

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
    const res = await fetch(`/api/daily-analysis/dates?source=${encodeURIComponent(SOURCE)}`);
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
    const res = await fetch(`/api/daily-analysis?date=${encodeURIComponent(dateStr)}&source=${encodeURIComponent(SOURCE)}`);
    const d = await res.json();
    if (!d.ok) throw new Error('API error');
    const entry = d.analysis;
    if (!entry) {
      meta.textContent = `日期：${d.date} · 暂无分析`;
      empty.style.display = 'block';
      return;
    }
    const genAt = new Date(entry.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const itemCount = entry.itemCount || entry.newsCount || 0;
    const itemLabel = entry.itemLabel || (IS_CLS ? '电报' : '新闻');
    meta.textContent = `日期：${d.date} · 共 ${itemCount} 条${itemLabel} · 生成于 ${genAt} · 数据源：${entry.dataSourceLabel || (IS_CLS ? 'CLS 电报' : '金十新闻')} · AI：${entry.source || '—'}`;
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
      body: JSON.stringify({ date, source: SOURCE }),
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
