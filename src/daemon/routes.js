/**
 * Daemon HTTP Route Handlers — Express routes for the Capture Daemon API.
 *
 * Endpoints:
 *   POST /capture         — Single screenshot capture
 *   POST /batch-capture   — Sequential batch capture
 *   POST /set-chart       — Change symbol/timeframe
 *   GET  /health          — Daemon health + metrics
 *
 * Design ref: design.md § "Daemon HTTP API"
 */

import { readFileSync } from 'fs';
import { getClient, evaluate, getChartApi } from '../connection.js';
import { captureScreenshot } from '../core/capture.js';
import { setSymbol, setTimeframe, getState } from '../core/chart.js';
import { stateCache } from './state-cache.js';
import { metrics } from './metrics.js';

/**
 * Register all routes on the given Express app.
 * @param {import('express').Express} app
 */
export function registerRoutes(app) {

  // ─── POST /capture ─────────────────────────────────────────────────────────
  app.post('/capture', async (req, res) => {
    const start = Date.now();
    try {
      const {
        symbol = 'active',
        timeframe = 'active',
        region = 'chart',
        crop = true,
        skip_if_same = true,
      } = req.body || {};

      let cachedState = false;

      // Determine if we need to change the chart state
      if (skip_if_same && stateCache.matches(symbol, timeframe)) {
        cachedState = true;
      } else {
        // Change symbol/timeframe via CDP
        if (symbol !== 'active') {
          try {
            await setSymbol({ symbol });
          } catch (err) {
            // If setSymbol fails, still try to capture current chart
            console.error(`[daemon] setSymbol(${symbol}) failed: ${err.message}`);
          }
        }
        if (timeframe !== 'active') {
          try {
            await setTimeframe({ timeframe });
          } catch (err) {
            console.error(`[daemon] setTimeframe(${timeframe}) failed: ${err.message}`);
          }
        }
        stateCache.update(symbol, timeframe);
      }

      // Capture screenshot
      const result = await captureScreenshot({ region });

      if (!result.success) {
        const latency = Date.now() - start;
        metrics.record(latency, false);
        return res.status(500).json({
          success: false,
          error: 'Screenshot capture failed',
          latency_ms: latency,
        });
      }

      // Read file as base64 if we have a file path
      let base64Data = null;
      let sizeBytes = 0;
      if (result.file_path) {
        try {
          const buf = readFileSync(result.file_path);
          base64Data = buf.toString('base64');
          sizeBytes = buf.length;
        } catch (err) {
          console.error(`[daemon] Failed to read screenshot file: ${err.message}`);
        }
      }

      const latency = Date.now() - start;
      metrics.record(latency, true);

      res.json({
        success: true,
        file_path: result.file_path || null,
        base64: base64Data,
        size_bytes: sizeBytes || result.size_bytes || 0,
        latency_ms: latency,
        cached_state: cachedState,
      });

    } catch (err) {
      const latency = Date.now() - start;
      metrics.record(latency, false);
      stateCache.invalidate();
      res.status(500).json({
        success: false,
        error: err.message,
        latency_ms: latency,
      });
    }
  });

  // ─── POST /batch-capture ───────────────────────────────────────────────────
  app.post('/batch-capture', async (req, res) => {
    const totalStart = Date.now();
    try {
      const { symbols = [] } = req.body || {};

      if (!Array.isArray(symbols) || symbols.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'symbols must be a non-empty array of {symbol, timeframe} objects',
        });
      }

      // Property 3: Result count === input count, same order
      const results = [];

      for (const entry of symbols) {
        const sym = entry.symbol || 'active';
        const tf = entry.timeframe || 'active';
        const entryStart = Date.now();

        try {
          let cachedState = false;

          if (stateCache.matches(sym, tf)) {
            cachedState = true;
          } else {
            if (sym !== 'active') await setSymbol({ symbol: sym });
            if (tf !== 'active') await setTimeframe({ timeframe: tf });
            stateCache.update(sym, tf);
          }

          const result = await captureScreenshot({ region: entry.region || 'chart' });

          let base64Data = null;
          let sizeBytes = 0;
          if (result.file_path) {
            try {
              const buf = readFileSync(result.file_path);
              base64Data = buf.toString('base64');
              sizeBytes = buf.length;
            } catch (_) {}
          }

          const latency = Date.now() - entryStart;
          metrics.record(latency, true);

          results.push({
            symbol: sym,
            success: true,
            file_path: result.file_path || null,
            base64: base64Data,
            size_bytes: sizeBytes || result.size_bytes || 0,
            latency_ms: latency,
            cached_state: cachedState,
          });

        } catch (err) {
          const latency = Date.now() - entryStart;
          metrics.record(latency, false);
          results.push({
            symbol: sym,
            success: false,
            error: err.message,
            latency_ms: latency,
          });
        }
      }

      res.json({
        results,
        total_latency_ms: Date.now() - totalStart,
      });

    } catch (err) {
      res.status(500).json({
        success: false,
        error: err.message,
        total_latency_ms: Date.now() - totalStart,
      });
    }
  });

  // ─── POST /set-chart ───────────────────────────────────────────────────────
  app.post('/set-chart', async (req, res) => {
    const start = Date.now();
    try {
      const { symbol, timeframe } = req.body || {};

      if (!symbol && !timeframe) {
        return res.status(400).json({
          success: false,
          error: 'At least one of symbol or timeframe must be provided',
        });
      }

      // Property 9: Invalidate cache when state changes
      stateCache.invalidate();

      if (symbol) await setSymbol({ symbol });
      if (timeframe) await setTimeframe({ timeframe });

      stateCache.update(symbol || 'active', timeframe || 'active');

      res.json({
        success: true,
        latency_ms: Date.now() - start,
      });

    } catch (err) {
      stateCache.invalidate();
      res.status(500).json({
        success: false,
        error: err.message,
        latency_ms: Date.now() - start,
      });
    }
  });

  // ─── GET /health ───────────────────────────────────────────────────────────
  app.get('/health', async (req, res) => {
    let connected = false;
    try {
      const client = await getClient();
      connected = !!client;
    } catch {
      connected = false;
    }

    const stats = metrics.getStats();
    const cached = stateCache.getState();

    res.json({
      connected,
      uptime_ms: stats.uptime_ms,
      captures_count: stats.total,
      avg_latency_ms: stats.avg_latency_ms,
      p95_latency_ms: stats.p95_latency_ms,
      reconnect_count: stats.reconnect_count,
      current_symbol: cached.symbol,
      current_timeframe: cached.timeframe,
    });
  });
}
