'use strict';

/**
 * Dataset generator.
 *
 * The assignment allows any open-source dataset that has `query,count` rows and
 * is at least 100,000 rows. Rather than ship a large third-party file, we
 * generate a realistic synthetic dataset that is:
 *   - reproducible (seeded PRNG, so benchmarks are stable),
 *   - Zipf-distributed (a few very popular queries, a long tail of rare ones,
 *     which is how real search traffic actually looks), and
 *   - prefix-friendly (lots of shared prefixes like "iphone ...", "how to ...").
 *
 * To use a REAL dataset instead, just drop a CSV with a `query,count` header at
 * data/queries.csv (e.g. AOL query logs, Wikipedia page titles + view counts,
 * Amazon product titles, Google Trends exports). The rest of the system does
 * not care where the rows came from.
 *
 * Output: data/queries.csv  (header: query,count)
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const TARGET = Math.max(config.dataset.minSize + 20000, 120000); // comfortably above the 100k minimum

// ---- Deterministic PRNG (mulberry32) so the dataset is reproducible ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(1234567);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// ---- Vocabulary ----
const brands = ['apple', 'samsung', 'google', 'microsoft', 'sony', 'dell', 'hp', 'lenovo', 'asus',
  'nike', 'adidas', 'puma', 'amazon', 'netflix', 'tesla', 'bmw', 'audi', 'toyota', 'honda', 'canon',
  'nikon', 'bose', 'jbl', 'logitech', 'razer', 'intel', 'amd', 'nvidia', 'xiaomi', 'oneplus',
  'oppo', 'vivo', 'realme', 'motorola', 'nokia', 'lg', 'panasonic', 'philips', 'gucci', 'zara'];

const nouns = ['iphone', 'laptop', 'headphones', 'charger', 'monitor', 'keyboard', 'mouse', 'phone',
  'tablet', 'smartwatch', 'camera', 'tv', 'speaker', 'router', 'printer', 'shoes', 'jacket', 'backpack',
  'sunglasses', 'watch', 'wallet', 'bottle', 'chair', 'desk', 'lamp', 'sofa', 'mattress', 'pillow',
  'blender', 'kettle', 'microwave', 'fridge', 'washing machine', 'vacuum cleaner', 'air conditioner',
  'fan', 'heater', 'drone', 'gpu', 'cpu', 'ssd', 'hard drive', 'power bank', 'earbuds', 'controller',
  'console', 'graphics card', 'motherboard', 'ram', 'webcam', 'microphone', 'guitar', 'piano',
  'bicycle', 'treadmill', 'dumbbells', 'yoga mat', 'tent', 'cooler', 'grill', 'coffee maker',
  'java', 'python', 'javascript', 'react', 'nodejs', 'docker', 'kubernetes', 'sql', 'mongodb',
  'redis', 'kafka', 'linux', 'aws', 'azure', 'git', 'html', 'css', 'typescript', 'spring boot',
  'machine learning', 'data science', 'system design', 'algorithms', 'leetcode', 'recipe', 'cake',
  'pizza', 'pasta', 'salad', 'smoothie', 'movie', 'series', 'song', 'book', 'novel', 'game',
  'hotel', 'flight', 'car', 'bike', 'house', 'apartment', 'job', 'internship', 'course', 'tutorial',
  'resume', 'interview', 'salary', 'gym', 'workout', 'diet', 'haircut', 'tattoo', 'wedding'];

const adjectives = ['best', 'cheap', 'budget', 'premium', 'wireless', 'portable', 'gaming', 'used',
  'new', 'refurbished', 'mini', 'pro', 'ultra', 'smart', 'fast', 'silent', 'compact', 'foldable',
  'waterproof', 'rechargeable', 'lightweight', 'heavy duty', 'top rated', 'discount', 'latest'];

const verbs = ['install', 'learn', 'use', 'fix', 'build', 'setup', 'configure', 'clean', 'repair',
  'cook', 'make', 'draw', 'write', 'deploy', 'debug', 'optimize', 'design', 'create', 'remove',
  'connect', 'reset', 'update', 'download', 'convert', 'compress'];

const places = ['near me', 'online', 'in india', 'usa', 'london', 'new york', 'tokyo', 'dubai', 'paris'];
const years = ['2023', '2024', '2025', '2026'];
const suffixes = ['tutorial', 'review', 'price', 'online', 'near me', 'for beginners', 'for sale',
  'specs', 'release date', 'vs competitors', 'deals', 'discount', 'guide', 'tips', 'examples'];

// ---- Curated head queries so the demo (typing "ip", "ja", "how") looks sensible ----
// These get explicitly high counts and sit at the top of the distribution.
const curated = [
  ['iphone', 100000], ['iphone 15', 85000], ['iphone charger', 60000], ['iphone case', 52000],
  ['iphone 15 pro', 48000], ['iphone 14', 45000], ['ipad', 70000], ['ipad pro', 41000],
  ['java tutorial', 40000], ['java', 65000], ['javascript', 58000], ['javascript tutorial', 36000],
  ['python tutorial', 55000], ['python', 72000], ['react tutorial', 30000], ['react', 49000],
  ['system design interview', 33000], ['system design', 38000], ['leetcode', 44000],
  ['how to learn python', 28000], ['how to learn java', 21000], ['how to cook pasta', 18000],
  ['best laptop', 47000], ['best laptop 2026', 26000], ['best headphones', 39000],
  ['cheap flights', 35000], ['samsung galaxy', 43000], ['samsung tv', 31000],
  ['netflix login', 37000], ['amazon prime', 42000], ['gaming laptop', 34000],
  ['wireless headphones', 32000], ['machine learning', 46000], ['data science course', 24000],
  ['docker tutorial', 22000], ['kubernetes tutorial', 19000], ['nodejs tutorial', 20000],
];

// ---- Template generators ----
const templates = [
  () => `${pick(adjectives)} ${pick(nouns)}`,
  () => `${pick(brands)} ${pick(nouns)}`,
  () => `${pick(nouns)} ${pick(suffixes)}`,
  () => `how to ${pick(verbs)} ${pick(nouns)}`,
  () => `${pick(adjectives)} ${pick(nouns)} for ${pick(nouns)}`,
  () => `${pick(nouns)} vs ${pick(nouns)}`,
  () => `${pick(brands)} ${pick(nouns)} ${pick(suffixes)}`,
  () => `best ${pick(nouns)} ${pick(years)}`,
  () => `${pick(verbs)} ${pick(nouns)} ${pick(places)}`,
  () => `${pick(adjectives)} ${pick(brands)} ${pick(nouns)}`,
];

function normalize(q) {
  return q.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function generate() {
  const set = new Set();
  const ordered = [];

  // Curated head first.
  for (const [q] of curated) {
    const n = normalize(q);
    if (!set.has(n)) {
      set.add(n);
      ordered.push(n);
    }
  }

  let attempts = 0;
  const maxAttempts = TARGET * 30;
  while (ordered.length < TARGET && attempts < maxAttempts) {
    attempts++;
    const q = normalize(pick(templates)());
    if (q.length < 2) continue;
    if (set.has(q)) continue;
    set.add(q);
    ordered.push(q);
  }

  return { ordered, curatedCounts: new Map(curated.map(([q, c]) => [normalize(q), c])) };
}

/**
 * Assign Zipf-distributed counts.
 * Curated queries keep their explicit (high) counts. The generated tail gets
 * count = floor(BASE / rank^s) with light jitter, so popularity drops off
 * sharply — a realistic long tail.
 */
function assignCounts(ordered, curatedCounts) {
  const s = 1.05; // Zipf exponent (~1 is typical for natural language frequencies)
  const BASE = 90000;
  const rows = [];
  let rank = 0;
  for (const q of ordered) {
    rank++;
    let count;
    if (curatedCounts.has(q)) {
      count = curatedCounts.get(q);
    } else {
      const base = BASE / Math.pow(rank, s);
      const jitter = 0.75 + rand() * 0.5; // 0.75x .. 1.25x
      count = Math.max(1, Math.floor(base * jitter));
    }
    rows.push({ query: q, count });
  }
  return rows;
}

function main() {
  console.log(`Generating ~${TARGET.toLocaleString()} unique queries...`);
  const { ordered, curatedCounts } = generate();
  const rows = assignCounts(ordered, curatedCounts);

  const outPath = path.resolve(__dirname, '..', config.dataset.csvPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const out = ['query,count'];
  for (const r of rows) out.push(`${r.query},${r.count}`);
  fs.writeFileSync(outPath, out.join('\n') + '\n', 'utf8');

  // Quick summary.
  const total = rows.reduce((a, r) => a + r.count, 0);
  console.log(`Wrote ${rows.length.toLocaleString()} rows to ${config.dataset.csvPath}`);
  console.log(`Total aggregated search volume: ${total.toLocaleString()}`);
  console.log('Sample (top 8 by count):');
  [...rows].sort((a, b) => b.count - a.count).slice(0, 8)
    .forEach((r) => console.log(`   ${r.query.padEnd(28)} ${r.count}`));

  if (rows.length < config.dataset.minSize) {
    console.error(`WARNING: only ${rows.length} rows, below the ${config.dataset.minSize} minimum.`);
    process.exit(1);
  }
}

main();
