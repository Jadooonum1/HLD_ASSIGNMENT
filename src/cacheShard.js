'use strict';

/**
 * CacheShard represents a single logical cache partition/node.
 * Implements standard TTL (Time To Live) and FIFO (First-In, First-Out) capacity eviction.
 */
class CacheShard {
  constructor(shardId, options = {}) {
    this.shardId = shardId;
    this.capacityLimit = options.maxEntries || 5000;
    this.cacheEntries = new Map(); // key -> { storedVal, expirationTime }
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  /**
   * Retrieves an item from the cache shard. Returns null if expired or missing.
   */
  retrieve(key, currentTime = Date.now()) {
    const record = this.cacheEntries.get(key);
    if (!record) {
      this.cacheMisses++;
      return null;
    }
    if (record.expirationTime <= currentTime) {
      // Lazy TTL cleanup
      this.cacheEntries.delete(key);
      this.cacheMisses++;
      return null;
    }
    this.cacheHits++;
    return record.storedVal;
  }

  /**
   * Stores a value in the cache shard, enforcing capacity limits via FIFO eviction.
   */
  store(key, val, ttlMs, currentTime = Date.now()) {
    if (!this.cacheEntries.has(key) && this.cacheEntries.size >= this.capacityLimit) {
      // Evict oldest entry (Map preserves insertion order)
      const oldestKey = this.cacheEntries.keys().next().value;
      if (oldestKey !== undefined) {
        this.cacheEntries.delete(oldestKey);
      }
    }
    this.cacheEntries.set(key, { storedVal: val, expirationTime: currentTime + ttlMs });
  }

  /**
   * Remove a single key from this shard.
   */
  evict(key) {
    return this.cacheEntries.delete(key);
  }

  /**
   * Check if a key exists without mutating cache hits/misses metrics.
   */
  hasActiveEntry(key, currentTime = Date.now()) {
    const record = this.cacheEntries.get(key);
    if (!record) return false;
    if (record.expirationTime <= currentTime) {
      this.cacheEntries.delete(key);
      return false;
    }
    return true;
  }

  entryCount() {
    return this.cacheEntries.size;
  }

  getPerformanceReport() {
    return {
      id: this.shardId,
      size: this.cacheEntries.size,
      hits: this.cacheHits,
      misses: this.cacheMisses,
    };
  }
}

module.exports = { CacheShard };
