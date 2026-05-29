/**
 * 财联社电报监控模块
 */
import Database from 'better-sqlite3';
import { DB_FILE } from './config.mjs';
import { analyze, buildTechnicalSummary } from './ai.mjs';
import { loadState } from './dedup.mjs';
import { log, logErr } from './utils.mjs';

const CACHE_URL = 'https://www.cls.cn/api/cache';
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const HTTP_TIMEOUT_MS = 15_000;
const UPDATE_INTERVAL_OK = 10_000;
const UPDATE_INTERVAL_FAIL = 30_000;
const REFRESH_INTERVAL_OK = 20_000;
const REFRESH_INTERVAL_FAIL = 60_000;
const MAX_IN_MEMORY = 2000;

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS cls_telegraphs (
    id INTEGER PRIMARY KEY,
    ctime INTEGER NOT NULL,
    firstSeenAt INTEGER NOT NULL,
    lastSeenAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    recovery INTEGER,
    important INTEGER NOT NULL,
    level TEXT,
    level_rank INTEGER NOT NULL,
    title TEXT,
    content TEXT,
    shareurl TEXT,
    subjects_json TEXT,
    tags_json TEXT,
    stocks_json TEXT,
    subjects_text TEXT,
    tags_text TEXT,
    stock_codes_text TEXT,
    stock_names_text TEXT,
    raw_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cls_telegraphs_ctime ON cls_telegraphs(ctime DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_cls_telegraphs_important ON cls_telegraphs(important, ctime DESC);
  CREATE INDEX IF NOT EXISTS idx_cls_telegraphs_level_rank ON cls_telegraphs(level_rank DESC, ctime DESC);
`);

const upsertTelegraphStmt = db.prepare(`
  INSERT INTO cls_telegraphs (
    id, ctime, firstSeenAt, lastSeenAt, updatedAt, recovery,
    important, level, level_rank, title, content, shareurl,
    subjects_json, tags_json, stocks_json,
    subjects_text, tags_text, stock_codes_text, stock_names_text,
    raw_json
  ) VALUES (
    @id, @ctime, @firstSeenAt, @lastSeenAt, @updatedAt, @recovery,
    @important, @level, @level_rank, @title, @content, @shareurl,
    @subjects_json, @tags_json, @stocks_json,
    @subjects_text, @tags_text, @stock_codes_text, @stock_names_text,
    @raw_json
  )
  ON CONFLICT(id) DO UPDATE SET
    ctime = excluded.ctime,
    lastSeenAt = excluded.lastSeenAt,
    updatedAt = excluded.updatedAt,
    recovery = excluded.recovery,
    important = excluded.important,
    level = excluded.level,
    level_rank = excluded.level_rank,
    title = excluded.title,
    content = excluded.content,
    shareurl = excluded.shareurl,
    subjects_json = excluded.subjects_json,
    tags_json = excluded.tags_json,
    stocks_json = excluded.stocks_json,
    subjects_text = excluded.subjects_text,
    tags_text = excluded.tags_text,
    stock_codes_text = excluded.stock_codes_text,
    stock_names_text = excluded.stock_names_text,
    raw_json = excluded.raw_json
`);

const selectTelegraphRowStmt = db.prepare(`
  SELECT id, ctime, firstSeenAt, lastSeenAt, updatedAt, recovery, important, level_rank, raw_json
  FROM cls_telegraphs
  WHERE id = ?
  LIMIT 1
`);

const updateTelegraphRawStmt = db.prepare(`
  UPDATE cls_telegraphs
  SET updatedAt = @updatedAt,
      raw_json = @raw_json
  WHERE id = @id
`);

const persistTelegraphsTxn = db.transaction((items, timestamp) => {
  for (const item of items) {
    const row = buildTelegraphRow(item, timestamp);
    if (!row) continue;
    upsertTelegraphStmt.run(row);
  }
});

const runtime = {
  started: false,
  initialized: false,
  initializing: false,
  startAt: null,
  lastInitAt: null,
  lastUpdateAt: null,
  lastRefreshAt: null,
  lastConsumeAt: null,
  lastErrorAt: null,
  lastError: '',
  status: 'idle',
  updateFailConsecutive: 0,
  refreshFailConsecutive: 0,
  updateOk: 0,
  updateFail: 0,
  refreshOk: 0,
  refreshFail: 0,
  lastUpdateFreshCount: 0,
  lastUpdatePayloadCount: 0,
  lastRefreshTouchedCount: 0,
  lastRefreshRange: null,
  telegraphList: [],
  telegraphTemp: [],
  newNumber: 0,
  seenIds: new Set(),
  timers: {
    bootstrap: null,
    update: null,
    refresh: null,
  },
  inFlight: {
    update: false,
    refresh: false,
  },
};

const PERSISTED_ANALYSIS_FIELDS = ['analysis', 'analysisSource', 'analysisError', 'technical'];

function parseLevelRank(level) {
  const order = { S: 5, A: 4, B: 3, C: 2, D: 1 };
  if (!level) return 0;
  return order[String(level).toUpperCase()] || 0;
}

function isImportantItem(item) {
  const level = String(item?.level || '').toUpperCase();
  return Boolean(
    Number(item?.bold || 0) === 1
      || Number(item?.recommend || 0) === 1
      || Number(item?.jpush || 0) === 1
      || ['S', 'A', 'B'].includes(level)
  );
}

function subjectNames(item) {
  const result = [];
  for (const subject of item?.subjects || []) {
    const name = subject?.subject_name;
    if (name) result.push(String(name));
  }
  return result;
}

function tagNames(item) {
  const result = [];
  for (const tag of item?.tags || []) {
    if (tag && typeof tag === 'object') {
      const name = tag.name || tag.tag_name || tag.title;
      if (name) result.push(String(name));
      continue;
    }
    if (tag) result.push(String(tag));
  }
  return result;
}

function stockCodes(item) {
  const result = [];
  for (const stock of item?.stock_list || []) {
    const code = stock?.StockID || stock?.stock_id || stock?.secu_code;
    if (code) result.push(String(code));
  }
  return result;
}

function stockNames(item) {
  const result = [];
  for (const stock of item?.stock_list || []) {
    const name = stock?.name || stock?.secu_name;
    if (name) result.push(String(name));
  }
  return result;
}

function normalizeLikeValue(value) {
  const text = String(value || '').trim();
  return text ? `%${text}%` : '';
}

function normalizeQueryOptions(options = {}) {
  return {
    limit: Math.min(Math.max(parseInt(String(options.limit || '30'), 10) || 30, 1), 200),
    beforeCtime: Number(options.beforeCtime || 0),
    beforeId: Number(options.beforeId || 0),
    startCtime: Number(options.startCtime || 0),
    endCtime: Number(options.endCtime || 0),
    importantOnly: options.importantOnly === true || options.importantOnly === '1',
    onlyRecovered: options.onlyRecovered === true || options.onlyRecovered === '1',
    minLevel: String(options.minLevel || '').trim().toUpperCase(),
    subject: String(options.subject || '').trim(),
    tag: String(options.tag || '').trim(),
    stock: String(options.stock || '').trim(),
    keyword: String(options.keyword || '').trim(),
    source: String(options.source || 'all').trim(),
  };
}

function matchesFilters(item, options = {}) {
  const normalized = normalizeQueryOptions(options);
  if (normalized.importantOnly && !isImportantItem(item)) return false;
  if (normalized.onlyRecovered && item?.recovery !== true) return false;
  if (normalized.minLevel && parseLevelRank(item?.level) < parseLevelRank(normalized.minLevel)) return false;
  if (normalized.subject && !subjectNames(item).some(name => name.includes(normalized.subject))) return false;
  if (normalized.tag && !tagNames(item).some(name => name.includes(normalized.tag))) return false;
  if (normalized.stock) {
    const keyword = normalized.stock.toLowerCase();
    const codeMatch = stockCodes(item).some(code => code.toLowerCase().includes(keyword));
    const nameMatch = stockNames(item).some(name => name.toLowerCase().includes(keyword));
    if (!codeMatch && !nameMatch) return false;
  }
  if (normalized.keyword) {
    const haystack = [item?.title || '', item?.content || ''].join(' ').toLowerCase();
    if (!haystack.includes(normalized.keyword.toLowerCase())) return false;
  }
  return true;
}

function buildTelegraphRow(item, timestamp) {
  const id = Number(item?.id || 0);
  if (!id) return null;
  const mergedItem = mergePersistedAnalysisFields(item);
  const subjects = subjectNames(item);
  const tags = tagNames(item);
  const codes = stockCodes(item);
  const names = stockNames(item);
  return {
    id,
    ctime: Number(mergedItem?.ctime || 0),
    firstSeenAt: Number(timestamp),
    lastSeenAt: Number(timestamp),
    updatedAt: Number(timestamp),
    recovery: mergedItem?.recovery == null ? null : (mergedItem.recovery ? 1 : 0),
    important: isImportantItem(mergedItem) ? 1 : 0,
    level: mergedItem?.level ? String(mergedItem.level) : '',
    level_rank: parseLevelRank(mergedItem?.level),
    title: String(mergedItem?.title || ''),
    content: String(mergedItem?.content || ''),
    shareurl: String(mergedItem?.shareurl || ''),
    subjects_json: JSON.stringify(mergedItem?.subjects || []),
    tags_json: JSON.stringify(mergedItem?.tags || []),
    stocks_json: JSON.stringify(mergedItem?.stock_list || []),
    subjects_text: subjects.join(' '),
    tags_text: tags.join(' '),
    stock_codes_text: codes.join(' '),
    stock_names_text: names.join(' '),
    raw_json: JSON.stringify(mergedItem),
  };
}

function getStoredRawItem(id) {
  const row = selectTelegraphRowStmt.get(Number(id || 0));
  if (!row?.raw_json) return null;
  try {
    return JSON.parse(row.raw_json);
  } catch {
    return null;
  }
}

function mergePersistedAnalysisFields(item) {
  const id = Number(item?.id || 0);
  if (!id) return item;
  const existing = getStoredRawItem(id);
  if (!existing) return item;
  const merged = { ...existing, ...item };
  for (const field of PERSISTED_ANALYSIS_FIELDS) {
    if (merged[field] == null && existing[field] != null) {
      merged[field] = existing[field];
    }
  }
  return merged;
}

function updateRuntimeTelegraph(id, updates) {
  const numericId = Number(id || 0);
  if (!numericId) return;
  const syncList = (list) => {
    const index = list.findIndex(item => Number(item?.id || 0) === numericId);
    if (index === -1) return;
    list[index] = { ...list[index], ...updates };
  };
  syncList(runtime.telegraphList);
  syncList(runtime.telegraphTemp);
}

function updateClsTelegraphAnalysis(id, updates) {
  const numericId = Number(id || 0);
  if (!numericId) return null;
  const existing = getStoredRawItem(numericId);
  if (!existing) return null;
  const nextItem = { ...existing, ...updates };
  updateTelegraphRawStmt.run({
    id: numericId,
    updatedAt: Date.now(),
    raw_json: JSON.stringify(nextItem),
  });
  updateRuntimeTelegraph(numericId, updates);
  return nextItem;
}

async function buildTelegraphAnalysisPayload(item) {
  let analysis = '';
  let analysisSource = '';
  let analysisError = '';
  const state = loadState();

  try {
    const result = await analyze(item, state);
    analysis = result?.text || '';
    analysisSource = result?.source || '';
    if (!analysis) {
      analysisError = '暂不可用';
    }
  } catch (error) {
    analysisError = error?.message ? String(error.message).slice(0, 120) : '暂不可用';
  }

  return {
    analysis,
    analysisSource,
    analysisError,
    technical: analysis ? buildTechnicalSummary(analysis) : '',
  };
}

async function autoAnalyzeClsTelegraphs(items, reason = 'auto') {
  const candidates = (items || []).filter(item => isImportantItem(item) && !item.analysis);
  for (const item of candidates) {
    const payload = await buildTelegraphAnalysisPayload(item);
    updateClsTelegraphAnalysis(item.id, payload);
    if (payload.analysis) {
      log(`🤖 CLS AI (${reason}): ${item.id} 分析完成`);
    }
  }
}

function persistTelegraphs(items) {
  if (!Array.isArray(items) || items.length === 0) return;
  const uniqueItems = [];
  const seen = new Set();
  for (const item of items) {
    const id = Number(item?.id || 0);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniqueItems.push(item);
  }
  if (uniqueItems.length === 0) return;
  persistTelegraphsTxn(uniqueItems, Date.now());
}

function trimMemoryList(list) {
  return list.length > MAX_IN_MEMORY ? list.slice(0, MAX_IN_MEMORY) : list;
}

async function httpGetJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://www.cls.cn/telegraph',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function firstCtime() {
  if (runtime.telegraphList.length > 0) {
    return Number(runtime.telegraphList[0]?.ctime || Math.floor(Date.now() / 1000));
  }
  return Math.floor(Date.now() / 1000);
}

function buildCacheUrl(name, params = {}) {
  const query = new URLSearchParams({ name: String(name || '') });
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    query.set(key, String(value));
  }
  return `${CACHE_URL}?${query.toString()}`;
}

function normalizeCachePayload(payload, endpointName) {
  if (Number(payload?.errno ?? -1) !== 0) {
    throw new Error(`${endpointName} returned error payload`);
  }
  const data = payload?.data || {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${endpointName} returned invalid data`);
  }
  return data;
}

function refreshMappingToRollData(payload) {
  const mapping = payload?.l || {};
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new Error('refreshTenTelegraph returned invalid mapping');
  }

  const rollData = Object.values(mapping).filter(item => item && typeof item === 'object');
  rollData.sort((left, right) => Number(right?.ctime || 0) - Number(left?.ctime || 0));
  return rollData;
}

function buildUpdateUrl() {
  return buildCacheUrl('refreshTenTelegraph', {
    lastTime: Math.floor(Date.now() / 1000),
  });
}

function buildRefreshUrl() {
  return buildCacheUrl('refreshTenTelegraph', { lastTime: firstCtime() });
}

function mergeNewItemsIntoHead(currentList, newItems) {
  const merged = [...currentList];
  const telegraphTemp = [];
  const existingIds = new Set(merged.map(item => Number(item?.id || 0)).filter(Boolean));

  for (const item of newItems) {
    const itemId = Number(item?.id || 0);
    if (!itemId || existingIds.has(itemId)) continue;
    merged.unshift(item);
    telegraphTemp.unshift(item);
    existingIds.add(itemId);
  }

  return {
    merged: trimMemoryList(merged),
    telegraphTemp,
  };
}

function applyUpdatePayload(payload) {
  const data = normalizeCachePayload(payload, 'refreshTenTelegraph');
  const rollData = refreshMappingToRollData(data);
  const { merged, telegraphTemp } = mergeNewItemsIntoHead(runtime.telegraphList, rollData);

  runtime.telegraphList = merged;
  runtime.telegraphTemp = telegraphTemp;

  const freshItems = [];
  for (const item of rollData) {
    const itemId = Number(item?.id || 0);
    if (!itemId || runtime.seenIds.has(itemId)) continue;
    runtime.seenIds.add(itemId);
    freshItems.push(item);
  }
  runtime.newNumber += freshItems.length;
  freshItems.sort((left, right) => Number(left?.ctime || 0) - Number(right?.ctime || 0));
  return {
    rollData,
    freshItems,
  };
}

function applyRefreshPayload(payload) {
  const data = normalizeCachePayload(payload, 'refreshTenTelegraph');
  const mapping = data?.l || {};
  const startCtime = Number(data?.i || 0);
  const endCtime = Number(data?.a || 0);
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new Error('refreshTenTelegraph returned invalid mapping');
  }

  const mappingCopy = Object.fromEntries(
    Object.entries(mapping).map(([key, value]) => [String(key), { ...(value || {}) }])
  );
  const mergedList = [];
  const touched = new Map();

  for (const item of runtime.telegraphList) {
    const itemCtime = Number(item?.ctime || 0);
    if (itemCtime >= startCtime && itemCtime <= endCtime) {
      const key = String(item?.id || '');
      if (key && mappingCopy[key]) {
        const refreshedItem = { ...item, ...mappingCopy[key], recovery: false };
        mergedList.push(refreshedItem);
        touched.set(Number(refreshedItem.id), refreshedItem);
        mappingCopy[key].isExistence = true;
      } else {
        const recoveredItem = { ...item, recovery: true };
        mergedList.push(recoveredItem);
        touched.set(Number(recoveredItem.id), recoveredItem);
      }
    } else {
      mergedList.push(item);
    }
  }

  for (const value of Object.values(mappingCopy)) {
    if (value?.isExistence) continue;
    const candidate = { ...value, recovery: false };
    const candidateId = Number(candidate?.id || 0);
    if (!candidateId) continue;
    let inserted = false;
    const candidateCtime = Number(candidate?.ctime || 0);
    for (let index = 0; index < mergedList.length; index += 1) {
      if (candidateCtime > Number(mergedList[index]?.ctime || 0)) {
        mergedList.splice(index, 0, candidate);
        inserted = true;
        break;
      }
    }
    if (!inserted) mergedList.push(candidate);
    touched.set(candidateId, candidate);
  }

  runtime.telegraphList = trimMemoryList(mergedList);
  return {
    touchedItems: [...touched.values()],
    range: { startCtime, endCtime },
  };
}

async function initializeStateFromApi() {
  runtime.initializing = true;
  runtime.status = 'initializing';
  try {
    const payload = normalizeCachePayload(
      await httpGetJson(buildCacheUrl('refreshTenTelegraph', { lastTime: Math.floor(Date.now() / 1000) })),
      'refreshTenTelegraph'
    );
    const rollData = refreshMappingToRollData(payload);
    runtime.telegraphList = trimMemoryList([...rollData]);
    runtime.telegraphTemp = [];
    runtime.newNumber = 0;
    runtime.seenIds = new Set(rollData.map(item => Number(item?.id || 0)).filter(Boolean));
    runtime.initialized = true;
    runtime.lastInitAt = Date.now();
    runtime.status = 'running';
    persistTelegraphs(rollData);
    void autoAnalyzeClsTelegraphs(rollData, 'bootstrap');
    log(`⚡ CLS 电报监控初始化完成，首屏 ${rollData.length} 条`);
  } finally {
    runtime.initializing = false;
  }
}

function scheduleBootstrap(delayMs) {
  clearTimeout(runtime.timers.bootstrap);
  runtime.timers.bootstrap = setTimeout(async () => {
    try {
      await initializeStateFromApi();
      scheduleUpdate(0);
      scheduleRefresh(0);
    } catch (error) {
      runtime.status = 'error';
      runtime.lastErrorAt = Date.now();
      runtime.lastError = `bootstrap failed: ${error.message}`;
      logErr(`CLS 初始化失败: ${error.message}`);
      scheduleBootstrap(REFRESH_INTERVAL_FAIL);
    }
  }, delayMs);
}

function scheduleUpdate(delayMs) {
  clearTimeout(runtime.timers.update);
  runtime.timers.update = setTimeout(() => {
    void runUpdateCycle('timer');
  }, delayMs);
}

function scheduleRefresh(delayMs) {
  clearTimeout(runtime.timers.refresh);
  runtime.timers.refresh = setTimeout(() => {
    void runRefreshCycle('timer');
  }, delayMs);
}

async function ensureInitialized() {
  if (runtime.initialized) return;
  if (runtime.initializing) {
    throw new Error('CLS monitor is still initializing');
  }
  await initializeStateFromApi();
}

function setLastError(prefix, error) {
  runtime.lastErrorAt = Date.now();
  runtime.lastError = `${prefix}: ${error.message}`;
}

async function runUpdateCycle(reason = 'timer') {
  if (runtime.inFlight.update) {
    return { ok: true, skipped: 'update_in_flight' };
  }
  runtime.inFlight.update = true;
  try {
    await ensureInitialized();
    const payload = await httpGetJson(buildUpdateUrl());
    const { rollData, freshItems } = applyUpdatePayload(payload);
    persistTelegraphs(rollData);
    void autoAnalyzeClsTelegraphs(freshItems, 'update');

    runtime.lastUpdateAt = Date.now();
    runtime.lastUpdateFreshCount = freshItems.length;
    runtime.lastUpdatePayloadCount = rollData.length;
    runtime.updateOk += 1;
    runtime.updateFailConsecutive = 0;
    runtime.status = 'running';
    scheduleUpdate(UPDATE_INTERVAL_OK);
    if (reason === 'manual') {
      log(`⚡ CLS 手动 update 完成，返回 ${rollData.length} 条，新增 ${freshItems.length} 条`);
    }
    return { ok: true, freshCount: freshItems.length, payloadCount: rollData.length };
  } catch (error) {
    runtime.updateFail += 1;
    runtime.updateFailConsecutive += 1;
    runtime.status = 'degraded';
    setLastError('update failed', error);
    logErr(`CLS update 失败: ${error.message}`);
    scheduleUpdate(UPDATE_INTERVAL_FAIL);
    return { ok: false, error: error.message };
  } finally {
    runtime.inFlight.update = false;
  }
}

async function runRefreshCycle(reason = 'timer') {
  if (runtime.inFlight.refresh) {
    return { ok: true, skipped: 'refresh_in_flight' };
  }
  runtime.inFlight.refresh = true;
  try {
    await ensureInitialized();
    const payload = await httpGetJson(buildRefreshUrl());
    const { touchedItems, range } = applyRefreshPayload(payload);
    persistTelegraphs(touchedItems);

    runtime.lastRefreshAt = Date.now();
    runtime.lastRefreshTouchedCount = touchedItems.length;
    runtime.lastRefreshRange = range;
    runtime.refreshOk += 1;
    runtime.refreshFailConsecutive = 0;
    runtime.status = 'running';
    scheduleRefresh(REFRESH_INTERVAL_OK);
    if (reason === 'manual') {
      log(`⚡ CLS 手动 refresh 完成，修正 ${touchedItems.length} 条`);
    }
    return { ok: true, touchedCount: touchedItems.length, range };
  } catch (error) {
    runtime.refreshFail += 1;
    runtime.refreshFailConsecutive += 1;
    runtime.status = 'degraded';
    setLastError('refresh failed', error);
    logErr(`CLS refresh 失败: ${error.message}`);
    scheduleRefresh(REFRESH_INTERVAL_FAIL);
    return { ok: false, error: error.message };
  } finally {
    runtime.inFlight.refresh = false;
  }
}

function formatRuntimeItem(item) {
  return {
    ...item,
    important: isImportantItem(item),
    subjects: Array.isArray(item?.subjects) ? item.subjects : [],
    tags: Array.isArray(item?.tags) ? item.tags : [],
    stock_list: Array.isArray(item?.stock_list) ? item.stock_list : [],
  };
}

function formatStoredItem(row) {
  if (!row) return null;
  const rawItem = JSON.parse(row.raw_json);
  return {
    ...formatRuntimeItem(rawItem),
    persisted: {
      firstSeenAt: Number(row.firstSeenAt || 0),
      lastSeenAt: Number(row.lastSeenAt || 0),
      updatedAt: Number(row.updatedAt || 0),
      recovery: row.recovery == null ? null : row.recovery === 1,
      important: row.important === 1,
      levelRank: Number(row.level_rank || 0),
    },
  };
}

function queryRuntimeTemp(options = {}) {
  const normalized = normalizeQueryOptions(options);
  const filtered = runtime.telegraphTemp
    .filter(item => matchesFilters(item, normalized))
    .sort((left, right) => {
      const ctimeDiff = Number(right?.ctime || 0) - Number(left?.ctime || 0);
      if (ctimeDiff !== 0) return ctimeDiff;
      return Number(right?.id || 0) - Number(left?.id || 0);
    });
  const items = filtered.slice(0, normalized.limit).map(formatRuntimeItem);
  return {
    items,
    total: filtered.length,
    hasMore: filtered.length > normalized.limit,
  };
}

export function queryClsTelegraphs(options = {}) {
  const normalized = normalizeQueryOptions(options);
  if (normalized.source === 'temp') {
    return queryRuntimeTemp(normalized);
  }

  const baseWhereClauses = [];
  const baseParams = {};

  if (normalized.importantOnly) {
    baseWhereClauses.push('important = 1');
  }
  if (normalized.onlyRecovered) {
    baseWhereClauses.push('recovery = 1');
  }
  if (normalized.startCtime > 0) {
    baseWhereClauses.push('ctime >= @startCtime');
    baseParams.startCtime = normalized.startCtime;
  }
  if (normalized.endCtime > 0) {
    baseWhereClauses.push('ctime <= @endCtime');
    baseParams.endCtime = normalized.endCtime;
  }
  if (normalized.minLevel) {
    baseWhereClauses.push('level_rank >= @minLevelRank');
    baseParams.minLevelRank = parseLevelRank(normalized.minLevel);
  }
  if (normalized.subject) {
    baseWhereClauses.push('subjects_text LIKE @subjectLike');
    baseParams.subjectLike = normalizeLikeValue(normalized.subject);
  }
  if (normalized.tag) {
    baseWhereClauses.push('tags_text LIKE @tagLike');
    baseParams.tagLike = normalizeLikeValue(normalized.tag);
  }
  if (normalized.stock) {
    baseWhereClauses.push('(stock_codes_text LIKE @stockLike OR stock_names_text LIKE @stockLike)');
    baseParams.stockLike = normalizeLikeValue(normalized.stock);
  }
  if (normalized.keyword) {
    baseWhereClauses.push('(title LIKE @keywordLike OR content LIKE @keywordLike)');
    baseParams.keywordLike = normalizeLikeValue(normalized.keyword);
  }

  const baseWhereSql = baseWhereClauses.length > 0 ? `WHERE ${baseWhereClauses.join(' AND ')}` : '';
  const totalRow = db.prepare(`SELECT COUNT(*) AS count FROM cls_telegraphs ${baseWhereSql}`).get(baseParams);

  const pageWhereClauses = [...baseWhereClauses];
  const pageParams = { ...baseParams };
  if (normalized.beforeCtime > 0) {
    pageWhereClauses.push('(ctime < @beforeCtime OR (ctime = @beforeCtime AND id < @beforeId))');
    pageParams.beforeCtime = normalized.beforeCtime;
    pageParams.beforeId = normalized.beforeId > 0 ? normalized.beforeId : Number.MAX_SAFE_INTEGER;
  }

  const pageWhereSql = pageWhereClauses.length > 0 ? `WHERE ${pageWhereClauses.join(' AND ')}` : '';
  const poolCountRow = db.prepare(`SELECT COUNT(*) AS count FROM cls_telegraphs ${pageWhereSql}`).get(pageParams);
  const rows = db.prepare(`
    SELECT id, ctime, firstSeenAt, lastSeenAt, updatedAt, recovery, important, level_rank, raw_json
    FROM cls_telegraphs
    ${pageWhereSql}
    ORDER BY ctime DESC, id DESC
    LIMIT @limit
  `).all({ ...pageParams, limit: normalized.limit });

  const items = rows.map(formatStoredItem);
  return {
    items,
    total: Number(totalRow?.count || 0),
    hasMore: Number(poolCountRow?.count || 0) > normalized.limit,
  };
}

export function getClsTelegraphDetail(id) {
  const numericId = Number(id || 0);
  if (!numericId) return null;
  const row = db.prepare(`
    SELECT id, ctime, firstSeenAt, lastSeenAt, updatedAt, recovery, important, level_rank, raw_json
    FROM cls_telegraphs
    WHERE id = ?
    LIMIT 1
  `).get(numericId);
  return formatStoredItem(row);
}

export async function reanalyzeClsTelegraph(id) {
  const current = getClsTelegraphDetail(id);
  if (!current) return null;
  const payload = await buildTelegraphAnalysisPayload(current);
  const updated = updateClsTelegraphAnalysis(id, payload);
  return updated ? formatRuntimeItem(updated) : null;
}

export function exportClsTelegraphs(options = {}) {
  const normalized = normalizeQueryOptions(options);
  const limit = Math.min(Math.max(parseInt(String(options.limit || '200'), 10) || 200, 1), 2000);
  const result = queryClsTelegraphs({
    ...normalized,
    limit,
  });
  const lastItem = result.items[result.items.length - 1] || null;
  return {
    exportedAt: Date.now(),
    count: result.items.length,
    total: result.total,
    hasMore: result.hasMore,
    nextCursor: lastItem ? {
      beforeCtime: Number(lastItem.ctime || 0),
      beforeId: Number(lastItem.id || 0),
    } : null,
    items: result.items,
  };
}

export function getDayClsTelegraphs(dateStr) {
  const normalizedDate = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) return [];
  const startMs = Date.parse(`${normalizedDate}T00:00:00+08:00`);
  const endMs = Date.parse(`${normalizedDate}T23:59:59+08:00`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];

  const rows = db.prepare(`
    SELECT id, ctime, firstSeenAt, lastSeenAt, updatedAt, recovery, important, level_rank, raw_json
    FROM cls_telegraphs
    WHERE ctime >= ? AND ctime <= ?
    ORDER BY ctime DESC, id DESC
  `).all(Math.floor(startMs / 1000), Math.floor(endMs / 1000));

  return rows.map(formatStoredItem);
}

export function getClsMonitorStatus() {
  const firstItem = runtime.telegraphList[0] || null;
  return {
    started: runtime.started,
    initialized: runtime.initialized,
    initializing: runtime.initializing,
    status: runtime.status,
    startAt: runtime.startAt,
    lastInitAt: runtime.lastInitAt,
    lastUpdateAt: runtime.lastUpdateAt,
    lastRefreshAt: runtime.lastRefreshAt,
    lastConsumeAt: runtime.lastConsumeAt,
    lastErrorAt: runtime.lastErrorAt,
    lastError: runtime.lastError,
    updateOk: runtime.updateOk,
    updateFail: runtime.updateFail,
    refreshOk: runtime.refreshOk,
    refreshFail: runtime.refreshFail,
    updateFailConsecutive: runtime.updateFailConsecutive,
    refreshFailConsecutive: runtime.refreshFailConsecutive,
    lastUpdateFreshCount: runtime.lastUpdateFreshCount,
    lastUpdatePayloadCount: runtime.lastUpdatePayloadCount,
    lastRefreshTouchedCount: runtime.lastRefreshTouchedCount,
    lastRefreshRange: runtime.lastRefreshRange,
    telegraphListCount: runtime.telegraphList.length,
    telegraphTempCount: runtime.telegraphTemp.length,
    newNumber: runtime.newNumber,
    firstItemId: firstItem?.id || null,
    firstItemCtime: firstItem?.ctime || null,
    inFlight: { ...runtime.inFlight },
  };
}

export function consumeClsTelegraphNewItems() {
  const consumed = {
    newNumber: runtime.newNumber,
    tempCount: runtime.telegraphTemp.length,
  };
  runtime.newNumber = 0;
  runtime.telegraphTemp = [];
  runtime.lastConsumeAt = Date.now();
  return consumed;
}

export async function triggerClsTelegraphSync(mode = 'both') {
  const normalizedMode = ['update', 'refresh', 'both'].includes(mode) ? mode : 'both';
  const result = { mode: normalizedMode, update: null, refresh: null };
  if (normalizedMode === 'update' || normalizedMode === 'both') {
    result.update = await runUpdateCycle('manual');
  }
  if (normalizedMode === 'refresh' || normalizedMode === 'both') {
    result.refresh = await runRefreshCycle('manual');
  }
  return {
    ok: true,
    result,
    status: getClsMonitorStatus(),
  };
}

export function startClsTelegraphMonitor() {
  if (runtime.started) return runtime;
  runtime.started = true;
  runtime.startAt = Date.now();
  scheduleBootstrap(0);
  return runtime;
}