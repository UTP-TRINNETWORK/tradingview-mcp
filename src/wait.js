import { evaluate } from './connection.js';

const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 200;

export async function waitForChartReady(expectedSymbol = null, expectedTf = null, timeout = DEFAULT_TIMEOUT) {
  const start = Date.now();
  let lastBarCount = -1;
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
      (function() {
        // Check for loading spinner, ignoring non-spinner elements like "loading-eye"
        var spinner = document.querySelector('[class*="loader"]')
          || document.querySelector('[class*="loading"]:not([class*="eye"])')
          || document.querySelector('[data-name="loading"]');
        var isLoading = spinner && spinner.offsetParent !== null;

        // Try to get bar count from data window or chart
        var barCount = -1;
        try {
          var bars = document.querySelectorAll('[class*="bar"]');
          barCount = bars.length;
        } catch {}

        // Get current symbol from Chart API or header fallback
        var currentSymbol = '';
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          currentSymbol = chart.symbol();
        } catch (e) {
          var symbolEl = document.querySelector('[data-name="legend-source-title"]')
            || document.querySelector('[class*="title"][class*="apply-common-tooltip"]')
            || document.querySelector('[class*="title"] [class*="apply-common-tooltip"]');
          currentSymbol = symbolEl ? symbolEl.textContent.trim() : '';
        }

        return { isLoading: !!isLoading, barCount: barCount, currentSymbol: currentSymbol };
      })()
    `);

    if (!state) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Not ready if still loading
    if (state.isLoading) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Check symbol match if expected
    if (expectedSymbol && state.currentSymbol) {
      var normCurrent = state.currentSymbol.toUpperCase().replace(/[^A-Z0-9]/g, '').replace('TETHERUS', 'USDT').replace('TETHER', 'USDT').replace('USD', 'USDT');
      var normExpected = expectedSymbol.toUpperCase().replace(/[^A-Z0-9]/g, '').replace('TETHERUS', 'USDT').replace('TETHER', 'USDT').replace('USD', 'USDT');
      if (!normCurrent.includes(normExpected) && !normExpected.includes(normCurrent)) {
        stableCount = 0;
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
        continue;
      }
    }

    // Check bar count stability
    if (state.barCount === lastBarCount && state.barCount > 0) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    lastBarCount = state.barCount;

    if (stableCount >= 2) {
      return true;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  // Timeout — return true anyway, caller should verify
  return false;
}

