'use strict';

const config = require('../config');

function computeBaseScore(candidateItem) {
  return candidateItem.count;
}

function computeRecencyScore(candidateItem, trendTracker, timestampMs) {
  const allTimeComponent = config.scoring.popularityWeight * Math.log10(1 + candidateItem.count);
  const recentComponent = config.scoring.recencyWeight * trendTracker.getDecayedScore(candidateItem.query, timestampMs);
  return allTimeComponent + recentComponent;
}

/**
 * Sorts and ranks suggestions matching the prefix search criteria.
 * Dynamic sorting handles alphabetical ties deterministically.
 */
function rankQueryCandidates(candidates, options) {
  const mode = options.mode;
  const trendTracker = options.trendTracker;
  const countLimit = options.limit;
  const timestampMs = options.now;

  const evaluated = candidates.map((item) => {
    const finalScore = mode === 'recency'
      ? computeRecencyScore(item, trendTracker, timestampMs)
      : computeBaseScore(item);

    return {
      query: item.query,
      count: item.count,
      score: finalScore,
    };
  });

  evaluated.sort((x, y) => {
    if (y.score !== x.score) {
      return y.score - x.score;
    }
    // Alphabetical tiebreaker
    return x.query.localeCompare(y.query);
  });

  return evaluated.slice(0, countLimit);
}

module.exports = {
  rankQueryCandidates,
  computeBaseScore,
  computeRecencyScore,
};
