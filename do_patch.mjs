import fs from 'fs';

const file = 'lib/news.mjs';
const code = fs.readFileSync(file, 'utf-8');

const splitIndex = code.indexOf('// ── 每日分析');
if (splitIndex === -1) throw new Error('Split marker not found');

const bottom = code.slice(splitIndex);

let newTop = fs.readFileSync('replacement.txt', 'utf-8');

let oldGetDay = 'return loadNews().filter(item => getDateStr(item.createdAt) === dateStr);';
let newGetDay = `const startMs = toShanghaiEpochMs(dateStr, '00:00:00');
  const endMs = toShanghaiEpochMs(dateStr, '23:59:59');
  if (startMs === null || endMs === null) return [];
  const rows = db.prepare(\`SELECT raw_json FROM news WHERE createdAt >= ? AND createdAt <= ? ORDER BY createdAt DESC\`).all(startMs, endMs);
  return rows.map(r => JSON.parse(r.raw_json));`;

fs.writeFileSync(file, newTop + bottom.replace(oldGetDay, newGetDay));
