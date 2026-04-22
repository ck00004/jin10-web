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
        const all = loadDailyAnalyses();
        const dates = Object.keys(all).sort().reverse();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, dates }));
        return;
      }

      if (pathname === '/api/daily-analysis' && req.method === 'GET') {
        const date = url.searchParams.get('date') || getTodayDateStr();
        const all = loadDailyAnalyses();
        const entry = all[date] || null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, date, analysis: entry }));
        return;
      }

      if (pathname === '/api/daily-analysis/trigger' && req.method === 'POST') {
        let body = {};
        try { body = await readRequestBody(req, res); } catch {}
        const date = body.date || getTodayDateStr();
        generateDailyReport(date).then(entry => {
          if (entry) saveDailyAnalysis(date, entry);
        }).catch(e => logErr(`每日分析触发: ${e.message}`));
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: `正在生成 ${date} 的每日分析，请稍后刷新查看` }));
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
