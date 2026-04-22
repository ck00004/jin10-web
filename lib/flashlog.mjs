/**
 * 快讯日志模块 — 按天保存全部快讯接收日志
 */
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { LOGS_DIR } from './config.mjs';

function ensureLogsDir() {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
}

function todayLogFile() {
  const dateStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  return join(LOGS_DIR, `flash_${dateStr}.log`);
}

function hms() {
  return new Date().toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function writeLine(line) {
  ensureLogsDir();
  appendFileSync(todayLogFile(), line + '\n');
}

export function logFlashNew(item) {
  const id = item.flashId || item.id || '';
  const mark = item.important ? ' 🔴' : '';
  const title = item.title || '';
  const content = item.content || '';
  const display = title ? `${title} ${content}` : content;
  writeLine(`[${item.time || hms()}] 新快讯 (ID: ${id})${mark}`);
  writeLine(`  [${item.time || hms()}] ${display}`);
  writeLine('=' .repeat(60));
}

export function logFlashEdit(flashId, content) {
  const text = String(content || '').substring(0, 80);
  writeLine(`[${hms()}] [修改] ID:${flashId} ${text}`);
  writeLine('=' .repeat(60));
}

export function logFlashDelete(flashId) {
  writeLine(`[${hms()}] [删除] ID:${flashId}`);
  writeLine('=' .repeat(60));
}
