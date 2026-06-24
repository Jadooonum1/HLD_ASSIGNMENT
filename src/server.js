'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const config = require('../config');
const appLogger = require('./appLogger');
const { StoreManager } = require('./storeManager');
const { CacheManager } = require('./cacheManager');
const { TrendTracker } = require('./trendTracker');
const { WriteBuffer } = require('./writeBuffer');
const { StatsTracker } = require('./statsTracker');
const { QuerySuggester } = require('./querySuggester');

const ROOT_DIR = path.join(__dirname, '..');
const resolvePath = (relative) => path.join(ROOT_DIR, relative);

// 1. Initialize the primary storage manager and load datasets.
const store = new StoreManager();
const snapshotPath = resolvePath(config.dataset.snapshotPath);
const csvPath = resolvePath(config.dataset.csvPath);

let isLoaded = false;
if (fs.existsSync(snapshotPath)) {
  try {
    store.ingestFromSnapshot(snapshotPath);
    isLoaded = store.totalUniqueQueries() > 0;
  } catch (err) {
    appLogger.warn('boot', `Snapshot load failed (${err}). Falling back to CSV dataset.`);
  }
}

if (!isLoaded) {
  if (fs.existsSync(csvPath)) {
    store.ingestFromCsv(csvPath);
  } else {
    appLogger.error('boot', `No dataset file located. Please run "npm run generate-data" first.`);
    process.exit(1);
  }
}

if (store.totalUniqueQueries() < config.dataset.minSize) {
  appLogger.warn('boot', `Current dataset size (${store.totalUniqueQueries()}) is below target limit (${config.dataset.minSize}).`);
}

// 2. Initialize logical nodes (distributed cache, metrics, search trend buffers, search suggesters).
const cache = new CacheManager(config.cache);
const trendTracker = new TrendTracker(config.recency);
const statsTracker = new StatsTracker(config.metrics);
const writeBuffer = new WriteBuffer({ primaryStore: store, cache, config });
const querySuggester = new QuerySuggester({ primaryStore: store, cache, recencyTracker: trendTracker });

// 3. Setup recurring tasks (flushing the in-memory write buffer, snapshots, and trending trend pruning).
writeBuffer.initializePeriodicFlush();

const snapshotTimer = setInterval(() => {
  writeBuffer.processFlush('scheduled-snapshot'); // Consolidate buffer details first
  store.writeStoreSnapshot(snapshotPath); // Backup state to database snapshot
}, config.dataset.snapshotIntervalMs);
snapshotTimer.unref();

const purgeTimer = setInterval(() => trendTracker.purgeStaleTrends(), 60 * 1000);
purgeTimer.unref();

// 4. Initialize Express HTTP Interface
const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT_DIR, 'public')));

// Safe async/sync endpoint wrapper
const requestWrapper = (routeHandler) => (req, res) => {
  try {
    routeHandler(req, res);
  } catch (error) {
    appLogger.error('api', `Failure in ${req.method} ${req.path}`, String(error.stack || error));
    res.status(500).json({ error: 'internal_server_error' });
  }
};

// GET /suggest?q=<prefix>&mode=base|recency
app.get('/suggest', requestWrapper((req, res) => {
  const startTimer = process.hrtime.bigint();
  const responseData = querySuggester.retrieveSuggestions(req.query.q, req.query.mode);
  const latency = Number(process.hrtime.bigint() - startTimer) / 1e6; // to Milliseconds
  
  statsTracker.logSuggestLatency(latency);
  
  res.json({
    prefix: responseData.prefix,
    mode: responseData.mode,
    source: responseData.source,
    cacheHit: responseData.cacheHit,
    ownerNode: responseData.ownerNode,
    latencyMs: +latency.toFixed(3),
    count: responseData.suggestions.length,
    suggestions: responseData.suggestions,
  });
}));

// POST /search  body: { "query": "..." }
app.post('/search', requestWrapper((req, res) => {
  const rawSearchQuery = req.body && req.body.query;
  if (typeof rawSearchQuery !== 'string' || rawSearchQuery.trim().length === 0) {
    res.status(400).json({ error: 'Valid query parameter is required' });
    return;
  }

  const standardizedTerm = QuerySuggester.standardizeQueryText(rawSearchQuery);
  trendTracker.registerSearch(standardizedTerm);
  cache.clearAllPrefixesForQuery(standardizedTerm);
  writeBuffer.queueSearch(standardizedTerm);

  res.json({ message: 'Searched', query: standardizedTerm });
}));

// GET /trending
app.get('/trending', requestWrapper((req, res) => {
  res.json({ trending: trendTracker.getHotTrends() });
}));

// GET /cache/debug?prefix=<prefix>
app.get('/cache/debug', requestWrapper((req, res) => {
  const prefix = QuerySuggester.standardizeQueryText(req.query.prefix);
  if (!prefix) {
    res.status(400).json({ error: 'Prefix query parameter is required' });
    return;
  }
  res.json(cache.debugPrefix(prefix));
}));

// GET /metrics
app.get('/metrics', requestWrapper((req, res) => {
  const cacheStats = cache.collectStats();
  res.json({
    latency: statsTracker.getReport(),
    cache: {
      hits: cacheStats.hits,
      misses: cacheStats.misses,
      hitRate: cacheStats.hitRate,
      nodeCount: cacheStats.nodeCount,
      nodes: cacheStats.nodes,
    },
    primaryStore: store.getStoreMetrics(),
    batch: writeBuffer.getBufferStats(),
    recency: {
      trackedQueries: trendTracker.trackedItemsCount(),
      halfLifeMs: config.recency.halfLifeMs,
    },
    dataset: {
      size: store.totalUniqueQueries(),
    },
  });
}));

// GET /health
app.get('/health', requestWrapper((req, res) => {
  res.json({ status: 'ok' });
}));

// 5. Start Server & Setup Clean Shutdown Hooks
const server = app.listen(config.port, () => {
  appLogger.info('boot', `Server running. Port: ${config.port}. Base URL: http://localhost:${config.port}`);
  appLogger.info('boot', `Cache Ring Nodes: ${config.cache.nodeCount} | Base dataset size: ${store.totalUniqueQueries().toLocaleString()} queries`);
});

let isShuttingDown = false;
function handleShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  appLogger.info('shutdown', `Received signal: ${signal}. Saving snapshot of records before exiting...`);
  try {
    writeBuffer.terminatePeriodicFlush();
    writeBuffer.processFlush('shutdown-cleanup');
    store.writeStoreSnapshot(snapshotPath);
  } catch (error) {
    appLogger.error('shutdown', 'Error during graceful teardown snapshot dump', String(error));
  }

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

module.exports = { app, server };
