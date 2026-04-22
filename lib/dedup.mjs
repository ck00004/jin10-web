/**
 * 去重与状态管理模块
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { DEDUP_FILE, STATE_FILE, DEDUP_HOURS } from './config.mjs';

export function loadDedup() {
  if (!existsSync(DEDUP_FILE)) return {};
  try { return JSON.parse(readFileSync(DEDUP_FILE, 'utf-8')); } catch { return {}; }
}

export function saveDedup(d) { writeFileSync(DEDUP_FILE, JSON.stringify(d, null, 2)); }

export function cleanDedup(d) {
  const cut = Date.now() - DEDUP_HOURS * 3600_000;
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v.ts > cut));
}

export function getKey(item) {
  return createHash('sha1').update(item.time + '|' + item.content.substring(0, 100)).digest('hex');
}

export function loadState() {
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

export function saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}
