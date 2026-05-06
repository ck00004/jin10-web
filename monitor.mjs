#!/usr/bin/env node
/**
 * 金十红色新闻监控 - 入口文件
 */
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { getNewsAiProviders } from './lib/config.mjs';
import { log, logErr, acquireLock } from './lib/utils.mjs';
import { loadDedup, saveDedup, cleanDedup, getKey, loadState } from './lib/dedup.mjs';
import { isAd, isClickToView, isCalendarPreview } from './lib/filters.mjs';
import { analyze, buildTechnicalSummary } from './lib/ai.mjs';
import { appendNews, updateNewsByFlashId, markDeletedByFlashId, loadDailyAnalyses, saveDailyAnalysis, getTodayDateStr, generateDailyReport } from './lib/news.mjs';
import { startClsTelegraphMonitor } from './lib/cls-telegraph.mjs';
import { connectJin10WebSocket } from './lib/websocket.mjs';
import { startWebServer } from './lib/server.mjs';
import { logFlashNew, logFlashEdit, logFlashDelete } from './lib/flashlog.mjs';

let dedup = {};

/**
 * 统一快讯事件处理
 * @param {object} event - { action, item?, flashId?, content?, rawData, isHistory? }
 *   action=1: 新增 (item 有值)
 *   action=2: 修改 (flashId + content 有值)
 *   action=3: 删除 (flashId 有值)
 */
export function createProcessFlashEvent(overrides = {}) {
  const deps = {
    getNewsAiProviders,
    log,
    saveDedup,
    getKey,
    isAd,
    isClickToView,
    isCalendarPreview,
    analyze,
    buildTechnicalSummary,
    appendNews,
    updateNewsByFlashId,
    markDeletedByFlashId,
    logFlashNew,
    logFlashEdit,
    logFlashDelete,
    ...overrides,
  };

  return async function processFlashEvent(event, dedupRef, state) {
    const { action } = event;

    // ── action=2 修改 ──────────────────────────────────────────────────
    if (action === 2) {
      const { flashId, content } = event;
      deps.logFlashEdit(flashId, content);
      if (flashId) {
        deps.updateNewsByFlashId(flashId, content);
      }
      return;
    }

    // ── action=3 删除 ──────────────────────────────────────────────────
    if (action === 3) {
      const { flashId } = event;
      deps.logFlashDelete(flashId);
      if (flashId) {
        deps.markDeletedByFlashId(flashId);
      }
      return;
    }

    // ── action=1 新增 ──────────────────────────────────────────────────
    const { item } = event;
    const k = deps.getKey(item);

    // 去重：已处理过则跳过
    if (dedupRef[k]) return;

    // 先占位，避免 AI 分析或其他异步处理期间同一条消息重复进入。
    dedupRef[k] = { ts: Date.now(), pending: true };
    deps.saveDedup(dedupRef);

    // 写入快讯日志（所有快讯都记录）
    deps.logFlashNew(item);

    // 非红色新闻：直接存储，不做 AI 分析，不做过滤
    if (!item.important) {
      dedupRef[k] = { ts: Date.now() };
      deps.saveDedup(dedupRef);
      deps.appendNews({
        id: k, flashId: item.flashId, time: item.time, title: item.title, content: item.content,
        important: false, tags: item.tags, hotTag: item.hotTag, remarks: item.remarks,
        affect: item.affect, source: item.source, calendarData: item.calendarData,
        vipTitle: item.vipTitle, vipDesc: item.vipDesc, link: item.link,
        createdAt: Date.now(),
      });
      return;
    }

    // ── 以下仅针对红色（重要）新闻 ──────────────────────────────────

    // 广告过滤
    if (deps.isAd(item)) {
      deps.log(`  🚫 广告过滤: ${item.title?.substring(0,30)}`);
      dedupRef[k] = { ts: Date.now(), ad: true };
      deps.saveDedup(dedupRef);
      deps.appendNews({ id: k, flashId: item.flashId, time: item.time, title: item.title, content: item.content,
        important: true, skipped: true, skipReason: '广告',
        tags: item.tags, hotTag: item.hotTag, remarks: item.remarks, affect: item.affect, source: item.source,
        createdAt: Date.now() });
      return;
    }

    // 过滤「点击查看」占位内容
    if (deps.isClickToView(item)) {
      deps.log(`  🚫 点击查看过滤: ${item.time} ${item.title?.substring(0,30)}`);
      dedupRef[k] = { ts: Date.now(), click_to_view: true };
      deps.saveDedup(dedupRef);
      deps.appendNews({ id: k, flashId: item.flashId, time: item.time, title: item.title, content: item.content,
        important: true, skipped: true, skipReason: '点击查看',
        tags: item.tags, hotTag: item.hotTag, remarks: item.remarks, affect: item.affect, source: item.source,
        createdAt: Date.now() });
      return;
    }

    // 过滤「周度/日历/预告」类内容
    if (deps.isCalendarPreview(item)) {
      deps.log(`  🚫 日历/预告过滤: ${item.time} ${item.title?.substring(0, 30)}`);
      dedupRef[k] = { ts: Date.now(), calendar_preview: true };
      deps.saveDedup(dedupRef);
      deps.appendNews({ id: k, flashId: item.flashId, time: item.time, title: item.title, content: item.content,
        important: true, skipped: true, skipReason: '日历/预告',
        tags: item.tags, hotTag: item.hotTag, remarks: item.remarks, affect: item.affect, source: item.source,
        createdAt: Date.now() });
      return;
    }

    // 生成 AI 分析（仅红色新闻）
    let analysisText = '';
    let analysisSource = '';
    let analysisError = '';
    const AI_PROVIDERS = deps.getNewsAiProviders();
    if (AI_PROVIDERS.length > 0) {
      try {
        const res = await deps.analyze(item, state);
        analysisText = res?.text || '';
        analysisSource = res?.source || '';
        if (!analysisText) analysisError = '暂不可用';
      } catch (e) {
        analysisError = e?.message ? String(e.message).slice(0, 120) : '暂不可用';
      }
    }

    const technical = await deps.buildTechnicalSummary(analysisText);
    state.lastPushAt = Date.now();

    dedupRef[k] = { ts: Date.now() };
    deps.saveDedup(dedupRef);

    deps.appendNews({ id: k, flashId: item.flashId, time: item.time, title: item.title, content: item.content,
      important: true, analysis: analysisText, analysisSource, analysisError, technical,
      tags: item.tags, hotTag: item.hotTag, remarks: item.remarks,
      affect: item.affect, source: item.source, calendarData: item.calendarData,
      vipTitle: item.vipTitle, vipDesc: item.vipDesc, link: item.link,
      createdAt: Date.now() });

    deps.log(`  ✅ 已处理: ${item.time} (ID: ${item.flashId}) ${item.title?.substring(0,30) || item.content?.substring(0,30)}`);
  };
}

export const processFlashEvent = createProcessFlashEvent();

// 每日分析定时检查（每 10 分钟检查一次）
function startDailyAnalysisTimer() {
  setInterval(async () => {
    try {
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
      logErr(`每日分析定时检查: ${e.message}`);
    }
  }, 10 * 60_000);
}

// 去重定时清理（每小时清理一次）
function startDedupCleanTimer() {
  setInterval(() => {
    dedup = cleanDedup(dedup);
    saveDedup(dedup);
  }, 3600_000);
}

// 主程序
async function main() {
  acquireLock();
  log('🔴 金十监控启动 (WebSocket 模式)');
  startWebServer();
  startClsTelegraphMonitor();

  dedup = loadDedup();
  const state = loadState();

  startDailyAnalysisTimer();
  startDedupCleanTimer();
  connectJin10WebSocket(state, dedup, processFlashEvent, () => {
    dedup = cleanDedup(dedup);
    saveDedup(dedup);
  });
}

const isDirectRun = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch(e => { logErr(`crash: ${e.message}`); process.exit(1); });
}
