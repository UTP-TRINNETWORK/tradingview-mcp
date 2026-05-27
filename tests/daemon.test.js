/**
 * Unit tests for P11 Node.js daemon components: metrics + state-cache.
 *
 * Run: node --test tests/daemon.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { CaptureMetrics } from '../src/daemon/metrics.js';
import { StateCache } from '../src/daemon/state-cache.js';


// ═══════════════════════════════════════════════════════════════
// CaptureMetrics
// ═══════════════════════════════════════════════════════════════

describe('CaptureMetrics', () => {

  let metrics;
  beforeEach(() => {
    metrics = new CaptureMetrics();
  });

  it('should start with zero counters', () => {
    const stats = metrics.getStats();
    assert.equal(stats.total, 0);
    assert.equal(stats.successful, 0);
    assert.equal(stats.failed, 0);
    assert.equal(stats.avg_latency_ms, 0);
    assert.equal(stats.p95_latency_ms, 0);
    assert.equal(stats.reconnect_count, 0);
  });

  it('Property 10: counters should never decrease after record()', () => {
    metrics.record(100, true);
    const s1 = metrics.getStats();
    metrics.record(200, true);
    const s2 = metrics.getStats();

    assert.ok(s2.total >= s1.total, 'total decreased');
    assert.ok(s2.successful >= s1.successful, 'successful decreased');
    assert.ok(s2.avg_latency_ms > 0);
  });

  it('should track failures separately', () => {
    metrics.record(100, true);
    metrics.record(500, false);
    metrics.record(200, true);

    const stats = metrics.getStats();
    assert.equal(stats.total, 3);
    assert.equal(stats.successful, 2);
    assert.equal(stats.failed, 1);
  });

  it('should compute correct average latency', () => {
    metrics.record(100);
    metrics.record(200);
    metrics.record(300);

    const stats = metrics.getStats();
    assert.equal(stats.avg_latency_ms, 200);
  });

  it('should enforce rolling window size (100)', () => {
    for (let i = 0; i < 150; i++) {
      metrics.record(i);
    }
    // Internal buffer should be capped at 100
    assert.equal(metrics._latencies.length, 100);
    // Total count should still reflect all 150
    assert.equal(metrics.getStats().total, 150);
  });

  it('should compute p95 from sorted window', () => {
    // Insert 100 values: 1 to 100
    for (let i = 1; i <= 100; i++) {
      metrics.record(i);
    }
    const stats = metrics.getStats();
    // P95 of [1..100] should be 95
    assert.equal(stats.p95_latency_ms, 95);
  });

  it('should track reconnections', () => {
    metrics.recordReconnect();
    metrics.recordReconnect();
    assert.equal(metrics.getStats().reconnect_count, 2);
  });

  it('should reset all counters', () => {
    metrics.record(100);
    metrics.record(200, false);
    metrics.recordReconnect();
    metrics.reset();

    const stats = metrics.getStats();
    assert.equal(stats.total, 0);
    assert.equal(stats.successful, 0);
    assert.equal(stats.failed, 0);
    assert.equal(stats.reconnect_count, 0);
  });

  it('uptime should increase over time', async () => {
    const t1 = metrics.getStats().uptime_ms;
    await new Promise(r => setTimeout(r, 50));
    const t2 = metrics.getStats().uptime_ms;
    assert.ok(t2 > t1, `uptime did not increase: ${t1} -> ${t2}`);
  });
});


// ═══════════════════════════════════════════════════════════════
// StateCache
// ═══════════════════════════════════════════════════════════════

describe('StateCache', () => {

  let cache;
  beforeEach(() => {
    cache = new StateCache();
  });

  it('should start with null state (no match)', () => {
    assert.equal(cache.currentSymbol, null);
    assert.equal(cache.currentTimeframe, null);
    assert.equal(cache.matches('BTCUSDT', 'D'), false);
  });

  it('Property 8: same symbol+timeframe → cache hit', () => {
    cache.update('BTCUSDT', 'D');
    assert.equal(cache.matches('BTCUSDT', 'D'), true);
  });

  it('Property 8: "active" always matches current state', () => {
    cache.update('BTCUSDT', 'D');
    assert.equal(cache.matches('active', 'active'), true);
    assert.equal(cache.matches('active', 'D'), true);
    assert.equal(cache.matches('BTCUSDT', 'active'), true);
  });

  it('should NOT match different symbol', () => {
    cache.update('BTCUSDT', 'D');
    assert.equal(cache.matches('ETHUSDT', 'D'), false);
  });

  it('should NOT match different timeframe', () => {
    cache.update('BTCUSDT', 'D');
    assert.equal(cache.matches('BTCUSDT', '1h'), false);
  });

  it('Property 9: invalidation clears all state', () => {
    cache.update('BTCUSDT', 'D');
    cache.invalidate();
    assert.equal(cache.currentSymbol, null);
    assert.equal(cache.currentTimeframe, null);
    assert.equal(cache.matches('BTCUSDT', 'D'), false);
  });

  it('update with "active" should not overwrite cached value', () => {
    cache.update('BTCUSDT', 'D');
    cache.update('active', 'active');
    assert.equal(cache.currentSymbol, 'BTCUSDT');
    assert.equal(cache.currentTimeframe, 'D');
  });

  it('update with new symbol should overwrite', () => {
    cache.update('BTCUSDT', 'D');
    cache.update('ETHUSDT', '1h');
    assert.equal(cache.currentSymbol, 'ETHUSDT');
    assert.equal(cache.currentTimeframe, '1h');
  });

  it('getState should return current values', () => {
    cache.update('SOLUSDT', 'W');
    const state = cache.getState();
    assert.equal(state.symbol, 'SOLUSDT');
    assert.equal(state.timeframe, 'W');
    assert.ok(state.lastUpdate > 0);
  });

  it('getState after invalidation should return nulls', () => {
    cache.update('BTCUSDT', 'D');
    cache.invalidate();
    const state = cache.getState();
    assert.equal(state.symbol, null);
    assert.equal(state.timeframe, null);
    assert.equal(state.lastUpdate, 0);
  });
});
