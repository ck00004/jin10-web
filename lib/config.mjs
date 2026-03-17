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

export function loadConfigFile() {
  if (!existsSync(join(BASE_DIR, 'config.json'))) return {};
  try { return JSON.parse(readFileSync(join(BASE_DIR, 'config.json'), 'utf-8')); } catch (e) {
    console.error(`[config] config.json parse error: ${e.message}`);
    return {};
  }
}

export function saveConfigFile(newCfg) {
  writeFileSync(join(BASE_DIR, 'config.json'), JSON.stringify(newCfg, null, 2));
}

export function loadAiProviders(config) {
  const c = config || {};
  const providers = Array.isArray(c.AI_PROVIDERS)
    ? c.AI_PROVIDERS.filter(p => p && p.type && p.apiKey)
    : [];
  if (c.MINIMAX_API_KEY && !providers.some(p => p.type === 'minimax')) {
    providers.unshift({ type: 'minimax', apiKey: c.MINIMAX_API_KEY });
  }
  return providers;
}

// 可变共享状态，通过 getter/setter 访问
let cfg = loadConfigFile();
let AI_PROVIDERS = loadAiProviders(cfg);

export function getCfg() { return cfg; }
export function getAiProviders() { return AI_PROVIDERS; }
export function getHttpPort() { return cfg.WEB_PORT || 3000; }
export function getHttpHost() { return cfg.WEB_HOST || '0.0.0.0'; }

export function reloadConfig() {
  cfg = loadConfigFile();
  AI_PROVIDERS = loadAiProviders(cfg);
  return cfg;
}
