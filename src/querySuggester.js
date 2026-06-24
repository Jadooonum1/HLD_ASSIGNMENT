'use strict';

const rankingScorer = require('./rankingScorer');
const config = require('../config');

/**
 * QuerySuggester orchestrates suggestion lookups. Implements "Cache-Aside" pattern
 * by querying the consistent hash cache ring before falling back to store searches.
 */
class QuerySuggester {
  constructor(options = {}) {
    this.storeInstance = options.primaryStore;
    this.cacheInstance = options.cache;
    this.trendInstance = options.recencyTracker;
    this.maxSuggestionsLimit = config.suggestions.limit;
  }

  /**
   * Format and clean user query strings.
   */
  static standardizeQueryText(textInput) {
    return (typeof textInput === 'string' ? textInput : '').trim().toLowerCase();
  }

  /**
   * Performs autocomplete suggestion resolution.
   */
  retrieveSuggestions(rawPrefix, rawMode) {
    const prefix = QuerySuggester.standardizeQueryText(rawPrefix);
    const mode = rawMode === 'base' || rawMode === 'recency'
      ? rawMode
      : config.suggestions.defaultMode;

    if (prefix.length === 0) {
      return {
        prefix,
        mode,
        source: 'empty',
        cacheHit: false,
        ownerNode: null,
        suggestions: [],
      };
    }

    const destinationNodeId = this.cacheInstance.consistentRing.routeKey(prefix);

    // 1. Check in Distributed Cache
    const cachedMatches = this.cacheInstance.getSuggestions(prefix, mode);
    if (cachedMatches) {
      return {
        prefix,
        mode,
        source: 'cache',
        cacheHit: true,
        ownerNode: destinationNodeId,
        suggestions: cachedMatches,
      };
    }

    // 2. Cache Miss -> Query TrieIndex -> Rank Candidates -> Store in Cache -> Return
    const matches = this.storeInstance.fetchPrefixCandidates(prefix);
    const rankedMatches = rankingScorer.rankQueryCandidates(matches, {
      mode,
      trendTracker: this.trendInstance,
      limit: this.maxSuggestionsLimit,
      now: Date.now(),
    });

    this.cacheInstance.setSuggestions(prefix, mode, rankedMatches);

    return {
      prefix,
      mode,
      source: 'store',
      cacheHit: false,
      ownerNode: destinationNodeId,
      suggestions: rankedMatches,
    };
  }
}

module.exports = { QuerySuggester };
