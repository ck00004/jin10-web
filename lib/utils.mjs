/**
 * 通用工具函数模块
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from 'fs';
import { join } from 'path';
import { LOCK_FILE, BASE_DIR, MAX_REQUEST_BODY_SIZE } from './config.mjs';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const ts = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');

export function log(m) { console.log(`[${ts()}] ${m}`); }
export function logErr(m) { console.error(`[${ts()}] ERROR: ${m}`); appendFileSync(join(BASE_DIR, 'errors.log'), `[${ts()}] ${m}\n`); }

export function acquireLock() {
  if (existsSync(LOCK_FILE)) {
    const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); process.exit(0); } catch {}
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid));
  process.on('exit', () => { try { unlinkSync(LOCK_FILE); } catch {} });
}

export function readRequestBody(req, res) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_REQUEST_BODY_SIZE) {
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Request body too large' }));
        }
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}
