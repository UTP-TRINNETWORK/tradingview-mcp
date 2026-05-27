/**
 * Capture Metrics Collector — Rolling-window latency tracking.
 *
 * Maintains a ring buffer of the last 100 capture latencies for
 * real-time avg/p95 computation.  Thread-safe (single-threaded Node.js).
 *
 * Design ref: design.md § "Capture Metrics (internal to daemon)"
 */

const WINDOW_SIZE = 100;

class CaptureMetrics {
  constructor() {
    /** @type {number[]} Ring buffer of latencies (ms) */
    this._latencies = [];
    this._totalCaptures = 0;
    this._successfulCaptures = 0;
    this._failedCaptures = 0;
    this._reconnectCount = 0;
    this._startTime = Date.now();
  }

  /**
   * Record a capture result.
   * @param {number} latencyMs  Elapsed time in milliseconds
   * @param {boolean} success   Whether the capture succeeded
   */
  record(latencyMs, success = true) {
    this._totalCaptures++;
    if (success) {
      this._successfulCaptures++;
    } else {
      this._failedCaptures++;
    }

    this._latencies.push(latencyMs);
    if (this._latencies.length > WINDOW_SIZE) {
      this._latencies.shift();
    }
  }

  /** Increment CDP reconnection counter. */
  recordReconnect() {
    this._reconnectCount++;
  }

  /**
   * Compute aggregate stats from the rolling window.
   * @returns {{ total: number, successful: number, failed: number,
   *             avg_latency_ms: number, p95_latency_ms: number,
   *             reconnect_count: number, uptime_ms: number }}
   */
  getStats() {
    const avg = this._latencies.length > 0
      ? this._latencies.reduce((a, b) => a + b, 0) / this._latencies.length
      : 0;

    const p95 = this._computeP95();

    return {
      total: this._totalCaptures,
      successful: this._successfulCaptures,
      failed: this._failedCaptures,
      avg_latency_ms: Math.round(avg * 100) / 100,
      p95_latency_ms: p95,
      reconnect_count: this._reconnectCount,
      uptime_ms: Date.now() - this._startTime,
    };
  }

  /**
   * Compute 95th percentile from the rolling window.
   * If fewer than 20 samples, returns the max value.
   * @returns {number}
   */
  _computeP95() {
    if (this._latencies.length === 0) return 0;
    if (this._latencies.length < 20) {
      return Math.max(...this._latencies);
    }
    const sorted = [...this._latencies].sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[idx];
  }

  /** Reset all counters (for testing). */
  reset() {
    this._latencies = [];
    this._totalCaptures = 0;
    this._successfulCaptures = 0;
    this._failedCaptures = 0;
    this._reconnectCount = 0;
    this._startTime = Date.now();
  }
}

// Singleton instance
const metrics = new CaptureMetrics();

export { CaptureMetrics, metrics };
