/**
 * Jin10 Monitor — Shared Utilities
 */

/** HTML-escape a string for safe insertion into innerHTML */
export function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format a Date to HH:MM:SS in zh-CN locale */
export function fmtTime(d) {
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Show a toast notification */
export function showToast(el, type, msg, duration = 6000) {
  el.className = `toast ${type}`;
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.display = 'none'; }, duration);
}
