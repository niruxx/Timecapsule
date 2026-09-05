const fs = require('fs');
const path = require('path');
const express = require('express');
const puppeteer = require('puppeteer');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { archiveUrl } = require('./lib/archiver');
const {
  listSites, listTimeline, listSiteHistory, searchArchives, deleteSite, deleteMainDirs,
  listAllArchives, listTags, listByTag, findRecentArchive,
} = require('./lib/history');
const { log, logTraffic } = require('./lib/logger');
const { parseCookies } = require('./lib/cookies');
const { indexPage, getIndexedDirs } = require('./lib/search-index');
const { canonicalizeUrl } = require('./lib/canonicalize');
const { diffWords } = require('diff');

const DEDUP_WINDOW_MS = 5 * 60 * 1000;

const PORT = process.env.PORT || 3000;
const ARCHIVE_DIR = path.join(__dirname, 'archived');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/archived', express.static(ARCHIVE_DIR));

let browserPromise;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({ headless: 'new' });
  }
  return browserPromise;
}

function normalizeUrl(input) {
  const trimmed = input.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return new URL(withProtocol).toString();
}

// Node's default server binds dual-stack, so IPv4 clients often show up as an
// IPv6-mapped address (::ffff:1.2.3.4) or the IPv6 loopback (::1) - normalize
// those back to plain IPv4 so the logs show what you'd actually expect.
function toIPv4(ip) {
  if (!ip) return ip;
  if (ip === '::1') return '127.0.0.1';
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : ip;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = forwarded ? forwarded.split(',')[0].trim() : (req.socket.remoteAddress || 'unknown');
  return toIPv4(raw);
}

const ARCHIVE_DEPTHS = ['page', 'links', 'recursive'];
const MAX_USER_AGENT_LENGTH = 300;
const MAX_EXTRA_WAIT_MS = 30000;
const MAX_COOKIES_TEXT_LENGTH = 200 * 1024;

app.post('/api/archive', async (req, res) => {
  const { url, depth, userAgent, extraWaitMs, cookiesText } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A url is required.' });
  }

  let target;
  try {
    target = canonicalizeUrl(normalizeUrl(url));
  } catch {
    return res.status(400).json({ error: 'That does not look like a valid URL.' });
  }

  const selectedDepth = ARCHIVE_DEPTHS.includes(depth) ? depth : 'links';

  let selectedUserAgent;
  if (userAgent) {
    if (typeof userAgent !== 'string' || userAgent.length > MAX_USER_AGENT_LENGTH) {
      return res.status(400).json({ error: `Custom User-Agent must be a string up to ${MAX_USER_AGENT_LENGTH} characters.` });
    }
    selectedUserAgent = userAgent.trim() || undefined;
  }

  let selectedExtraWaitMs;
  if (extraWaitMs != null) {
    const n = Number(extraWaitMs);
    if (!Number.isFinite(n) || n < 0 || n > MAX_EXTRA_WAIT_MS) {
      return res.status(400).json({ error: `extraWaitMs must be a number between 0 and ${MAX_EXTRA_WAIT_MS}.` });
    }
    selectedExtraWaitMs = n;
  }

  let cookies;
  if (cookiesText) {
    if (typeof cookiesText !== 'string' || cookiesText.length > MAX_COOKIES_TEXT_LENGTH) {
      return res.status(400).json({ error: 'Cookies text is too large.' });
    }
    try {
      cookies = parseCookies(cookiesText);
    } catch (err) {
      return res.status(400).json({ error: `Could not parse cookies: ${err.message}` });
    }
  }

  const ip = getClientIp(req);
  log(`Archive requested: ${target} (depth: ${selectedDepth}) from ${ip}`);
  logTraffic(target, ip);

  // Skip a genuine re-capture only for a plain, unconfigured repeat request (an accidental
  // double-submit, or a feed re-polling the same link) - any explicit User-Agent/wait/cookies
  // signals real intent to get a fresh capture, so those always go through.
  if (!selectedUserAgent && selectedExtraWaitMs == null && !cookies) {
    try {
      const recent = await findRecentArchive(ARCHIVE_DIR, target, DEDUP_WINDOW_MS);
      if (recent) {
        log(`Archive request for ${target} matches one from ${recent.archivedAt} - reusing it instead of re-capturing.`);
        return res.json({ main: { url: recent.url, dir: recent.dir }, sublinks: [], truncated: false, deduped: true });
      }
    } catch {
      // dedup lookup failed - fall through and just archive normally
    }
  }

  try {
    const browser = await getBrowser();
    const result = await archiveUrl(browser, target, ARCHIVE_DIR, {
      depth: selectedDepth,
      userAgent: selectedUserAgent,
      extraWaitMs: selectedExtraWaitMs,
      cookies,
      onProgress: (event) => {
        if (event.type === 'page') {
          log(`  [${ip}] archived ${event.url}`);
        } else if (event.type === 'error') {
          log(`  [${ip}] failed ${event.url}: ${event.error}`);
        }
      },
    });
    log(`Archive completed: ${target} (${result.sublinks.length} sub-link(s)) for ${ip}`);
    res.json(result);
  } catch (err) {
    log(`Archive failed: ${target} for ${ip} - ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sites', async (req, res) => {
  try {
    res.json(await listSites(ARCHIVE_DIR));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/timeline', async (req, res) => {
  try {
    res.json(await listTimeline(ARCHIVE_DIR));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sites/:domain', async (req, res) => {
  try {
    const history = await listSiteHistory(ARCHIVE_DIR, req.params.domain);
    if (!history) return res.status(404).json({ error: 'Site not found.' });
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    res.json(await searchArchives(ARCHIVE_DIR, String(req.query.q || '')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tags', async (req, res) => {
  try {
    res.json(await listTags(ARCHIVE_DIR));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tags/:tag', async (req, res) => {
  try {
    res.json(await listByTag(ARCHIVE_DIR, req.params.tag));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A dir string is only ever used to join onto ARCHIVE_DIR, so this is the one check standing
// between a query param and reading a file outside the archive - it must resolve inside ARCHIVE_DIR.
function isWithinArchiveDir(relDir) {
  if (typeof relDir !== 'string' || !relDir || path.isAbsolute(relDir)) return false;
  const resolved = path.resolve(ARCHIVE_DIR, relDir);
  const rel = path.relative(ARCHIVE_DIR, resolved);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

app.get('/api/diff', async (req, res) => {
  const { from, to } = req.query;
  if (!isWithinArchiveDir(from) || !isWithinArchiveDir(to)) {
    return res.status(400).json({ error: 'Invalid archive path.' });
  }

  try {
    const [textA, textB] = await Promise.all([
      fs.promises.readFile(path.join(ARCHIVE_DIR, from, 'article.txt'), 'utf8').catch(() => null),
      fs.promises.readFile(path.join(ARCHIVE_DIR, to, 'article.txt'), 'utf8').catch(() => null),
    ]);
    if (textA == null || textB == null) {
      return res.status(404).json({ error: 'Article text is not available for one or both of these snapshots.' });
    }

    const parts = diffWords(textA, textB).map((p) => ({ value: p.value, added: Boolean(p.added), removed: Boolean(p.removed) }));
    res.json({ parts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sites/:domain', async (req, res) => {
  try {
    const deleted = await deleteSite(ARCHIVE_DIR, req.params.domain);
    if (!deleted) return res.status(404).json({ error: 'Site not found.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/archives/delete', async (req, res) => {
  const { dirs } = req.body || {};
  if (!Array.isArray(dirs) || dirs.length === 0) {
    return res.status(400).json({ error: 'dirs must be a non-empty array.' });
  }

  try {
    await deleteMainDirs(ARCHIVE_DIR, dirs);
    res.json({ ok: true, deleted: dirs.length });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/export', async (req, res) => {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    return res.status(404).json({ error: 'Nothing archived yet.' });
  }

  try {
    const zip = new AdmZip();
    zip.addLocalFolder(ARCHIVE_DIR);
    const buffer = zip.toBuffer();
    const filename = `timecapsule-export-${new Date().toISOString().slice(0, 10)}.zip`;
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/import', upload.single('archive'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  try {
    const zip = new AdmZip(req.file.buffer);
    await fs.promises.mkdir(ARCHIVE_DIR, { recursive: true });
    zip.extractAllTo(ARCHIVE_DIR, true);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: `That doesn't look like a valid TimeCapsule export: ${err.message}` });
  }
});

// Self-healing full-text search index: catches up on any archive that predates the search
// feature, was imported from another machine, or exists because the index file was deleted.
// Runs in the background so it never delays the server actually starting up.
async function backfillSearchIndex() {
  try {
    const archives = await listAllArchives(ARCHIVE_DIR);
    const indexed = getIndexedDirs();
    let added = 0;

    for (const entry of archives) {
      if (indexed.has(entry.dir)) continue;
      const html = await fs.promises.readFile(path.join(ARCHIVE_DIR, entry.dir, 'page.html'), 'utf8').catch(() => null);
      if (html == null) continue;
      indexPage({ ...entry, html });
      added += 1;
    }

    if (added) log(`Search index: backfilled ${added} archive(s).`);
  } catch (err) {
    log(`Search index backfill failed: ${err.message}`);
  }
}

app.listen(PORT, () => {
  log(`TimeCapsule running at http://localhost:${PORT}`);
  backfillSearchIndex();
});

process.on('SIGINT', async () => {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
  process.exit(0);
});
