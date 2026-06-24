'use strict';

/**
 * TrieNode structure representing a character node in the Trie.
 */
class TrieNode {
  constructor() {
    this.children = {}; // Character map to child TrieNodes
    this.fullQuery = null; // Store query string on terminal nodes
    this.searchCount = 0; // Popularity count of the search term
  }
}

/**
 * TrieIndex structure to support O(L) prefix search lookups.
 */
class TrieIndex {
  constructor() {
    this.rootNode = new TrieNode();
    this.totalEntries = 0;
  }

  /**
   * Insert a search query with its popularity count or update it.
   */
  insertQuery(queryStr, popularityCount) {
    let current = this.rootNode;
    for (const char of queryStr) {
      if (!current.children[char]) {
        current.children[char] = new TrieNode();
      }
      current = current.children[char];
    }
    if (current.fullQuery === null) {
      this.totalEntries++;
    }
    current.fullQuery = queryStr;
    current.searchCount = popularityCount;
  }

  /**
   * Traverses to the node corresponding to the given prefix.
   * Returns the node, or null if prefix does not exist in the index.
   */
  findPrefixNode(prefixStr) {
    let current = this.rootNode;
    for (const char of prefixStr) {
      current = current.children[char];
      if (!current) return null;
    }
    return current;
  }

  /**
   * Find all candidate queries starting with the given prefix.
   */
  findMatches(prefixStr) {
    const startNode = this.findPrefixNode(prefixStr);
    if (!startNode) return [];

    const matches = [];
    const traversalStack = [startNode];

    // Iterative depth-first traversal to extract completions
    while (traversalStack.length > 0) {
      const node = traversalStack.pop();
      if (node.fullQuery !== null) {
        matches.push({ query: node.fullQuery, count: node.searchCount });
      }
      for (const char in node.children) {
        traversalStack.push(node.children[char]);
      }
    }
    return matches;
  }

  size() {
    return this.totalEntries;
  }
}

module.exports = { TrieIndex };
