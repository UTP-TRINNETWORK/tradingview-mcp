/**
 * CaptureDaemon — Persistent Node.js HTTP server for TradingView chart operations.
 *
 * Maintains a long-lived CDP connection to TradingView Desktop and exposes a
 * lightweight HTTP JSON API for the Python server.  Eliminates subprocess overhead
 * by keeping the connection warm across requests.
 *
 * Usage:
 *   node src/daemon/index.js                       # Default port 9333
 *   CAPTURE_DAEMON_PORT=9444 node src/daemon/index.js  # Custom port
 *
 * Design ref: design.md § "CaptureDaemon (Node.js)"
 */

import express from 'express';
import { getClient, disconnect } from '../connection.js';
import { registerRoutes } from './routes.js';
import { stateCache } from './state-cache.js';
import { metrics } from './metrics.js';

const PORT = parseInt(process.env.CAPTURE_DAEMON_PORT || '9333', 10);
const HOST = process.env.CAPTURE_DAEMON_HOST || '127.0.0.1';

const app = express();
app.use(express.json());

// Enable permissive CORS for local testing dashboard
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Register all API routes
registerRoutes(app);

// ─── Startup ─────────────────────────────────────────────────────────────────

let server;

async function start() {
  console.log(`[daemon] CaptureDaemon starting on ${HOST}:${PORT} ...`);

  // Attempt initial CDP connection (non-fatal if TradingView not running)
  try {
    await getClient();
    console.log('[daemon] ✅ CDP connection established.');
  } catch (err) {
    console.warn(`[daemon] ⚠️ CDP connection failed on startup: ${err.message}`);
    console.warn('[daemon]    The daemon will retry on first capture request.');
  }

  // Probe current chart state to seed the cache
  try {
    const { evaluate } = await import('../connection.js');
    const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
    const state = await evaluate(`
      (function() {
        var chart = ${CHART_API};
        return { symbol: chart.symbol(), resolution: chart.resolution() };
      })()
    `);
    if (state && state.symbol) {
      stateCache.update(state.symbol, state.resolution || 'D');
      console.log(`[daemon] State cache seeded: ${state.symbol} @ ${state.resolution}`);
    }
  } catch {
    // Non-fatal — cache starts empty
  }

  return new Promise((resolve) => {
    server = app.listen(PORT, HOST, () => {
      console.log(`[daemon] ✅ HTTP server listening on http://${HOST}:${PORT}`);
      console.log('[daemon] Endpoints: POST /capture, /batch-capture, /set-chart | GET /health');
      resolve();
    });
  });
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`[daemon] ${signal} received — shutting down gracefully...`);

  if (server) {
    server.close(() => {
      console.log('[daemon] HTTP server closed.');
    });
  }

  try {
    await disconnect();
    console.log('[daemon] CDP connection closed.');
  } catch {}

  // Allow time for pending responses to drain
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors gracefully
process.on('uncaughtException', (err) => {
  console.error(`[daemon] Uncaught exception: ${err.message}`);
  console.error(err.stack);
  stateCache.invalidate();
  metrics.recordReconnect();
});

process.on('unhandledRejection', (reason) => {
  console.error(`[daemon] Unhandled rejection: ${reason}`);
  stateCache.invalidate();
});

// ─── Boot ────────────────────────────────────────────────────────────────────
start().catch((err) => {
  console.error(`[daemon] Fatal startup error: ${err.message}`);
  process.exit(1);
});
