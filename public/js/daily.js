const $ = (id) => document.getElementById(id);

const query = new URLSearchParams(window.location.search);
const SOURCE = query.get('source') === 'cls' ? 'cls' : 'news';
const SOURCE_LABEL = SOURCE === 'cls' ? 'CLS 电报' : '金十新闻';
const PAGE_LABEL = SOURCE === 'cls' ? '每日电报综合分析' : '每日新闻综合分析';

let calendarYear = new Date().getFullYear();
let calendarMonth = new Date().getMonth();
let calendarDatesWithAnalysis = new Set();
let selectedDate = '';

function setupPage() {
  document.title = `${SOURCE_LABEL} 每日分析`;
  $('daily-page-title').textContent = `📅 ${SOURCE_LABEL} 每日分析`;
  $('daily-panel-title').textContent = `📅 ${PAGE_LABEL}`;
  $('daily-page-note').textContent = `当前查看 ${SOURCE_LABEL} 的独立每日分析页面。`;
  $('daily-back-link').href = SOURCE === 'cls' ? '/cls.html' : '/';
}

function getTodayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
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
    for (const key of keys) {
      if (trimmed.startsWith(key + '：') || trimmed.startsWith(key + ':')) {
        currentKey = key;
        result[key] = trimmed.slice(key.length + 1).trim();
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

async function loadCalendarDates() {
  const res = await fetch(`/api/daily-analysis/dates?source=${encodeURIComponent(SOURCE)}`);
  const data = await res.json();
  if (data.ok) {
    calendarDatesWithAnalysis = new Set(data.dates || []);
  }
}

function renderCalendar() {
  const grid = $('calendar-grid');
  const label = $('calendar-month-label');
  grid.innerHTML = '';
  label.textContent = `${calendarYear} 年 ${calendarMonth + 1} 月`;

  const todayStr = getTodayStr();
  for (const wd of ['日', '一', '二', '三', '四', '五', '六']) {
    const el = document.createElement('div');
    el.className = 'calendar-weekday';
    el.textContent = wd;
    grid.appendChild(el);
  }

  const firstDay = new Date(calendarYear, calendarMonth, 1).getDay();
  const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  for (let i = 0; i < firstDay; i += 1) {
    const el = document.createElement('div');
    el.className = 'calendar-day empty';
    grid.appendChild(el);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateStr = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const el = document.createElement('div');
    el.className = 'calendar-day';
    el.textContent = String(day);
    if (dateStr === todayStr) el.classList.add('today');
    if (calendarDatesWithAnalysis.has(dateStr)) el.classList.add('has-analysis');
    if (dateStr === selectedDate) el.classList.add('selected');
    el.addEventListener('click', () => {
      selectedDate = dateStr;
      renderCalendar();
      void loadDailyForDate(dateStr);
    });
    grid.appendChild(el);
  }
}

async function loadDailyForDate(dateStr) {
  const meta = $('daily-meta');
  const rows = $('daily-rows');
  const empty = $('daily-empty');
  meta.textContent = '加载中…';
  rows.innerHTML = '';
  empty.style.display = 'none';

  try {
    const res = await fetch(`/api/daily-analysis?date=${encodeURIComponent(dateStr)}&source=${encodeURIComponent(SOURCE)}`);
    const data = await res.json();
    if (!data.ok) throw new Error('API error');
    const entry = data.analysis;
    if (!entry) {
      meta.textContent = `日期：${data.date} · 暂无分析`;
      empty.style.display = 'block';
      return;
    }
    const genAt = new Date(entry.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const itemCount = entry.itemCount || entry.newsCount || 0;
    const itemLabel = entry.itemLabel || (SOURCE === 'cls' ? '电报' : '新闻');
    meta.textContent = `日期：${data.date} · 共 ${itemCount} 条${itemLabel} · 生成于 ${genAt} · 数据源：${entry.dataSourceLabel || SOURCE_LABEL} · AI：${entry.source || '—'}`;

    const parsed = parseDailyAnalysis(entry.text);
    const fields = ['市场概述', '主要主题', '利好资产', '利空资产', '核心驱动', '明日关注', '风险提示'];
    let hasAny = false;
    for (const field of fields) {
      if (!parsed[field]) continue;
      hasAny = true;
      const row = document.createElement('div');
      row.className = 'daily-row';
      row.innerHTML = `<span class="daily-row-label">${field}：</span><span>${parsed[field]}</span>`;
      rows.appendChild(row);
    }
    if (!hasAny) {
      const raw = document.createElement('div');
      raw.className = 'daily-body-raw';
      raw.textContent = entry.text;
      rows.appendChild(raw);
    }
  } catch (error) {
    meta.textContent = `加载失败: ${error.message}`;
  }
}

window.calendarPrev = function () {
  calendarMonth -= 1;
  if (calendarMonth < 0) {
    calendarMonth = 11;
    calendarYear -= 1;
  }
  renderCalendar();
};

window.calendarNext = function () {
  calendarMonth += 1;
  if (calendarMonth > 11) {
    calendarMonth = 0;
    calendarYear += 1;
  }
  renderCalendar();
};

window.calendarToday = function () {
  const now = new Date();
  calendarYear = now.getFullYear();
  calendarMonth = now.getMonth();
  selectedDate = getTodayStr();
  renderCalendar();
  void loadDailyForDate(selectedDate);
};

window.loadDailyForSelected = function () {
  if (selectedDate) {
    void loadCalendarDates().then(() => {
      renderCalendar();
      return loadDailyForDate(selectedDate);
    });
  }
};

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
    const data = await res.json();
    $('daily-meta').textContent = data.message || '已触发，请稍后刷新';
  } catch (error) {
    $('daily-meta').textContent = `触发失败: ${error.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🤖 生成当日分析';
  }
};

setupPage();
await loadCalendarDates();
selectedDate = getTodayStr();
renderCalendar();
await loadDailyForDate(selectedDate);