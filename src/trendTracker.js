'use strict';

const config = require('../config');

/**
 * TrendTracker manages search queries' recency calculations using exponential time-decay.
 * Popular query bursts fade over time unless sustained.
 */
class TrendTracker {
  constructor(options = {}) {
    this.halfLifeInterval = options.halfLifeMs || config.recency.halfLifeMs;
    this.decayConstant = Math.LN2 / this.halfLifeInterval; // Exponential decay factor lambda
    this.trendingScores = new Map(); // queryText -> { scoreVal, lastAccessTime }
  }

  calculateDecay(scoreRecord, timestampNow) {
    const elapsed = timestampNow - scoreRecord.lastAccessTime;
    if (elapsed <= 0) return scoreRecord.scoreVal;
    return scoreRecord.scoreVal * Math.exp(-this.decayConstant * elapsed);
  }

  /**
   * Bumps the recency score for a search term, applying decay beforehand.
   */
  registerSearch(queryText, timestampNow = Date.now()) {
    const record = this.trendingScores.get(queryText);
    if (!record) {
      this.trendingScores.set(queryText, { scoreVal: 1, lastAccessTime: timestampNow });
    } else {
      record.scoreVal = this.calculateDecay(record, timestampNow) + 1;
      record.lastAccessTime = timestampNow;
    }
  }

  /**
   * Gets the decayed score of a query without recording a new search.
   */
  getDecayedScore(queryText, timestampNow = Date.now()) {
    const record = this.trendingScores.get(queryText);
    return record ? this.calculateDecay(record, timestampNow) : 0;
  }

  /**
   * Returns the top trending items based on decayed popularity.
   */
  getHotTrends(countLimit = config.recency.trendingLimit, timestampNow = Date.now()) {
    const list = [];
    const minThreshold = 0.01;

    for (const [query, record] of this.trendingScores) {
      const activeScore = this.calculateDecay(record, timestampNow);
      if (activeScore > minThreshold) {
        list.push({ query, score: +activeScore.toFixed(4) });
      }
    }

    // Sort descending by score, resolve ties alphabetically
    list.sort((first, second) => second.score - first.score || (first.query < second.query ? -1 : 1));
    return list.slice(0, countLimit);
  }

  /**
   * Deletes elements with scores below threshold to reclaim memory.
   */
  purgeStaleTrends(timestampNow = Date.now(), minThreshold = 0.01) {
    for (const [query, record] of this.trendingScores) {
      if (this.calculateDecay(record, timestampNow) < minThreshold) {
        this.trendingScores.delete(query);
      }
    }
  }

  trackedItemsCount() {
    return this.trendingScores.size;
  }
}

module.exports = { TrendTracker };
