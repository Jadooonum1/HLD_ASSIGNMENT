'use strict';

const config = require('../config');

/**
 * StatsTracker tracks rolling suggestion API latencies and computes
 * metrics like mean, p50, p95, and p99.
 */
class StatsTracker {
  constructor(options = {}) {
    this.historyLimit = options.latencyWindow || config.metrics.latencyWindow;
    this.latencyRecords = [];
    this.insertPointer = 0;
    this.requestCounter = 0;
  }

  /** Add a latency observation in milliseconds */
  logSuggestLatency(durationMs) {
    this.requestCounter++;
    if (this.latencyRecords.length < this.historyLimit) {
      this.latencyRecords.push(durationMs);
    } else {
      this.latencyRecords[this.insertPointer] = durationMs;
      this.insertPointer = (this.insertPointer + 1) % this.historyLimit;
    }
  }

  /** Compute specific percentile on sorted array */
  calculatePercentile(sortedArray, pct) {
    if (sortedArray.length === 0) return 0;
    const position = pct * (sortedArray.length - 1);
    const indexLow = Math.floor(position);
    const indexHigh = Math.ceil(position);
    if (indexLow === indexHigh) {
      return sortedArray[indexLow];
    }
    const weight = position - indexLow;
    return sortedArray[indexLow] * (1 - weight) + sortedArray[indexHigh] * weight;
  }

  /** Get a summary report of latencies and request counts */
  getReport() {
    const sorted = [...this.latencyRecords].sort((x, y) => x - y);
    const sum = sorted.reduce((acc, val) => acc + val, 0);
    const formatValue = (num) => Math.round(num * 1000) / 1000;

    return {
      requests: this.requestCounter,
      sampleCount: sorted.length,
      avgMs: sorted.length ? formatValue(sum / sorted.length) : 0,
      p50Ms: formatValue(this.calculatePercentile(sorted, 0.5)),
      p95Ms: formatValue(this.calculatePercentile(sorted, 0.95)),
      p99Ms: formatValue(this.calculatePercentile(sorted, 0.99)),
      maxMs: sorted.length ? formatValue(sorted[sorted.length - 1]) : 0,
    };
  }
}

module.exports = { StatsTracker };
