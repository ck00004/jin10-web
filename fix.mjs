import fs from 'fs';
const code = fs.readFileSync('lib/news.mjs', 'utf-8');
const fixed = code.replace(/function getDateStr\(timestampMs\)\s*\{[\s\S]*?return \`\$\{yyyy\}-\$\{mm\}-\$\{dd\}\`;\n\}\n/, '');
fs.writeFileSync('lib/news.mjs', fixed);
