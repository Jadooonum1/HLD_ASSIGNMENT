'use strict';

const { HashRing } = require('./hashRing');
const { CacheShard } = require('./cacheShard');
const appLogger = require('./appLogger');

/**
 * CacheManager routes prefix keys using consistent hashing across logical CacheShards.
 */
class CacheManager {
  constructor(options = {}) {
    const nodeCount = options.nodeCount || 4;
    const vnodes = options.virtualNodesPerNode || 150;
    const maxEntries = options.maxEntriesPerNode || 5000;

    this.cacheTtlMs = options.ttlMs || 10000;
    this.shards = new Map();

    const shardIds = [];
    for (let i = 0; i < nodeCount; i++) {
      const id = `cache-node-${i}`;
      shardIds.push(id);
      this.shards.set(id, new CacheShard(id, { maxEntries }));
    }

    this.consistentRing = new HashRing(shardIds, vnodes);

    // Initial check of ring distribution balance
    const sampleKeys = Array.from({ length: 5000 }, (_, index) => `sample-query-${index}`);
    appLogger.info('cache', `Consistent Ring setup complete. Ownership spread over 5000 keys:`,
      this.consistentRing.verifyDistribution(sampleKeys));
  }

  generateCompositeKey(prefix, mode) {
    return `${mode}:${prefix}`;
  }

  getShardForPrefix(prefix) {
    const nodeId = this.consistentRing.routeKey(prefix);
    return this.shards.get(nodeId);
  }

  getSuggestions(prefix, mode) {
    const shard = this.getShardForPrefix(prefix);
    if (!shard) return null;
    return shard.retrieve(this.generateCompositeKey(prefix, mode));
  }

  setSuggestions(prefix, mode, list) {
    const shard = this.getShardForPrefix(prefix);
    if (shard) {
      shard.store(this.generateCompositeKey(prefix, mode), list, this.cacheTtlMs);
    }
  }

  /**
   * Clear both ranking variants of a specific prefix on its owning cache node.
   */
  clearPrefix(prefix) {
    const shard = this.getShardForPrefix(prefix);
    if (!shard) return;
    shard.evict(this.generateCompositeKey(prefix, 'base'));
    shard.evict(this.generateCompositeKey(prefix, 'recency'));
  }

  /**
   * Invalidates all rolling prefixes of a newly searched query term.
   */
  clearAllPrefixesForQuery(queryText) {
    let currentPrefix = '';
    for (const char of queryText) {
      currentPrefix += char;
      this.clearPrefix(currentPrefix);
    }
  }

  /**
   * Exposes detailed location and hit status for diagnostic endpoints.
   */
  debugPrefix(prefix) {
    const detailedInfo = this.consistentRing.getDetailedRouting(prefix);
    const shard = this.shards.get(detailedInfo.node);
    const hasCachedValue = shard && (
      shard.hasActiveEntry(this.generateCompositeKey(prefix, 'base')) ||
      shard.hasActiveEntry(this.generateCompositeKey(prefix, 'recency'))
    );

    return {
      prefix,
      ownerNode: detailedInfo.node,
      keyHash: detailedInfo.keyHash,
      ownerPointHash: detailedInfo.ownerPointHash,
      cached: !!hasCachedValue,
      status: hasCachedValue ? 'HIT' : 'MISS',
    };
  }

  collectStats() {
    let hits = 0;
    let misses = 0;
    const nodeReports = [];

    for (const shard of this.shards.values()) {
      const report = shard.getPerformanceReport();
      hits += report.hits;
      misses += report.misses;
      nodeReports.push(report);
    }

    const totalRequests = hits + misses;
    const calculatedHitRate = totalRequests === 0 ? 0 : +(hits / totalRequests).toFixed(4);

    return {
      hits,
      misses,
      hitRate: calculatedHitRate,
      nodeCount: this.shards.size,
      nodes: nodeReports,
    };
  }
}

module.exports = { CacheManager };
