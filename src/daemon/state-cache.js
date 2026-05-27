/**
 * Chart State Cache — Tracks current symbol/timeframe to avoid redundant CDP calls.
 *
 * Design invariant (Property 8): For N consecutive capture requests with the same
 * symbol+timeframe, the daemon issues at most 1 CDP set_symbol/set_timeframe
 * command (on the first request) and 0 for subsequent requests.
 *
 * Design invariant (Property 9): When a /set-chart request changes symbol or
 * timeframe, the cache is invalidated so the next capture triggers a fresh CDP call.
 */

class StateCache {
  constructor() {
    /** @type {string|null} */
    this.currentSymbol = null;
    /** @type {string|null} */
    this.currentTimeframe = null;
    /** @type {number} Timestamp of last update */
    this._lastUpdate = 0;
  }

  /**
   * Check if the chart is already showing the requested state.
   * "active" means "use whatever is currently displayed" — always a cache hit.
   *
   * @param {string} symbol     Requested symbol (or "active")
   * @param {string} timeframe  Requested timeframe (or "active")
   * @returns {boolean} true if CDP already shows the requested state
   */
  matches(symbol, timeframe) {
    if (this.currentSymbol === null) return false;

    const symbolMatch = symbol === 'active' || symbol === this.currentSymbol;
    const timeframeMatch = timeframe === 'active' || timeframe === this.currentTimeframe;
    return symbolMatch && timeframeMatch;
  }

  /**
   * Update cache after a successful CDP symbol/timeframe change.
   * @param {string} symbol
   * @param {string} timeframe
   */
  update(symbol, timeframe) {
    if (symbol !== 'active') this.currentSymbol = symbol;
    if (timeframe !== 'active') this.currentTimeframe = timeframe;
    this._lastUpdate = Date.now();
  }

  /**
   * Invalidate the cache (e.g., on CDP reconnect or error).
   */
  invalidate() {
    this.currentSymbol = null;
    this.currentTimeframe = null;
    this._lastUpdate = 0;
  }

  /**
   * Get the current cached state.
   * @returns {{ symbol: string|null, timeframe: string|null, lastUpdate: number }}
   */
  getState() {
    return {
      symbol: this.currentSymbol,
      timeframe: this.currentTimeframe,
      lastUpdate: this._lastUpdate,
    };
  }
}

// Singleton instance
const stateCache = new StateCache();

export { StateCache, stateCache };
