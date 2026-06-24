'use strict';

/**
 * Central configuration. Everything tunable lives here so design choices are
 * easy to find and explain in the viva.
 */
module.exports = {
  // HTTP server
  port: Number(process.env.PORT) || 3000,

  // Dataset / primary store
  dataset: {
    csvPath: './data/queries.csv',          // seed dataset (query,count)
    snapshotPath: './data/primary-store.json', // where counts are persisted
    snapshotIntervalMs: 30 * 1000,          // how often to save counts to disk
    minSize: 100000,                        // assignment minimum dataset size
  },

  // Suggestions
  suggestions: {
    limit: 10,              // return at most 10 suggestions
    defaultMode: 'recency', // 'base' = by count (basic) | 'recency' = recency-aware
  },

  // Distributed cache (consistent hashing)
  cache: {
    nodeCount: 4,             // number of logical cache nodes
    virtualNodesPerNode: 150, // vnodes per node -> even key distribution
    ttlMs: 10 * 1000,         // cache entry time-to-live (expiry)
    maxEntriesPerNode: 5000,  // memory cap per node
  },

  // Recency / trending
  recency: {
    halfLifeMs: 10 * 60 * 1000, // recency score halves every 10 min (decay)
    trendingLimit: 10,
  },

  // Recency-aware score = popularityWeight*log10(1+count) + recencyWeight*recentScore
  scoring: {
    popularityWeight: 1.0,
    recencyWeight: 3.0,
  },

  // Batch writes
  batch: {
    maxBufferSize: 500,    // flush when this many distinct queries are buffered
    flushIntervalMs: 2000, // ...or at least this often
  },

  // Metrics
  metrics: {
    latencyWindow: 5000, // recent /suggest latency samples kept for percentiles
  },
};
