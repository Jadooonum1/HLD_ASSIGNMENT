# Design Document — Search Typeahead System

What the system does, how each part works, and **why** each choice was made. The last section is a **viva Q&A** to rehearse from.

---

## 1. Goals & non-goals

**Goals (from the assignment):** suggest up to 10 popular queries for a prefix (by count, and a recency-aware variant); record searches and update counts; serve suggestions with low latency using a **cache before** the primary store; distribute the cache across logical nodes with **consistent hashing**; support **trending** and **batch writes**.

**Non-goals:** auth, multi-machine deployment, a production database. These are simulated in one Node process so the *data-system design* can be shown and explained on a single machine (no Docker/DB to set up).

---

## 2. Component architecture

```
                  Browser (public/) — search box, debounced suggest,
                  keyboard nav, trending, live metrics
                       │ GET /suggest        │ POST /search
                       ▼                      ▼
        ┌───────────────────────────┐   ┌──────────────────────────────────┐
        │     SuggestionService     │   │ RecencyTracker.record() (instant) │
        │ 1) cache.get(prefix)      │   │ cache.invalidatePrefixesOf(query) │
        │     hit → return          │   │ BatchWriter.add() → buffer        │
        │ 2) store.suggestCandidates│   └───────────────┬───────────────────┘
        │     (Trie subtree)        │                   │ flush (size / timer)
        │ 3) scoring.rank() top-10  │                   ▼
        │ 4) cache.set()            │         PrimaryStore.applyDeltas()
        └───────────┬───────────────┘            (counts Map + Trie)
                    │ miss                              │ periodic snapshot
                    ▼                                   ▼
        ┌───────────────────────────┐         data/primary-store.json
        │ DistributedCache          │
        │  HashRing (consistent     │
        │  hashing) + N CacheNode   │
        │  (TTL + size cap)         │
        └───────────────────────────┘
```

| Module | Responsibility |
|---|---|
| `primaryStore.js` | Source of truth: `Map<query,count>` + Trie index + read/write counters + snapshot |
| `trie.js` | Prefix index — O(prefix length) to the branch |
| `suggestionService.js` | Read path: cache → store → rank → fill cache |
| `scoring.js` | `base` = count; `recency` = `log10(count)` + decayed recent activity |
| `recencyTracker.js` | Time-decayed recency + trending |
| `consistentHash.js` | Hash ring with virtual nodes |
| `cacheNode.js` | One cache node: TTL expiry + size cap |
| `distributedCache.js` | N nodes + routing + invalidation |
| `batchWriter.js` | Buffer, aggregate duplicates, flush |
| `metrics.js` | Latency percentiles |

---

## 3. Data model

- **Primary store:** `Map<query, count>` (authoritative all-time count), persisted as JSON.
- **Trie:** each terminal node holds `{ query, count }`; built from the store, kept in sync on every update.
- **Recency:** `Map<query, { score, lastUpdate }>` — a *decaying* counter, separate from the all-time count.
- **Cache entry:** key `"<mode>:<prefix>"` → `{ value: top10, expiresAt }`, on the node the **prefix** hashes to.

Queries are normalized (trim + lowercase) on read and write, so `IPhone` and `iphone` are the same key — that's how mixed-case input is handled.

---

## 4. Request flows

### `GET /suggest?q=<prefix>&mode=`
1. Normalize the prefix. Empty → return `[]` (box shows nothing; Trending fills that space).
2. `cache.get(prefix, mode)` — the prefix is hashed onto the ring to its owning node.
   - **Hit** → return cached top-10 (no store read, no ranking). ~99% of requests.
   - **Miss** → continue.
3. `store.suggestCandidates(prefix)` walks the Trie and collects completions (a store read).
4. `scoring.rank()` scores + sorts, keeps top 10.
5. `cache.set()` stores the result with a TTL; return it.

### `POST /search { query }`
1. Validate + normalize.
2. `recency.record(query)` — instantly bumps recency, so Trending updates now.
3. `cache.invalidatePrefixesOf(query)` — drops cached suggestions for every prefix of the query.
4. `batchWriter.add(query)` — buffers for a batched count update (not written now).
5. Return `{ "message": "Searched", "query": "<normalized>" }`.

> **Eventual consistency (by design):** a brand-new query (not in the dataset) shows in *Trending* immediately, but in *suggestions* only after the next batch flush inserts it into the Trie (≤ ~2s). The spec allows this ("the update should *eventually* be reflected").

---

## 5. Suggestion index — why a Trie

The core operation is "all queries starting with prefix P". A **Trie** reaches P in `O(|P|)` and then only visits the matching subtree — it never scans the 120k dataset. That's the textbook autocomplete structure.

- **Complexity:** `O(|P| + M)` where M = completions under P, then a top-10 sort.
- **Alternative:** a sorted array + binary-search range is a valid lighter option (I can explain both).
- **Scaling note:** for a huge dataset you'd cache a precomputed **top-K per Trie node** so short prefixes don't walk a big subtree. Not needed here — the dataset is bounded and the cache absorbs repeats.

---

## 6. Caching layer

- **Why:** suggestions are read on every keystroke and hot prefixes (`i`, `ip`, `iph`) repeat constantly. Caching the top-10 per prefix turns most reads into one map lookup. Measured hit rate ≈ **99.8%**, cutting store reads from 20,000 to ≈35.
- **What's cached:** the top-10 array per `(prefix, mode)`.
- **Expiry (TTL):** entries expire (default 10s) so a stale result can't live forever — recency-driven changes surface within a bounded window even without explicit invalidation.
- **Explicit invalidation:** every `POST /search` deletes cached entries for all prefixes of that query, so the change is visible on the next request (precise), with TTL as the safety net.
- **Size cap + FIFO eviction:** each node caps entries and evicts the oldest to bound memory.

---

## 7. Consistent hashing

**Problem:** distribute prefix keys across N cache nodes so that adding/removing a node doesn't wipe the whole cache.

**Naive `hash(key) % N`** remaps almost *every* key when N changes (the modulus changes) — a cache stampede. **Consistent hashing** places nodes and keys on a circular hash space `[0, 2³²)`; a key is owned by the first node clockwise. Changing N moves only the arc that changed — about **1/N** of keys.

**Virtual nodes:** each physical node is hashed to ~150 points on the ring, so ownership is even (one node can't randomly own a huge arc). Measured over 5,000 sample keys across 4 nodes: roughly 25% each.

**Implementation** (`consistentHash.js`): MD5(key) → first 4 bytes as a uint32 (MD5 as a fast, well-distributed hash, not for security; `crypto` is built into Node so zero extra deps). The ring is a sorted `{hash, nodeId}` array; ownership is a binary search for the first point ≥ the key's hash, wrapping to index 0. `GET /cache/debug?prefix=` shows the owning node live.

---

## 8. Trending & recency (the +20%)

The assignment asks four things:

**1) How recent searches are tracked.** Each query keeps `{ score, lastUpdate }`. On each search we decay the old score to *now*, then add 1:

```
score = score · 2^(−(now − lastUpdate)/halfLife) + 1
```

**2) How recent activity affects ranking.** `scoring.js` blends popularity with recency:

```
finalScore = popularityWeight · log10(1 + count)  +  recencyWeight · recencyScore(query)
```

We use `log10(count)`, not raw count: all-time counts span orders of magnitude (100,000 vs 50) and would drown out any recent signal; `log10` compresses them so recency can move the order. (Demo: `iphone 15 pro max`, count 6 but recently hot, outranks `iphone 15` at 85,000.)

**3) How we avoid permanently over-ranking a brief spike.** The recency term **decays exponentially** — a burst fades on its own once the query goes quiet (half each half-life). Nothing manually expires a trend; only *sustained* activity stays high.

**4) How the cache is updated/invalidated when rankings change.** Explicit per-prefix invalidation on each `POST /search` (immediate) plus a short TTL (bounds time-decay staleness). Together: fresh rankings without a global cache flush.

`/trending` ranks by **pure** decayed recency (what's hot now) — intentionally different from the blended suggestion ranking.

---

## 9. Batch writes (the other +20%)

**Goal:** never write to the store on every search.

1. **Buffer:** `POST /search` adds to an in-memory `Map<query, deltaCount>`. Repeated queries are **aggregated** (50 searches for `iphone` in one window → a single `+50`).
2. **Flush triggers:** when the buffer holds `maxBufferSize` (500) distinct queries **or** every `flushIntervalMs` (2s), whichever first.
3. **Apply:** `store.applyDeltas(buffer)` upserts each distinct query once (one write per distinct query) and updates the Trie; then affected prefixes are invalidated in the cache.

**Write reduction (measured):** 5,000 searches → ≈36 store writes ≈ **99% fewer writes**. Two effects compound: duplicates collapse within a window, and each distinct query is a single upsert per flush.

**Failure trade-off (the assignment asks us to discuss this):** the buffer is in memory, so if the app **crashes before a flush**, the searches buffered since the last flush are lost. For a popularity counter this is acceptable — we lose a few counts, not correctness, and counts are inherently approximate. A production system would add a **write-ahead log or a durable queue** (e.g. Kafka) so the buffer can be recovered after a crash; we deliberately keep the demo simple and just document this. The periodic snapshot also bounds loss to at most one flush/snapshot interval.

---

## 10. Metrics & performance

`GET /metrics` reports latency percentiles (p50/p95/p99 of the `/suggest` compute), cache hit rate + per-node sizes, store reads/writes, and batch write-reduction. From `npm run benchmark`:

- Suggest **p95 ≈ 0.013 ms** (server compute), **99.8%** hit rate, ≈35 store reads / 20k requests.
- **≈99%** write reduction (5,000 → ≈36 writes).

We track **p95/p99**, not just the average, because a typeahead's felt quality is in the tail.

---

## 11. Trade-offs summary

| Decision | Chosen | Trade-off |
|---|---|---|
| Index | Trie | More memory than a sorted array; canonical |
| Cache freshness | TTL + prefix invalidation | Lower TTL = fresher but more misses |
| Ranking | `log10(count)` + decayed recency | Weight tuning is a judgment call (in config) |
| Writes | Batch buffer + flush | Counts eventually consistent; buffer lost on crash (documented) |
| Persistence | Periodic JSON snapshot | Simple; a real DB would write incrementally |
| Cache distribution | Consistent hashing + 150 vnodes | More ring memory; far better rebalancing than `% N` |

---

## 12. What would change in production

- Primary store → Postgres/DynamoDB/Cassandra with atomic count increments.
- Cache nodes → real Redis/Memcached instances on separate hosts; same consistent-hash client.
- Batch buffer → Kafka (durable) + a consumer that aggregates and writes counts.
- Trie → precomputed per-node top-K, or an Elasticsearch completion suggester.

The design here maps 1:1 onto those components.

---

## 13. Known limitations

- Single process: the "distributed" cache nodes are in-process objects (they demonstrate distribution + consistent hashing; not separate hosts).
- Snapshot rewrites the whole file each interval — fine at 120k rows, not for tens of millions.
- New queries need one flush before showing in suggestions (by design; trending is instant).
- Counts buffered since the last flush are lost on a crash (documented trade-off above).

---

## 14. Viva Q&A — rehearse these

**Q: Why a Trie and not just filtering a list?**
A Trie reaches the prefix branch in O(prefix length) and walks only matching completions, independent of dataset size; a scan is O(N) per query. (A sorted-array + binary-search range is a valid lighter alternative.)

**Q: Walk me through a `/suggest` call.**
Normalize → cache lookup (prefix hashed to its node) → hit returns top-10; miss reads the Trie subtree, ranks, caches, returns. ~99.8% hit the cache.

**Q: Why consistent hashing instead of `hash % N`?**
`% N` remaps almost all keys when N changes, wiping the cache. Consistent hashing moves only ~1/N. Virtual nodes (~150/node) keep ownership balanced (~25% each over 4 nodes).

**Q: How do you decide which node owns a prefix?**
MD5(prefix) → uint32 → first ring point clockwise (binary search, wrap to 0). `GET /cache/debug?prefix=ip` shows it live.

**Q: How does recency ranking work, and why log of count?**
`score = log10(1+count) + 3·decayedRecency`. Raw counts (up to 100k) would dominate; log10 compresses them so recent activity can change the order. Demo: count 6 + a recent burst beats count 85,000.

**Q: How do you avoid permanently over-ranking a one-day spike?**
The recency term decays exponentially (10-min half-life). Once searches stop, the boost halves each half-life and disappears. Only sustained activity stays ranked.

**Q: How do batch writes reduce DB load, and what's the failure mode?**
Searches are buffered and duplicates aggregated; we flush by size or timer, upserting each distinct query once — ~99% fewer writes. If the process crashes before a flush, the buffered counts since the last flush are lost; a production system would use a write-ahead log / Kafka. Counts are eventually consistent, which is fine for popularity.

**Q: How is the cache kept fresh?**
Explicit invalidation of a query's prefixes on every search (immediate), plus a TTL that bounds staleness from time decay.

**Q: How would you scale to millions of QPS / a huge dataset?**
Real Redis nodes behind the same ring, a real DB with atomic increments, Kafka as the durable write log + an aggregating consumer, and precomputed per-node top-K (or an ES completion suggester).
