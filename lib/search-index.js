const path = require('path');
const fs = require('fs');
const { htmlToText } = require('./text-extract');

// A native module - degrade to a no-op index (rather than crashing the whole server) if it
// can't load on some unusual platform/arch, the same graceful-degradation spirit as every other
// bonus capture (WARC, media, article, screenshot) in this project.
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = null;
}

const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'search.db');

let db;
let unavailableLogged = false;

function getDb() {
  if (!Database) {
    if (!unavailableLogged) {
      unavailableLogged = true;
      console.warn('[search-index] better-sqlite3 unavailable - full-text search is disabled, everything else still works.');
    }
    return null;
  }
  if (!db) {
    fs.mkdirSync(DB_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
        dir UNINDEXED, url UNINDEXED, domain UNINDEXED, title, archivedAt UNINDEXED, content
      );
    `);
  }
  return db;
}

// `dir` is the archive's path relative to ARCHIVE_DIR (e.g. "example.com/2026-.../sub-links/...")
// - the same identifier used everywhere else in this app - so it doubles as the index's primary key.
function indexPage({ dir, url, domain, title, archivedAt, html }) {
  const database = getDb();
  if (!database) return;
  const content = htmlToText(html);
  database.prepare('DELETE FROM pages_fts WHERE dir = ?').run(dir);
  database
    .prepare('INSERT INTO pages_fts (dir, url, domain, title, archivedAt, content) VALUES (?, ?, ?, ?, ?, ?)')
    .run(dir, url, domain, title || '', archivedAt, content);
}

function removeFromIndex(dir) {
  const database = getDb();
  if (!database) return;
  database.prepare('DELETE FROM pages_fts WHERE dir = ?').run(dir);
}

// Removes one archive dir and everything nested under it (e.g. a main dir's sub-links/ subtree).
function removeTreeFromIndex(dir) {
  const database = getDb();
  if (!database) return;
  database.prepare('DELETE FROM pages_fts WHERE dir = ? OR dir LIKE ?').run(dir, `${dir}/%`);
}

function removeDomainFromIndex(domain) {
  const database = getDb();
  if (!database) return;
  database.prepare('DELETE FROM pages_fts WHERE domain = ?').run(domain);
}

function getIndexedDirs() {
  const database = getDb();
  if (!database) return new Set();
  return new Set(database.prepare('SELECT dir FROM pages_fts').all().map((r) => r.dir));
}

// FTS5's MATCH syntax treats quotes/operators specially, so each whitespace-separated term is
// quoted into its own phrase (with a trailing * for prefix matching) rather than passing the raw
// query straight through - otherwise a query containing e.g. a stray quote would throw.
// '‹'/'›' (rare, non-HTML-special characters) mark hit boundaries so the caller can safely
// HTML-escape the whole snippet and then swap these markers for real <mark> tags afterward.
function searchContent(query, limit = 20) {
  const database = getDb();
  if (!database) return [];

  const terms = query.trim().split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"*`);
  if (!terms.length) return [];

  try {
    return database
      .prepare(
        `SELECT dir, url, domain, title, archivedAt, snippet(pages_fts, 5, '‹', '›', '…', 20) AS snippet
         FROM pages_fts WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?`
      )
      .all(terms.join(' '), limit);
  } catch {
    return [];
  }
}

module.exports = { indexPage, removeFromIndex, removeTreeFromIndex, removeDomainFromIndex, getIndexedDirs, searchContent };
