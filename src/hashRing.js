'use strict';

const crypto = require('crypto');

/**
 * Computes an unsigned 32-bit integer hash from the MD5 digest of a key.
 */
function computeHash(key) {
  const md5Digest = crypto.createHash('md5').update(key).digest();
  return md5Digest.readUInt32BE(0);
}

/**
 * Consistent Hash Ring representing logical cache distribution.
 */
class HashRing {
  constructor(nodeIdentifiers = [], virtualNodeCount = 150) {
    this.virtualNodeCount = virtualNodeCount;
    this.nodeIdentifiers = [];
    this.hashRingPoints = []; // Sorted list of { hashVal, nodeId }

    for (const nodeId of nodeIdentifiers) {
      this.registerNodePoints(nodeId);
    }
    this.sortRing();
  }

  registerNodePoints(nodeId) {
    if (this.nodeIdentifiers.includes(nodeId)) return;
    this.nodeIdentifiers.push(nodeId);
    for (let i = 0; i < this.virtualNodeCount; i++) {
      const vnodeKey = `${nodeId}#${i}`;
      this.hashRingPoints.push({ hashVal: computeHash(vnodeKey), nodeId });
    }
  }

  sortRing() {
    this.hashRingPoints.sort((x, y) => x.hashVal - y.hashVal);
  }

  registerNode(nodeId) {
    this.registerNodePoints(nodeId);
    this.sortRing();
  }

  deregisterNode(nodeId) {
    this.nodeIdentifiers = this.nodeIdentifiers.filter((id) => id !== nodeId);
    this.hashRingPoints = this.hashRingPoints.filter((pt) => pt.nodeId !== nodeId);
  }

  /**
   * Search for the first physical/virtual node on the ring with a hash >= hashVal.
   * Wraps around to 0 if the query is greater than all values on the ring.
   */
  binarySearchNode(hashVal) {
    let lowerBound = 0;
    let upperBound = this.hashRingPoints.length;
    while (lowerBound < upperBound) {
      const midpoint = (lowerBound + upperBound) >> 1;
      if (this.hashRingPoints[midpoint].hashVal < hashVal) {
        lowerBound = midpoint + 1;
      } else {
        upperBound = midpoint;
      }
    }
    return lowerBound % this.hashRingPoints.length;
  }

  /**
   * Routes a prefix key to its corresponding owning cache node.
   */
  routeKey(prefixKey) {
    if (this.hashRingPoints.length === 0) return null;
    const itemHash = computeHash(prefixKey);
    const destinationIndex = this.binarySearchNode(itemHash);
    return this.hashRingPoints[destinationIndex].nodeId;
  }

  /**
   * Returns a detailed mapping structure for logs/debug endpoints.
   */
  getDetailedRouting(prefixKey) {
    if (this.hashRingPoints.length === 0) {
      return { node: null, keyHash: null, ownerPointHash: null };
    }
    const itemHash = computeHash(prefixKey);
    const destinationIndex = this.binarySearchNode(itemHash);
    const matchNodePoint = this.hashRingPoints[destinationIndex];
    return {
      node: matchNodePoint.nodeId,
      keyHash: itemHash,
      ownerPointHash: matchNodePoint.hashVal,
    };
  }

  /**
   * Provides statistics on how sampled keys are distributed across nodes.
   */
  verifyDistribution(sampleKeys) {
    const counts = {};
    for (const nodeId of this.nodeIdentifiers) {
      counts[nodeId] = 0;
    }
    for (const key of sampleKeys) {
      const nodeOwner = this.routeKey(key);
      if (counts[nodeOwner] !== undefined) {
        counts[nodeOwner]++;
      }
    }
    return counts;
  }
}

module.exports = { HashRing, computeHash };
