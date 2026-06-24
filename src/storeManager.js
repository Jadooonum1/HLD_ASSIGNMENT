'use strict';

const fs = require('fs');
const path = require('path');
const { TrieIndex } = require('./trieIndex');
const appLogger = require('./appLogger');

/**
 * StoreManager serves as the authoritative source of truth for query search volumes.
 * Holds count maps and syncs with the TrieIndex for fast prefix-matching candidate retrievals.
 */
class StoreManager {
  constructor() {
    this.allTimeCounts = new Map(); // queryText -> popularityCount
    this.prefixTrie = new TrieIndex(); // Index structures for lookups
    this.readCounter = 0;
    this.writeCounter = 0;
    this.loadedRecordCount = 0;
  }

  bulkRegister(queryText, popularityCount) {
    this.allTimeCounts.set(queryText, popularityCount);
    this.prefixTrie.insertQuery(queryText, popularityCount);
  }

  /**
   * Loads initial database records from a CSV file.
   */
  ingestFromCsv(filePath) {
    const rawData = fs.readFileSync(path.resolve(filePath), 'utf8');
    const records = rawData.split(/\r?\n/);
    let successfullyLoaded = 0;

    for (let index = 0; index < records.length; index++) {
      const row = records[index];
      if (!row) continue;
      // Skip header
      if (index === 0 && row.toLowerCase().startsWith('query,')) continue;

      const delimiterIndex = row.lastIndexOf(',');
      if (delimiterIndex === -1) continue;

      const queryVal = row.slice(0, delimiterIndex).trim().toLowerCase();
      const countVal = parseInt(row.slice(delimiterIndex + 1).trim(), 10);

      if (!queryVal || !Number.isFinite(countVal)) continue;

      this.bulkRegister(queryVal, countVal);
      successfullyLoaded++;
    }

    this.loadedRecordCount = successfullyLoaded;
    appLogger.info('store', `Parsed CSV dataset successfully. Registered ${successfullyLoaded.toLocaleString()} records from ${filePath}`);
    return successfullyLoaded;
  }

  /**
   * Re-hydrates state from a previous JSON snapshot of counts.
   */
  ingestFromSnapshot(snapshotPath) {
    const rawJson = fs.readFileSync(path.resolve(snapshotPath), 'utf8');
    const parsedState = JSON.parse(rawJson);
    let successfullyLoaded = 0;

    const keys = Object.keys(parsedState);
    for (const key of keys) {
      if (key === '__proto__') continue;
      this.bulkRegister(key, parsedState[key]);
      successfullyLoaded++;
    }

    this.loadedRecordCount = successfullyLoaded;
    appLogger.info('store', `Loaded state snapshot successfully. Restored ${successfullyLoaded.toLocaleString()} records from ${snapshotPath}`);
    return successfullyLoaded;
  }

  /**
   * Retrieve list of matching candidate terms from the index.
   */
  fetchPrefixCandidates(prefixQuery) {
    this.readCounter++;
    return this.prefixTrie.findMatches(prefixQuery);
  }

  retrieveSearchCount(queryText) {
    this.readCounter++;
    return this.allTimeCounts.get(queryText) || 0;
  }

  /**
   * Applies increments batched up in the WriteBuffer.
   */
  batchApplyIncrements(incrementDeltas) {
    const modifiedRecords = [];
    for (const [queryText, deltaCount] of incrementDeltas) {
      const updatedCount = (this.allTimeCounts.get(queryText) || 0) + deltaCount;
      this.allTimeCounts.set(queryText, updatedCount);
      this.prefixTrie.insertQuery(queryText, updatedCount);
      this.writeCounter++;
      modifiedRecords.push({ query: queryText, count: updatedCount });
    }
    return modifiedRecords;
  }

  /**
   * Atomically save current count map to a JSON file.
   */
  writeStoreSnapshot(snapshotPath) {
    const absolutePath = path.resolve(snapshotPath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

    const exportMap = {};
    for (const [query, count] of this.allTimeCounts) {
      exportMap[query] = count;
    }

    const tempFilePath = `${absolutePath}.tmp`;
    fs.writeFileSync(tempFilePath, JSON.stringify(exportMap), 'utf8');
    fs.renameSync(tempFilePath, absolutePath);
  }

  totalUniqueQueries() {
    return this.allTimeCounts.size;
  }

  getStoreMetrics() {
    return {
      reads: this.readCounter,
      writes: this.writeCounter,
      size: this.allTimeCounts.size,
    };
  }
}

module.exports = { StoreManager };
