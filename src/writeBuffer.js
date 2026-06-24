'use strict';

const appLogger = require('./appLogger');

/**
 * WriteBuffer aggregates search count updates in-memory, resolving duplicates
 * before executing batched upserts to the StoreManager.
 */
class WriteBuffer {
  constructor(options = {}) {
    this.storeInstance = options.primaryStore;
    this.cacheInstance = options.cache;
    this.batchSettings = options.config.batch;

    this.pendingDeltas = new Map(); // queryText -> countIncrement
    this.totalIngestedSearches = 0;
    this.flushOperationsRun = 0;
    this.uniqueStoreUpdatesWritten = 0;
    this.flushTimer = null;
  }

  /**
   * Queue a search query term, triggering a flush if the size limit is breached.
   */
  queueSearch(queryText) {
    this.totalIngestedSearches++;
    const currentDelta = this.pendingDeltas.get(queryText) || 0;
    this.pendingDeltas.set(queryText, currentDelta + 1);

    if (this.pendingDeltas.size >= this.batchSettings.maxBufferSize) {
      this.processFlush('buffer-full');
    }
  }

  /**
   * Commits buffered count changes to the database/store, invalidating affected prefix caches.
   */
  processFlush(flushTrigger = 'scheduled-interval') {
    if (this.pendingDeltas.size === 0) return 0;

    const deltasToApply = this.pendingDeltas;
    this.pendingDeltas = new Map();

    const affectedRecords = this.storeInstance.batchApplyIncrements(deltasToApply);
    this.flushOperationsRun++;
    this.uniqueStoreUpdatesWritten += affectedRecords.length;

    // Cache cleanup: drop stale entries for all modified prefix paths
    if (this.cacheInstance) {
      const processedPrefixes = new Set();
      for (const record of affectedRecords) {
        let activePrefix = '';
        for (const char of record.query) {
          activePrefix += char;
          if (!processedPrefixes.has(activePrefix)) {
            processedPrefixes.add(activePrefix);
            this.cacheInstance.clearPrefix(activePrefix);
          }
        }
      }
    }

    const totalBufferedCount = [...deltasToApply.values()].reduce((acc, count) => acc + count, 0);
    appLogger.info('batch', `Write buffer flush [Trigger: ${flushTrigger}]: Consolidated ${totalBufferedCount} searches into ${affectedRecords.length} store updates.`);
    return affectedRecords.length;
  }

  initializePeriodicFlush() {
    this.flushTimer = setInterval(
      () => this.processFlush('scheduled-interval'),
      this.batchSettings.flushIntervalMs
    );
    if (this.flushTimer && this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  terminatePeriodicFlush() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
  }

  getBufferStats() {
    const reductionRatio = this.totalIngestedSearches === 0
      ? 0
      : +(1 - this.uniqueStoreUpdatesWritten / this.totalIngestedSearches).toFixed(4);

    return {
      searchesReceived: this.totalIngestedSearches,
      flushes: this.flushOperationsRun,
      writesIssued: this.uniqueStoreUpdatesWritten,
      pendingInBuffer: this.pendingDeltas.size,
      writeReduction: reductionRatio,
    };
  }
}

module.exports = { WriteBuffer };
