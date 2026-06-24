'use strict';

/**
 * Premium Frontend Controller for Parth Suggester.
 * Manages event handling, debounced API communications, metric aggregations,
 * and dynamic SVG Consistent Hash Ring visualization.
 */

const DEBOUNCE_DELAY_MS = 200;

// UI Elements Map
const els = {
  input: document.getElementById('search-input'),
  btn: document.getElementById('search-btn'),
  list: document.getElementById('suggestions'),
  result: document.getElementById('result'),
  resultBody: document.getElementById('result-body'),
  trending: document.getElementById('trending-list'),
  dbgSource: document.getElementById('dbg-source'),
  dbgCache: document.getElementById('dbg-cache'),
  dbgNode: document.getElementById('dbg-node'),
  dbgLatency: document.getElementById('dbg-latency'),
  svgNodes: document.getElementById('svg-nodes-group'),
  svgRouting: document.getElementById('svg-active-routing'),
  routingLine: document.getElementById('routing-line-radius'),
  routingDot: document.getElementById('routing-key-dot'),
  routingArc: document.getElementById('routing-arc-path'),
  legendList: document.getElementById('ring-legend-list')
};

let suggestionsList = [];
let selectedSuggestionIndex = -1;
let debounceTimeoutId = null;
let currentInFlightController = null;

// Node metadata for the Consistent Hash Ring
const HASH_RING_NODES = [
  { id: 'cache-node-0', name: 'Shard Node 0', color: '#10b981', angle: 0.25 * Math.PI },
  { id: 'cache-node-1', name: 'Shard Node 1', color: '#3b82f6', angle: 0.75 * Math.PI },
  { id: 'cache-node-2', name: 'Shard Node 2', color: '#8b5cf6', angle: 1.25 * Math.PI },
  { id: 'cache-node-3', name: 'Shard Node 3', color: '#ec4899', angle: 1.75 * Math.PI }
];

function getSelectedRankingMode() {
  const selectedModeInput = document.querySelector('input[name="mode"]:checked');
  return selectedModeInput ? selectedModeInput.value : 'recency';
}

function sanitizeHtml(str) {
  return str.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

// ==========================================================================
// Consistent Hash Ring SVG Drawing & Animations
// ==========================================================================

const RING_RADIUS = 120;
const CENTER_X = 160;
const CENTER_Y = 160;

/**
 * Renders nodes on the SVG ring and builds the corresponding legend.
 */
function drawConsistentHashRing() {
  // Clear existing nodes in SVG group
  els.svgNodes.innerHTML = '';
  els.legendList.innerHTML = '';

  HASH_RING_NODES.forEach((node) => {
    const angleRad = node.angle;
    const nx = CENTER_X + RING_RADIUS * Math.cos(angleRad);
    const ny = CENTER_Y + RING_RADIUS * Math.sin(angleRad);

    // Create SVG Node elements
    const nodeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    nodeGroup.setAttribute('class', 'ring-node');
    nodeGroup.setAttribute('id', `svg-${node.id}`);

    // Outer pulse ring
    const pulseCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    pulseCircle.setAttribute('cx', nx);
    pulseCircle.setAttribute('cy', ny);
    pulseCircle.setAttribute('r', 12);
    pulseCircle.setAttribute('fill', 'transparent');
    pulseCircle.setAttribute('stroke', node.color);
    pulseCircle.setAttribute('stroke-width', '1');
    pulseCircle.setAttribute('opacity', '0.4');

    // Central solid node circle
    const solidCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    solidCircle.setAttribute('cx', nx);
    solidCircle.setAttribute('cy', ny);
    solidCircle.setAttribute('r', 8);
    solidCircle.setAttribute('fill', node.color);
    solidCircle.setAttribute('class', 'ring-node-circle');
    solidCircle.setAttribute('stroke', '#080c14');
    solidCircle.setAttribute('stroke-width', '2');

    // Text label placement (slightly pushed outwards radially)
    const labelDistance = 142;
    const tx = CENTER_X + labelDistance * Math.cos(angleRad);
    const ty = CENTER_Y + labelDistance * Math.sin(angleRad) + 3; // vertical alignment adjustment

    const textLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    textLabel.setAttribute('x', tx);
    textLabel.setAttribute('y', ty);
    textLabel.setAttribute('class', 'ring-node-label');
    textLabel.textContent = node.id.replace('cache-node-', 'Node ');

    nodeGroup.appendChild(pulseCircle);
    nodeGroup.appendChild(solidCircle);
    nodeGroup.appendChild(textLabel);
    els.svgNodes.appendChild(nodeGroup);

    // Create legend item on dashboard
    const legendItem = document.createElement('div');
    legendItem.className = 'legend-item';
    legendItem.innerHTML = `
      <span class="legend-dot" style="background-color: ${node.color}; border-color: rgba(255,255,255,0.15)"></span>
      <span class="legend-name">${node.name}</span>
      <span class="legend-vnodes">150 VNodes</span>
    `;
    els.legendList.appendChild(legendItem);
  });
}

/**
 * Animates the routing indicators on the SVG Ring.
 * Draws an arc starting at prefix key's hash position sweeping clockwise to owning node.
 */
function animateRoutingOnRing(keyHash, ownerNodeId) {
  // Convert 32-bit hash value to radians
  const keyAngle = (keyHash / 4294967296) * 2 * Math.PI;
  const kx = CENTER_X + RING_RADIUS * Math.cos(keyAngle);
  const ky = CENTER_Y + RING_RADIUS * Math.sin(keyAngle);

  // Set line coordinates
  els.routingLine.setAttribute('x1', CENTER_X);
  els.routingLine.setAttribute('y1', CENTER_Y);
  els.routingLine.setAttribute('x2', kx);
  els.routingLine.setAttribute('y2', ky);

  // Set dot position
  els.routingDot.setAttribute('cx', kx);
  els.routingDot.setAttribute('cy', ky);

  // Find target node coordinates and angles
  const targetNode = HASH_RING_NODES.find((node) => node.id === ownerNodeId);
  if (targetNode) {
    const targetAngle = targetNode.angle;
    const tx = CENTER_X + RING_RADIUS * Math.cos(targetAngle);
    const ty = CENTER_Y + RING_RADIUS * Math.sin(targetAngle);

    // Calculate clockwise sweep difference
    let diffAngle = targetAngle - keyAngle;
    if (diffAngle < 0) diffAngle += 2 * Math.PI;
    const largeArcFlag = diffAngle > Math.PI ? 1 : 0;

    // Build SVG Arc path: A rx ry x-axis-rotation large-arc-flag sweep-flag x y
    const pathString = `M ${kx} ${ky} A ${RING_RADIUS} ${RING_RADIUS} 0 ${largeArcFlag} 1 ${tx} ${ty}`;
    els.routingArc.setAttribute('d', pathString);
    els.routingArc.style.stroke = targetNode.color;
    els.routingDot.style.stroke = targetNode.color;

    // Reset scales/glows on all nodes
    HASH_RING_NODES.forEach((n) => {
      const nodeEl = document.getElementById(`svg-${n.id}`);
      if (nodeEl) {
        nodeEl.classList.remove('active');
        nodeEl.querySelector('.ring-node-circle').setAttribute('r', 8);
      }
    });

    // Scale up the active node circle
    const activeNodeEl = document.getElementById(`svg-${ownerNodeId}`);
    if (activeNodeEl) {
      activeNodeEl.querySelector('.ring-node-circle').setAttribute('r', 11);
    }
  }

  // Display routing indicators
  els.svgRouting.setAttribute('opacity', '1');
}

function resetRoutingAnimation() {
  els.svgRouting.setAttribute('opacity', '0');
  HASH_RING_NODES.forEach((n) => {
    const nodeEl = document.getElementById(`svg-${n.id}`);
    if (nodeEl) {
      nodeEl.querySelector('.ring-node-circle').setAttribute('r', 8);
    }
  });
}

// ==========================================================================
// Suggestion Dropdown Handling
// ==========================================================================

function showDropdownMessage(text) {
  els.list.innerHTML = `<li class="info">${sanitizeHtml(text)}</li>`;
  els.list.hidden = false;
}

function closeDropdown() {
  els.list.hidden = true;
  els.list.innerHTML = '';
  selectedSuggestionIndex = -1;
}

function renderSuggestions(prefixText) {
  if (suggestionsList.length === 0) {
    showDropdownMessage('No matching suggestions found');
    return;
  }

  const prefixLength = prefixText.length;
  els.list.innerHTML = suggestionsList.map((item, index) => {
    const queryEscaped = sanitizeHtml(item.query);
    const highlightedPrefix = `<b>${sanitizeHtml(item.query.slice(0, prefixLength))}</b>${sanitizeHtml(item.query.slice(prefixLength))}`;

    return `
      <li role="option" data-index="${index}" class="${index === selectedSuggestionIndex ? 'active' : ''}">
        <span class="q">${highlightedPrefix || queryEscaped}</span>
        <span class="meta">Score: ${item.score.toFixed(1)}</span>
      </li>
    `;
  }).join('');

  els.list.hidden = false;
}

/**
 * Query suggestions endpoint from input prefix.
 */
async function fetchSuggestions(prefixText) {
  if (currentInFlightController) {
    currentInFlightController.abort();
  }
  if (!prefixText.trim()) {
    closeDropdown();
    resetRoutingAnimation();
    return;
  }

  currentInFlightController = new AbortController();
  showDropdownMessage('Loading candidates...');

  try {
    const rankingMode = getSelectedRankingMode();
    const queryUrl = `/suggest?q=${encodeURIComponent(prefixText)}&mode=${rankingMode}`;
    const response = await fetch(queryUrl, { signal: currentInFlightController.signal });
    
    if (!response.ok) {
      throw new Error(`HTTP Error Status: ${response.status}`);
    }

    const data = await response.json();
    suggestionsList = data.suggestions || [];
    selectedSuggestionIndex = -1;
    
    renderSuggestions(data.prefix || prefixText);
    updateDiagnosticsDisplay(data);

    // Fetch consistent hash data to animate the SVG ring
    if (data.prefix) {
      fetchRoutingDetails(data.prefix);
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    showDropdownMessage('⚠️ Failed to load suggestions');
  }
}

/**
 * Queries detailed node routing parameters for key hashing animation.
 */
async function fetchRoutingDetails(prefixText) {
  try {
    const res = await fetch(`/cache/debug?prefix=${encodeURIComponent(prefixText)}`);
    if (res.ok) {
      const routingData = await res.json();
      animateRoutingOnRing(routingData.keyHash, routingData.ownerNode);
    }
  } catch (_) {
    // Ignore fallback
  }
}

function updateDiagnosticsDisplay(data) {
  els.dbgSource.textContent = data.source;
  els.dbgSource.className = `badge-pill ${data.source}`;
  
  els.dbgCache.textContent = data.cacheHit ? 'HIT' : 'MISS';
  els.dbgCache.className = `badge-pill ${data.cacheHit ? 'hit' : 'miss'}`;

  els.dbgNode.textContent = data.ownerNode ? data.ownerNode.toUpperCase() : '—';
  els.dbgLatency.textContent = `${data.latencyMs.toFixed(3)} ms`;
}

// ==========================================================================
// Search Event Logging & Submission
// ==========================================================================

async function executeSearch(searchTerm) {
  const query = (searchTerm || '').trim();
  if (!query) return;

  closeDropdown();
  els.input.value = query;

  try {
    const response = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    const responseJson = await response.json();
    els.result.hidden = false;
    els.resultBody.textContent = JSON.stringify(responseJson, null, 2);
  } catch (err) {
    els.result.hidden = false;
    els.resultBody.textContent = '⚠️ Search query processing failed';
  }

  // Refresh dashboard contents
  refreshTrendsConsole();
  refreshAnalyticsMetrics();
}

// ==========================================================================
// Keyboard navigation triggers
// ==========================================================================

function navigateActiveSelection(offset) {
  if (els.list.hidden || suggestionsList.length === 0) return;
  
  selectedSuggestionIndex = (selectedSuggestionIndex + offset + suggestionsList.length) % suggestionsList.length;
  renderSuggestions(els.input.value);

  const activeListItem = els.list.querySelector('li.active');
  if (activeListItem) {
    activeListItem.scrollIntoView({ block: 'nearest' });
  }
}

els.input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    navigateActiveSelection(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    navigateActiveSelection(-1);
  } else if (e.key === 'Escape') {
    closeDropdown();
  } else if (e.key === 'Enter') {
    if (selectedSuggestionIndex >= 0 && suggestionsList[selectedSuggestionIndex]) {
      executeSearch(suggestionsList[selectedSuggestionIndex].query);
    } else {
      executeSearch(els.input.value);
    }
  }
});

els.input.addEventListener('input', () => {
  clearTimeout(debounceTimeoutId);
  debounceTimeoutId = setTimeout(() => fetchSuggestions(els.input.value), DEBOUNCE_DELAY_MS);
});

els.list.addEventListener('click', (e) => {
  const clickedItem = e.target.closest('li[data-index]');
  if (!clickedItem) return;
  const index = Number(clickedItem.dataset.index);
  if (suggestionsList[index]) {
    executeSearch(suggestionsList[index].query);
  }
});

els.btn.addEventListener('click', () => executeSearch(els.input.value));

document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener('change', () => fetchSuggestions(els.input.value));
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-field-wrapper') && !e.target.closest('.custom-suggestions')) {
    closeDropdown();
  }
});

// ==========================================================================
// Dashboard Diagnostics polling
// ==========================================================================

async function refreshTrendsConsole() {
  try {
    const res = await fetch('/trending');
    const data = await res.json();
    const trendingList = data.trending || [];

    if (trendingList.length === 0) {
      els.trending.innerHTML = '<li class="trend-placeholder">Waiting for activity... Submit some searches above!</li>';
      return;
    }

    els.trending.innerHTML = trendingList.map((item) => `
      <li data-query="${sanitizeHtml(item.query)}">
        <span class="trend-text">${sanitizeHtml(item.query)}</span>
        <span class="score">${item.score.toFixed(2)}</span>
      </li>
    `).join('');
  } catch (_) {
    // Retain previous records
  }
}

els.trending.addEventListener('click', (e) => {
  const trendItem = e.target.closest('li[data-query]');
  if (!trendItem) return;
  const q = trendItem.dataset.query;
  els.input.value = q;
  fetchSuggestions(q);
  els.input.focus();
});

async function refreshAnalyticsMetrics() {
  try {
    const response = await fetch('/metrics');
    const metrics = await response.json();

    document.getElementById('m-hitrate').textContent = `${(metrics.cache.hitRate * 100).toFixed(1)}%`;
    document.getElementById('m-p95').textContent = `${metrics.latency.p95Ms.toFixed(3)} ms`;
    document.getElementById('m-avg').textContent = `${metrics.latency.avgMs.toFixed(3)} ms`;
    document.getElementById('m-reads').textContent = metrics.primaryStore.reads.toLocaleString();
    document.getElementById('m-writes').textContent = metrics.primaryStore.writes.toLocaleString();
    document.getElementById('m-searches').textContent = metrics.batch.searchesReceived.toLocaleString();
    document.getElementById('m-reduction').textContent = `${(metrics.batch.writeReduction * 100).toFixed(1)}%`;
    document.getElementById('m-size').textContent = metrics.dataset.size.toLocaleString();
  } catch (_) {
    // Ignore polling failures
  }
}

// ==========================================================================
// App Initialization
// ==========================================================================

drawConsistentHashRing();
refreshTrendsConsole();
refreshAnalyticsMetrics();

setInterval(refreshTrendsConsole, 5000);
setInterval(refreshAnalyticsMetrics, 3000);

els.input.focus();
