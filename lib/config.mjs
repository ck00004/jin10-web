/**
 * 配置管理模块
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export const __dirname = dirname(fileURLToPath(import.meta.url));
export const BASE_DIR = join(__dirname, '..');

export const LOCK_FILE  = join(BASE_DIR, '.lock');
export const DEDUP_FILE = join(BASE_DIR, 'dedup.json');
export const STATE_FILE = join(BASE_DIR, 'state.json');
export const NEWS_FILE  = join(BASE_DIR, 'news.json');
export const DAILY_FILE = join(BASE_DIR, 'daily_analysis.json');

export const LOGS_DIR    = join(BASE_DIR, 'logs');

export const JIN10_WS_URL = 'wss://wss-flash-2.jin10.com/';
export const DEDUP_HOURS = 72;
export const MAX_REQUEST_BODY_SIZE = 1_000_000;

const CONFIG_FILE = join(BASE_DIR, 'config.json');

function cloneProviders(providers) {
  return providers.map(provider => ({ ...provider }));
}

function loadLegacyProviders(config) {
  const providers = normalizeProviders(config.AI_PROVIDERS);
  if (providers.length > 0) {
    return providers;
  }
  if (config.MINIMAX_API_KEY) {
    return [{ type: 'minimax', apiKey: config.MINIMAX_API_KEY }];
  }
  return [];
}

export function migrateConfigShape(config) {
  const current = config && typeof config === 'object' ? { ...config } : {};
  const legacyProviders = loadLegacyProviders(current);
  let changed = false;

  if (!Array.isArray(current.NEWS_ANALYSIS_AI_PROVIDERS) && legacyProviders.length > 0) {
    current.NEWS_ANALYSIS_AI_PROVIDERS = cloneProviders(legacyProviders);
    changed = true;
  }

  if (!Array.isArray(current.DAILY_ANALYSIS_AI_PROVIDERS) && legacyProviders.length > 0) {
    current.DAILY_ANALYSIS_AI_PROVIDERS = cloneProviders(legacyProviders);
    changed = true;
  }

  if ('AI_PROVIDERS' in current) {
    delete current.AI_PROVIDERS;
    changed = true;
  }

  if ('MINIMAX_API_KEY' in current) {
    delete current.MINIMAX_API_KEY;
    changed = true;
  }

  return { config: current, changed };
}

export function loadConfigFile() {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    const { config, changed } = migrateConfigShape(parsed);
    if (changed) {
      saveConfigFile(config);
      console.log('[config] 已自动迁移 config.json 到新的模型配置格式');
    }
    return config;
  } catch (e) {
    console.error(`[config] config.json parse error: ${e.message}`);
    return {};
  }
}

export function saveConfigFile(newCfg) {
  writeFileSync(CONFIG_FILE, JSON.stringify(newCfg, null, 2));
}

function normalizeProviders(providers) {
  return Array.isArray(providers)
    ? providers.filter(p => p && p.type && p.apiKey)
    : [];
}

function withLegacyMinimaxFallback(config, providers) {
  const c = config || {};
  const next = [...providers];
  if (c.MINIMAX_API_KEY && !next.some(p => p.type === 'minimax')) {
    next.unshift({ type: 'minimax', apiKey: c.MINIMAX_API_KEY });
  }
  return next;
}

export function loadAiProviders(config) {
  const c = config || {};
  return withLegacyMinimaxFallback(c, normalizeProviders(c.AI_PROVIDERS));
}

export function loadNewsAiProviders(config) {
  const c = config || {};
  const specific = normalizeProviders(c.NEWS_ANALYSIS_AI_PROVIDERS);
  if (specific.length > 0) {
    return specific;
  }
  return loadAiProviders(c);
}

export function loadDailyAnalysisAiProviders(config) {
  const c = config || {};
  const specific = normalizeProviders(c.DAILY_ANALYSIS_AI_PROVIDERS);
  if (specific.length > 0) {
    return specific;
  }
  return loadAiProviders(c);
}

// 可变共享状态，通过 getter/setter 访问
let cfg = loadConfigFile();
let AI_PROVIDERS = loadAiProviders(cfg);
let NEWS_ANALYSIS_AI_PROVIDERS = loadNewsAiProviders(cfg);
let DAILY_ANALYSIS_AI_PROVIDERS = loadDailyAnalysisAiProviders(cfg);

export function getCfg() { return cfg; }
export function getAiProviders() { return AI_PROVIDERS; }
export function getNewsAiProviders() { return NEWS_ANALYSIS_AI_PROVIDERS; }
export function getDailyAnalysisAiProviders() { return DAILY_ANALYSIS_AI_PROVIDERS; }
export function getAiDebug() { return !!(cfg.AI_DEBUG); }
export function getHttpPort() { return cfg.WEB_PORT || 3000; }
export function getHttpHost() { return cfg.WEB_HOST || '0.0.0.0'; }

export function reloadConfig() {
  cfg = loadConfigFile();
  AI_PROVIDERS = loadAiProviders(cfg);
  NEWS_ANALYSIS_AI_PROVIDERS = loadNewsAiProviders(cfg);
  DAILY_ANALYSIS_AI_PROVIDERS = loadDailyAnalysisAiProviders(cfg);
  return cfg;
}
