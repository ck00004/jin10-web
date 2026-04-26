/**
 * HTTP/API 服务器模块
 */
import { readFileSync, existsSync } from 'fs';
import { join, extname, resolve, sep } from 'path';
import { createServer } from 'http';
import {
  BASE_DIR,
  getHttpPort,
  getHttpHost,
  loadConfigFile,
  saveConfigFile,
  reloadConfig,
  getNewsAiProviders,
  getDailyAnalysisAiProviders,
} from './config.mjs';
import { log, readRequestBody } from './utils.mjs';
import { loadState } from './dedup.mjs';
import { loadNews, loadDailyAnalyses, queryNewsItems, saveDailyAnalysis, getTodayDateStr, updateNewsItem } from './news.mjs';
import { generateDailyReport } from './news.mjs';
import {
  consumeClsTelegraphNewItems,
  getClsMonitorStatus,
  getClsTelegraphDetail,
  queryClsTelegraphs,
  exportClsTelegraphs,
  triggerClsTelegraphSync,
} from './cls-telegraph.mjs';
import { analyze, buildTechnicalSummary } from './ai.mjs';
import { logErr } from './utils.mjs';

export function startWebServer() {
  const HTTP_PORT = getHttpPort();
  const HTTP_HOST = getHttpHost();
  const publicDir = join(BASE_DIR, 'public');
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.json': 'application/json',
    '.ico':  'image/x-icon',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);
      const pathname = url.pathname;

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      // ── API routes ──────────────────────────────────────────────────────────
      if (pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, time: new Date().toISOString() }));
        return;
      }

      if (pathname === '/api/status') {
        const state = loadState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...state }));
        return;
      }

      if (pathname === '/api/news') {
        const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '20', 10), 200);
        const before = parseInt(url.searchParams.get('before') || '0', 10);
        const includeSkipped = url.searchParams.get('includeSkipped') === '1';
        const includeDeleted = url.searchParams.get('includeDeleted') === '1';
        const importantOnly = url.searchParams.get('importantOnly') === '1';
        const date = url.searchParams.get('date') || '';
        const startTime = url.searchParams.get('startTime') || '';
        const endTime = url.searchParams.get('endTime') || '';
        const includeAnalysis = url.searchParams.get('includeAnalysis') === '1';
        const result = queryNewsItems({
          limit,
          before,
          includeSkipped,
          includeDeleted,
          importantOnly,
          date,
          startTime,
          endTime,
        });
        const items = includeAnalysis
          ? result.items
          : result.items.map(item => ({
              id: item.id,
              flashId: item.flashId,
              time: item.time,
              title: item.title,
              content: item.content,
              important: !!item.important,
              tags: item.tags,
              hotTag: item.hotTag,
              remarks: item.remarks,
              affect: item.affect,
              source: item.source,
              skipped: !!item.skipped,
              skipReason: item.skipReason,
              deleted: !!item.deleted,
              createdAt: item.createdAt,
            }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          items,
          total: result.total,
          hasMore: result.hasMore,
          filters: {
            date,
            startTime,
            endTime,
            includeSkipped,
            includeDeleted,
            importantOnly,
            includeAnalysis,
          },
        }));
        return;
      }

      if (pathname === '/api/cls/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, monitor: getClsMonitorStatus() }));
        return;
      }

      if (pathname === '/api/cls/telegraphs' && req.method === 'GET') {
        const result = queryClsTelegraphs({
          limit: url.searchParams.get('limit') || '30',
          beforeCtime: url.searchParams.get('beforeCtime') || '0',
          beforeId: url.searchParams.get('beforeId') || '0',
          startCtime: url.searchParams.get('startCtime') || '0',
          endCtime: url.searchParams.get('endCtime') || '0',
          importantOnly: url.searchParams.get('importantOnly') === '1',
          onlyRecovered: url.searchParams.get('onlyRecovered') === '1',
          minLevel: url.searchParams.get('minLevel') || '',
          subject: url.searchParams.get('subject') || '',
          tag: url.searchParams.get('tag') || '',
          stock: url.searchParams.get('stock') || '',
          keyword: url.searchParams.get('keyword') || '',
          source: url.searchParams.get('source') || 'all',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          items: result.items,
          total: result.total,
          hasMore: result.hasMore,
          filters: {
            startCtime: url.searchParams.get('startCtime') || '0',
            endCtime: url.searchParams.get('endCtime') || '0',
            importantOnly: url.searchParams.get('importantOnly') === '1',
            onlyRecovered: url.searchParams.get('onlyRecovered') === '1',
            minLevel: url.searchParams.get('minLevel') || '',
            subject: url.searchParams.get('subject') || '',
            tag: url.searchParams.get('tag') || '',
            stock: url.searchParams.get('stock') || '',
            keyword: url.searchParams.get('keyword') || '',
            source: url.searchParams.get('source') || 'all',
          },
        }));
        return;
      }

      if (pathname.startsWith('/api/cls/telegraphs/') && req.method === 'GET') {
        const telegraphId = pathname.split('/').pop();
        const item = getClsTelegraphDetail(telegraphId);
        if (!item) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'CLS 电报不存在' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, item }));
        return;
      }

      if (pathname === '/api/cls/export' && req.method === 'GET') {
        const format = (url.searchParams.get('format') || 'json').toLowerCase();
        const result = exportClsTelegraphs({
          limit: url.searchParams.get('limit') || '200',
          beforeCtime: url.searchParams.get('beforeCtime') || '0',
          beforeId: url.searchParams.get('beforeId') || '0',
          startCtime: url.searchParams.get('startCtime') || '0',
          endCtime: url.searchParams.get('endCtime') || '0',
          importantOnly: url.searchParams.get('importantOnly') === '1',
          onlyRecovered: url.searchParams.get('onlyRecovered') === '1',
          minLevel: url.searchParams.get('minLevel') || '',
          subject: url.searchParams.get('subject') || '',
          tag: url.searchParams.get('tag') || '',
          stock: url.searchParams.get('stock') || '',
          keyword: url.searchParams.get('keyword') || '',
        });

        if (format === 'jsonl') {
          const body = result.items.map(item => JSON.stringify(item)).join('\n');
          res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Content-Disposition': `attachment; filename="cls-telegraphs-${new Date(result.exportedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jsonl"`,
          });
          res.end(body);
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          export: result,
          filters: {
            startCtime: url.searchParams.get('startCtime') || '0',
            endCtime: url.searchParams.get('endCtime') || '0',
            importantOnly: url.searchParams.get('importantOnly') === '1',
            onlyRecovered: url.searchParams.get('onlyRecovered') === '1',
            minLevel: url.searchParams.get('minLevel') || '',
            subject: url.searchParams.get('subject') || '',
            tag: url.searchParams.get('tag') || '',
            stock: url.searchParams.get('stock') || '',
            keyword: url.searchParams.get('keyword') || '',
          },
        }));
        return;
      }

      if (pathname === '/api/cls/sync' && req.method === 'POST') {
        let body = {};
        try { body = await readRequestBody(req, res); } catch {}
        const mode = body.mode || 'both';
        const result = await triggerClsTelegraphSync(mode);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (pathname === '/api/cls/consume' && req.method === 'POST') {
        consumeClsTelegraphNewItems();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, monitor: getClsMonitorStatus() }));
        return;
      }

      // ── Config API ────────────────────────────────────────────────────────
      if (pathname === '/api/config' && req.method === 'GET') {
        const current = loadConfigFile();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, config: current }));
        return;
      }

      if (pathname === '/api/config' && req.method === 'POST') {
        let body;
        try { body = await readRequestBody(req, res); } catch (e) {
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
          return;
        }
        if (body.NEWS_ANALYSIS_AI_PROVIDERS !== undefined && !Array.isArray(body.NEWS_ANALYSIS_AI_PROVIDERS)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'NEWS_ANALYSIS_AI_PROVIDERS must be an array' }));
          return;
        }
        if (body.DAILY_ANALYSIS_AI_PROVIDERS !== undefined && !Array.isArray(body.DAILY_ANALYSIS_AI_PROVIDERS)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'DAILY_ANALYSIS_AI_PROVIDERS must be an array' }));
          return;
        }
        // Merge with existing config to preserve unknown fields
        const existing = loadConfigFile();
        const merged = { ...existing, ...body };
        delete merged.AI_PROVIDERS;
        saveConfigFile(merged);
        reloadConfig();
        const newsProviders = getNewsAiProviders();
        const dailyProviders = getDailyAnalysisAiProviders();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          newsProviders: newsProviders.length,
          dailyProviders: dailyProviders.length,
        }));
        return;
      }

      // ── Daily Analysis API ────────────────────────────────────────────────
      if (pathname === '/api/daily-analysis/dates' && req.method === 'GET') {
        const source = url.searchParams.get('source') || 'news';
        const all = loadDailyAnalyses(source);
        const dates = Object.keys(all).sort().reverse();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, source, dates }));
        return;
      }

      if (pathname === '/api/daily-analysis' && req.method === 'GET') {
        const date = url.searchParams.get('date') || getTodayDateStr();
        const source = url.searchParams.get('source') || 'news';
        const all = loadDailyAnalyses(source);
        const entry = all[date] || null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, date, source, analysis: entry }));
        return;
      }

      if (pathname === '/api/daily-analysis/trigger' && req.method === 'POST') {
        let body = {};
        try { body = await readRequestBody(req, res); } catch {}
        const date = body.date || getTodayDateStr();
        const source = body.source || 'news';
        const sourceLabel = String(source).trim().toLowerCase() === 'cls' ? 'CLS 电报' : '金十新闻';
        generateDailyReport(date, source).then(entry => {
          if (entry) saveDailyAnalysis(date, entry, source);
        }).catch(e => logErr(`每日分析触发: ${e.message}`));
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, source, message: `正在生成 ${date} 的${sourceLabel}每日分析，请稍后刷新查看` }));
        return;
      }

      // ── Re-analyze a single news item ─────────────────────────────────────
      if (pathname === '/api/news/reanalyze' && req.method === 'POST') {
        let body;
        try { body = await readRequestBody(req, res); } catch (e) {
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
          return;
        }
        const { id } = body;
        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'id is required' }));
          return;
        }
        const newsItems = loadNews();
        const newsItem = newsItems.find(n => n.id === id);
        if (!newsItem) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '新闻条目不存在' }));
          return;
        }
        const AI_PROVIDERS = getNewsAiProviders();
        if (AI_PROVIDERS.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '未配置新闻分析 AI 提供商，请先在配置页面添加新闻分析模型' }));
          return;
        }
        try {
          const state = loadState();
          const result = await analyze(newsItem, state);
          const analysisText = result?.text || '';
          const analysisSource = result?.source || '';
          const analysisError = analysisText ? '' : '暂不可用';
          const technical = analysisText ? await buildTechnicalSummary(analysisText) : '';
          updateNewsItem(id, { analysis: analysisText, analysisSource, analysisError, technical });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, analysis: analysisText, analysisSource, analysisError, technical }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // ── Static files ─────────────────────────────────────────────────────────
      const filePath = pathname === '/' ? '/index.html' : pathname;
      const fullPath = resolve(publicDir, '.' + filePath);
      const ext = extname(fullPath);

      if (!fullPath.startsWith(publicDir + sep) && fullPath !== publicDir) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      if (existsSync(fullPath)) {
        try {
          const data = readFileSync(fullPath);
          res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
          res.end(data);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }
  });

  server.listen(HTTP_PORT, HTTP_HOST, () => {
    const displayHost = HTTP_HOST === '0.0.0.0' ? `localhost` : HTTP_HOST;
    log(`🌐 Web 服务器启动: http://${displayHost}:${HTTP_PORT} (监听 ${HTTP_HOST})`);
  });
  return server;
}
