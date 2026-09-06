// Talks to the Internet Archive's public Wayback Machine APIs - no API key, no new dependency
// (Node's built-in `fetch`) - to let TimeCapsule import a snapshot someone else already captured
// instead of only ever archiving pages live.
const FETCH_TIMEOUT_MS = 20000;
const MAX_SNAPSHOTS = 30;

// Wayback timestamps are always a 14-digit UTC stamp: YYYYMMDDhhmmss.
function parseWaybackTimestamp(timestamp) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(timestamp);
  if (!m) throw new Error('Malformed Wayback timestamp.');
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}

// Lists distinct HTML snapshots of a URL via the CDX API, newest first. `collapse: digest`
// folds consecutive crawls with identical content into one entry, so a page that didn't change
// for months of crawls only shows up once instead of dozens of times.
async function listSnapshots(targetUrl, limit = MAX_SNAPSHOTS) {
  const params = new URLSearchParams({
    url: targetUrl,
    output: 'json',
    fl: 'timestamp,statuscode,mimetype',
    filter: 'statuscode:200',
    collapse: 'digest',
    // CDX returns rows oldest-first; a *negative* limit is its documented way to ask for the
    // last N instead of the first N, which is what "most recent snapshots" actually needs here.
    limit: String(-limit),
  });

  const res = await fetch(`https://web.archive.org/cdx/search/cdx?${params}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Wayback Machine lookup failed (HTTP ${res.status}).`);

  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length < 2) return [];

  // rows[0] is the column header ([timestamp, statuscode, mimetype]) CDX always returns first.
  return rows
    .slice(1)
    .filter((row) => /^text\/html/.test(row[2] || ''))
    .map((row) => row[0])
    .reverse()
    .slice(0, limit)
    .map((timestamp) => ({ timestamp, capturedAt: parseWaybackTimestamp(timestamp).toISOString() }));
}

// Fetches the exact bytes the Wayback Machine has for one snapshot, using the documented `id_`
// modifier so the response is the original captured HTML with none of Wayback's own toolbar
// banner or link-rewriting mixed in.
async function fetchSnapshotHtml(targetUrl, timestamp) {
  const rawUrl = `https://web.archive.org/web/${timestamp}id_/${targetUrl}`;
  const res = await fetch(rawUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Could not fetch that snapshot from the Wayback Machine (HTTP ${res.status}).`);
  return res.text();
}

// Recognizes a URL someone copied straight out of the Wayback Machine itself
// (web.archive.org/web/<timestamp><optional modifier letters>/<original absolute URL>) so pasting
// one into the main archive bar can be routed to an import instead of TimeCapsule dutifully
// archiving Wayback's own replay page (toolbar and all). Matched against the raw input string,
// before any URL() parsing touches it - the embedded original URL can carry its own query string,
// and reparsing the whole thing as one URL first would risk mangling that.
const WAYBACK_URL_RE = /^(?:https?:\/\/)?web\.archive\.org\/web\/(\d{1,14})[a-z_]*\/(https?:\/\/.+)$/i;

function parseWaybackUrl(rawInput) {
  const m = WAYBACK_URL_RE.exec(String(rawInput).trim());
  if (!m) return null;
  return { timestamp: m[1], originalUrl: m[2] };
}

// A pasted Wayback link almost always carries the full 14-digit timestamp of the exact snapshot
// that was being viewed - used as-is. Anything shorter (a hand-typed "just the year" style link)
// gets resolved to the closest real snapshot via the CDX API instead of guessing at a fabricated
// timestamp.
async function resolveWaybackTimestamp(targetUrl, hintTimestamp) {
  if (/^\d{14}$/.test(hintTimestamp)) return hintTimestamp;

  const snapshots = await listSnapshots(targetUrl, 50);
  if (!snapshots.length) throw new Error('No Wayback Machine snapshots found for that URL.');

  const prefixMatch = snapshots.find((s) => s.timestamp.startsWith(hintTimestamp));
  return (prefixMatch || snapshots[0]).timestamp;
}

module.exports = {
  listSnapshots,
  fetchSnapshotHtml,
  parseWaybackTimestamp,
  parseWaybackUrl,
  resolveWaybackTimestamp,
};
