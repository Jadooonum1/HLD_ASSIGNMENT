'use strict';

/**
 * Performance benchmark.
 *
 * Drives a RUNNING server (start it first with `npm start`) and reports the
 * numbers the assignment asks for:
 *   - suggestion latency (client-side p50/p95/p99 + server-reported p95)
 *   - cache hit rate
 *   - store read/write counts and batch write-reduction
 *
 * Usage:
 *   npm start                 # in one terminal
 *   npm run benchmark         # in another
 *
 * Env: BASE_URL (default http://localhost:3000), READS, WRITES, CONCURRENCY.
 */

const config = require('../config');

const BASE = process.env.BASE_URL || `http://localhost:${config.port}`;
const READS = Number(process.env.READS) || 20000;
const WRITES = Number(process.env.WRITES) || 5000;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 50;

// A pool of prefixes that actually exist in the dataset. We pick them with a
// Zipf-like bias so a few hot prefixes repeat — that is what lets the cache
// demonstrate a high hit rate, just like real traffic.
const HOT = ['i', 'ip', 'iph', 'ipho', 'iphone', 'ja', 'jav', 'java', 'py', 'pyt', 'python',
  'how', 'how t', 'best', 'best l', 'sam', 'sams', 'wir', 'wire', 'mac', 'docker', 'react',
  'rea', 'lap', 'lapt', 'che', 'cheap', 'gam', 'gami', 'net', 'ama', 'sys', 'data', 'lea'];

function pickPrefix() {
  // Bias toward the front of the list (hotter) using a squared random index.
  const r = Math.random() ** 2;
  return HOT[Math.floor(r * HOT.length)];
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - rank) + sorted[hi] * (rank - lo);
}

async function runPool(total, concurrency, task) {
  let next = 0;
  const worker = async () => {
    while (next < total) {
      const i = next++;
      await task(i);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function readPhase() {
  console.log(`\n--- READ phase: ${READS.toLocaleString()} GET /suggest (concurrency ${CONCURRENCY}) ---`);
  const latencies = new Float64Array(READS);
  const t0 = process.hrtime.bigint();
  await runPool(READS, CONCURRENCY, async (i) => {
    const q = pickPrefix();
    const s = process.hrtime.bigint();
    const res = await fetch(`${BASE}/suggest?q=${encodeURIComponent(q)}`);
    await res.json();
    latencies[i] = Number(process.hrtime.bigint() - s) / 1e6;
  });
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const sorted = Array.from(latencies).sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  console.log(`Throughput      : ${(READS / (wallMs / 1000)).toFixed(0)} req/s (${wallMs.toFixed(0)} ms wall)`);
  console.log(`Client latency  : avg ${avg.toFixed(3)} ms | p50 ${percentile(sorted, .5).toFixed(3)} | ` +
    `p95 ${percentile(sorted, .95).toFixed(3)} | p99 ${percentile(sorted, .99).toFixed(3)} ms`);
}

async function writePhase() {
  console.log(`\n--- WRITE phase: ${WRITES.toLocaleString()} POST /search (heavy duplication) ---`);
  await runPool(WRITES, CONCURRENCY, async () => {
    const q = pickPrefix(); // reuse hot prefixes as full queries -> lots of duplicates to aggregate
    await fetch(`${BASE}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
  });
  // Give the batch writer a moment to flush.
  await new Promise((r) => setTimeout(r, config.batch.flushIntervalMs + 500));
}

async function report() {
  const res = await fetch(`${BASE}/metrics`);
  const m = await res.json();
  console.log('\n========== SERVER METRICS ==========');
  console.log(`Suggest latency : avg ${m.latency.avgMs} ms | p50 ${m.latency.p50Ms} | ` +
    `p95 ${m.latency.p95Ms} | p99 ${m.latency.p99Ms} ms  (${m.latency.requests.toLocaleString()} reqs)`);
  console.log(`Cache hit rate  : ${(m.cache.hitRate * 100).toFixed(1)}%  ` +
    `(${m.cache.hits.toLocaleString()} hits / ${m.cache.misses.toLocaleString()} misses across ${m.cache.nodeCount} nodes)`);
  console.log('Per-node cache  :', m.cache.nodes.map((n) => `${n.id}=${n.size}`).join('  '));
  console.log(`Store reads     : ${m.primaryStore.reads.toLocaleString()}  (only on cache misses)`);
  console.log(`Store writes    : ${m.primaryStore.writes.toLocaleString()}`);
  console.log(`Searches in     : ${m.batch.searchesReceived.toLocaleString()}`);
  console.log(`Distinct writes : ${m.batch.writesIssued.toLocaleString()}`);
  console.log(`Write reduction : ${(m.batch.writeReduction * 100).toFixed(1)}%  ` +
    `(${m.batch.searchesReceived.toLocaleString()} searches -> ${m.batch.writesIssued.toLocaleString()} store writes)`);
  console.log(`Dataset size    : ${m.dataset.size.toLocaleString()} queries`);
  console.log('====================================\n');
}

async function main() {
  console.log(`Benchmarking ${BASE}`);
  try {
    await fetch(`${BASE}/health`);
  } catch (_) {
    console.error(`Cannot reach ${BASE}. Start the server first with "npm start".`);
    process.exit(1);
  }
  await readPhase();
  await writePhase();
  await report();
}

main();
