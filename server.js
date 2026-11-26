const fs = require('fs');
const path = require('path');
const express = require('express');
const puppeteer = require('puppeteer');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { archiveUrl, importWaybackSnapshot } = require('./lib/archiver');
const {
  listSites, listTimeline, listSiteHistory, searchArchives, deleteSite, deleteMainDirs,
  listAllArchives, listTags, listByTag, findRecentArchive,
  resolveSelectedArchives, organizeArchives,
} = require('./lib/history');
const { log, logTraffic } = require('./lib/logger');
const { parseCookies } = require('./lib/cookies');
const { createJob, getJob, finishJob, updateJob, openJobStore, listJobs, summarizeJob, isFinished } = require('./lib/jobs');
const { indexPage, getIndexedDirs } = require('./lib/search-index');
const { canonicalizeUrl } = require('./lib/canonicalize');
const {
  listSnapshots, fetchSnapshotHtml, parseWaybackTimestamp, parseWaybackUrl, resolveWaybackTimestamp,
} = require('./lib/wayback');
const { Semaphore } = require('./lib/semaphore');
const config = require('./config');
const { diffWords } = require('diff');
const { createAccess } = require('./lib/access');
const { createOperations, operationError, storageUsage, readFailedAssets, retryFailedAsset } = require('./lib/operations');
const { createStorage } = require('./lib/hosting');
const { snapshotDirectory, snapshotFormats, formats, sameUrl, readWarc, comparisonText } = require('./lib/replay');

const DEDUP_WINDOW_MS = 5 * 60 * 1000;

// Caps how many archive/import jobs actually run their Puppeteer work at once - shared across
// both endpoints below, since both consume the same resource (a headless-Chromium page). Extra
// requests queue rather than being rejected; tune via config.js, not from the website.
const archiveSemaphore = new Semaphore(config.MAX_CONCURRENT_ARCHIVES);

const PORT = process.env.PORT || config.PORT;
const ARCHIVE_DIR = path.resolve(process.env.TIMECAPSULE_ARCHIVE_DIR || path.join(__dirname, 'archived'));
const DATA_DIR = path.join(__dirname, 'data');
const operations = createOperations(path.join(DATA_DIR, 'operations.json'), ARCHIVE_DIR, config);
const storage = createStorage(ARCHIVE_DIR);
const restoredJobs = openJobStore(path.join(DATA_DIR, 'jobs.json'));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

const app = express();
const access = createAccess(ARCHIVE_DIR);
const adminOnly = access.restrict('admin');
const captureOnly = access.restrict('admin', 'capture');
app.use(access.authenticate);
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (storage.restoring) return res.status(409).json({ error: 'Archive restore is in progress.' });
  const origin = req.get('Origin');
  let originHost;
  try { if (origin) originHost = new URL(origin).host; } catch {}
  if (req.get('Sec-Fetch-Site') === 'cross-site' || (origin && originHost !== req.get('Host'))) {
    return res.status(403).json({ error: 'Cross-origin changes are disabled.' });
  }
  return next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/archived', access.archiveFiles, express.static(ARCHIVE_DIR, {
  setHeaders(res, filename) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (/\.(?:html?|svg|xml|xhtml)$/i.test(filename)) {
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'");
    }
  },
}));

let browserPromise;
let shuttingDown = false;
function getBrowser() {
  if (!browserPromise) {
    const attempt = puppeteer.launch({ headless: true });
    browserPromise = attempt;
    const reset = () => { if (browserPromise === attempt) browserPromise = null; };
    attempt.then((browser) => browser.once('disconnected', reset), reset);
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

async function cleanupJobDir(job) {
  if (!job.mainDir) return;
  await fs.promises.rm(job.mainDir, { recursive: true, force: true }).catch(() => {});
}

function jobFor(req) {
  const job = getJob(req.params.jobId);
  return job && (req.account.role === 'admin' || job.descriptor.owner === req.account.username) ? job : null;
}

async function abortCapture(job) {
  job.abortController.abort();
  await Promise.all([job.verifyBrowser?.close().catch(() => {}), job.page?.close().catch(() => {})]);
}

function startCapture(descriptor) {
  if (shuttingDown) throw operationError('The server is shutting down.', 503);
  if (storage.restoring) throw operationError('Archive restore is in progress.', 409);
  const job = createJob(descriptor);
  runCapture(job).catch((err) => log('Capture queue error: ' + err.message));
  return job;
}

function captureWorkDirectory(job, absolute) {
  const relative = path.relative(ARCHIVE_DIR, absolute).split(path.sep).join('/');
  fs.writeFileSync(path.join(absolute, '.timecapsule-job'), job.id, { flag: 'wx', mode: 0o600 });
  updateJob(job, { workDir: relative });
}

async function removeInterruptedCapture(job) {
  const relative = job.workDir;
  if (typeof relative !== 'string' || !/^[^/\\:]+\/[^/\\:]+$/.test(relative) ||
      relative.split('/').some((part) => ['.', '..'].includes(part))) return;
  const absolute = path.join(ARCHIVE_DIR, relative);
  const root = await fs.promises.realpath(ARCHIVE_DIR).catch(() => null);
  const actual = await fs.promises.realpath(absolute).catch(() => null);
  if (!root || actual !== path.join(root, relative)) return;
  const owner = await fs.promises.readFile(path.join(absolute, '.timecapsule-job'), 'utf8').catch(() => '');
  if (owner === job.id) await fs.promises.rm(absolute, { recursive: true, force: true });
}


async function runCapture(job) {
  const { target, kind, timestampHint, owner, scheduleId, collection, cookies, options = {}, ip } = job.descriptor;
  if (archiveSemaphore.isFull) job.progress = { type: 'queued', position: archiveSemaphore.queueLength + 1 };
  await archiveSemaphore.acquire();
  if (shuttingDown) {
    archiveSemaphore.release();
    return;
  }
  let timer;
  let timedOut = false;
  try {
    if (job.abortController.signal.aborted) throw new Error('Capture cancelled.');
    job.recordWorkDir = (absolute) => captureWorkDirectory(job, absolute);
    updateJob(job, { status: 'running', progress: { type: 'stage', label: 'Starting capture', percent: 0 } });
    job.emitter.emit('progress', job.progress);
    timer = setTimeout(() => {
      timedOut = true;
      abortCapture(job).catch(() => {});
    }, config.MAX_CAPTURE_SECONDS * 1000);
    const onProgress = (event) => {
      if (event.type === 'stage') job.progress = event;
      if (event.type === 'verification') {
        job.verificationInfo = event;
        updateJob(job, { status: event.status === 'opened' ? 'awaiting-verification' : 'running', progress: event });
      }
      job.emitter.emit('progress', event);
    };

    let result;
    if (kind === 'wayback') {
      const timestamp = await resolveWaybackTimestamp(target, timestampHint);
      const html = await fetchSnapshotHtml(target, timestamp, job.abortController.signal);
      const capturedAt = parseWaybackTimestamp(timestamp).toISOString();
      const main = await importWaybackSnapshot(await getBrowser(), target, html, capturedAt, ARCHIVE_DIR, { job, onProgress });
      result = { main, sublinks: [], truncated: false };
    } else {
      result = await archiveUrl(await getBrowser(), target, ARCHIVE_DIR, { ...options, cookies, job, onProgress });
    }
    if (job.abortController.signal.aborted) throw new Error('Capture cancelled.');
    clearTimeout(timer);
    if (collection && result.main?.dir) {
      await organizeArchives(ARCHIVE_DIR, [result.main.dir], 'move', collection)
        .catch((err) => log('Captured successfully, but collection assignment failed: ' + err.message));
    }
    if (job.mainDir) await fs.promises.rm(path.join(job.mainDir, '.timecapsule-job'), { force: true });
    updateJob(job, { status: 'done', result, workDir: null, progress: { type: 'stage', label: 'Completed', percent: 100 } });
    job.emitter.emit('done', result);
    log(`Capture completed: ${target} (${result.sublinks.length} sub-link(s)) for ${ip || owner || 'scheduler'}`);
    if (result.main?.dir) postCapture(job).catch((err) => log('Post-capture processing failed: ' + err.message));
  } catch (err) {
    clearTimeout(timer);
    const cancelled = job.abortController.signal.aborted && !timedOut;
    await cleanupJobDir(job);
    const message = timedOut ? 'Capture exceeded the configured time limit.' : err.message;
    const status = cancelled ? 'stopped' : 'error';
    updateJob(job, { status, workDir: null, error: cancelled ? null : message });
    job.emitter.emit(status, message);
    log('Capture ' + status + ': ' + target + ' - ' + message);
    if (scheduleId && !cancelled) operations.notify('Scheduled capture failed', { url: target, error: message });
  } finally {
    archiveSemaphore.release();
    delete job.descriptor.cookies;
    finishJob();
  }
}

async function postCapture(job) {
  const dir = job.result.main.dir;
  const url = job.descriptor.target;
  if (job.descriptor.scheduleId) {
    const snapshot = await snapshotDirectory(ARCHIVE_DIR, dir);
    if (snapshot?.meta.changeSincePrevious?.changed) {
      operations.notify('Scheduled capture found changes', { url, dir });
    }
  }
  await Promise.allSettled([
    operations.indexScreenshot(dir).catch((err) => operations.notify('OCR could not index the screenshot', { url, dir, error: err.message })),
    storage.replicate(dir).catch((err) => operations.notify('S3 replication failed', { url, dir, error: err.message })),
    job.descriptor.transient ? null : operations.mirrorCapture(dir)
      .catch((err) => operations.notify('Public mirror failed', { url, dir, error: err.message })),
  ]);
}

function runScheduledCapture(record) {
  if (listJobs(null, true).some((job) => !isFinished(job) && job.descriptor.scheduleId === record.id)) return null;
  const job = startCapture({ kind: 'live', target: record.url, owner: record.owner, scheduleId: record.id,
    collection: record.collection, options: { depth: 'page' } });
  operations.advanceSchedule(record);
  return job;
}

function runDueSchedules() {
  if (storage.restoring || shuttingDown) return;
  for (const record of operations.schedules) {
    if (!record.enabled || record.nextAt > Date.now()) continue;
    try { runScheduledCapture(record); } catch (err) { log('Schedule could not be queued: ' + err.message); }
  }
}

app.post('/api/archive/preview', captureOnly, async (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || !urls.length || urls.length > 200) {
    return res.status(400).json({ error: 'Enter between 1 and 200 URLs per batch.' });
  }
  try {
    const existing = new Set();
    const historical = new Set();
    for (const entry of await listTimeline(ARCHIVE_DIR)) {
      try {
        const url = canonicalizeUrl(entry.url);
        existing.add(url);
        if (entry.source === 'wayback') historical.add(url + ' ' + new Date(entry.archivedAt).toISOString());
      } catch {
        // Ignore entries with legacy metadata that has no valid URL or date.
      }
    }
    const seen = new Set();
    const items = urls.map((input) => {
      try {
        const raw = typeof input === 'string' ? input.trim() : '';
        if (!raw || /[\s]/.test(raw) ||
          (!/^https?:\/\//i.test(raw) && /^[a-z][a-z\d+.-]*:/i.test(raw) && !/^(?:localhost|[^:/]+\.[^:/]+):\d+(?:[/?#]|$)/i.test(raw))) {
          throw new Error('Expected an HTTP or HTTPS URL.');
        }
        const normalized = normalizeUrl(raw);
        const wayback = parseWaybackUrl(normalized);
        const url = wayback ? normalized : canonicalizeUrl(normalized);
        const original = wayback ? canonicalizeUrl(wayback.originalUrl) : url;
        const key = wayback ? original + ' ' + wayback.timestamp : url;
        const exists = wayback
          ? wayback.timestamp.length === 14 && historical.has(original + ' ' + parseWaybackTimestamp(wayback.timestamp).toISOString())
          : existing.has(url);
        const status = seen.has(key) ? 'duplicate' : exists ? 'existing' : 'new';
        seen.add(key);
        return { input, url, status };
      } catch {
        return { input, status: 'invalid' };
      }
    });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/archive', captureOnly, async (req, res) => {
  const { url, depth, userAgent, extraWaitMs, cookiesText, saveImages, saveMedia, force } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A url is required.' });
  }

  // A URL copied straight out of the Wayback Machine (web.archive.org/web/<timestamp>/<url>)
  // gets imported instead of archived live - otherwise this would dutifully screenshot Wayback's
  // own replay page, toolbar and all, rather than doing what pasting that link actually means.
  // Checked against the raw input, before any of the URL parsing/canonicalizing below touches it.
  const waybackMatch = parseWaybackUrl(url);
  if (waybackMatch) {
    let target;
    try {
      target = normalizeUrl(waybackMatch.originalUrl);
    } catch {
      return res.status(400).json({ error: 'That does not look like a valid URL.' });
    }

    const ip = getClientIp(req);
    log(`Wayback link detected in archive request: ${target} @ ${waybackMatch.timestamp} from ${ip}`);

    try {
      const job = startCapture({ kind: 'wayback', target, timestampHint: waybackMatch.timestamp, ip, owner: req.account.username });
      res.json({ jobId: job.id, wayback: true });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
    return;
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

  const selectedSaveImages = saveImages !== false;
  const selectedSaveMedia = saveMedia === true && config.ENABLE_MEDIA_DOWNLOADS;

  const ip = getClientIp(req);
  log(`Archive requested: ${target} (depth: ${selectedDepth}) from ${ip}`);
  logTraffic(target, ip);

  // Skip a genuine re-capture only for a plain, unconfigured repeat request (an accidental
  // double-submit, or a feed re-polling the same link) - any explicit User-Agent/wait/cookies
  // signals real intent to get a fresh capture, so those always go through.
  if (force !== true && !selectedUserAgent && selectedExtraWaitMs == null && !cookies) {
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
    const job = startCapture({ kind: 'live', target, ip, owner: req.account.username, cookies, transient: Boolean(cookies),
      options: { depth: selectedDepth, userAgent: selectedUserAgent, extraWaitMs: selectedExtraWaitMs,
        saveImages: selectedSaveImages, saveMedia: selectedSaveMedia } });
    res.json({ jobId: job.id });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

app.get('/api/archive/:jobId/events', captureOnly, (req, res) => {
  const job = jobFor(req);
  if (!job) return res.status(404).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  if (job.status === 'done') { send('done', job.result); return res.end(); }
  if (job.status === 'error') { send('error', { error: job.error }); return res.end(); }
  if (job.status === 'stopped') { send('stopped', {}); return res.end(); }
  if (job.status === 'awaiting-verification' && job.verificationInfo) send('progress', { type: 'verification', ...job.verificationInfo });
  if (job.status !== 'awaiting-verification' && job.progress) send('progress', job.progress);

  const onProgress = (event) => send('progress', event);
  const onDone = (result) => { send('done', result); res.end(); };
  const onError = (message) => { send('error', { error: message }); res.end(); };
  const onStopped = () => { send('stopped', {}); res.end(); };

  job.emitter.on('progress', onProgress);
  job.emitter.on('done', onDone);
  job.emitter.on('error', onError);
  job.emitter.on('stopped', onStopped);

  req.on('close', () => {
    job.emitter.off('progress', onProgress);
    job.emitter.off('done', onDone);
    job.emitter.off('error', onError);
    job.emitter.off('stopped', onStopped);
  });
});

app.post('/api/archive/:jobId/stop', captureOnly, async (req, res) => {
  const job = jobFor(req);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (!isFinished(job)) {
    await abortCapture(job);
    if (job.status === 'queued') {
      updateJob(job, { status: 'stopped' });
      job.emitter.emit('stopped');
    }
  }
  res.json({ ok: true });
});

app.get('/api/wayback/snapshots', captureOnly, async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A url is required.' });
  }

  let target;
  try {
    target = normalizeUrl(url);
  } catch {
    return res.status(400).json({ error: 'That does not look like a valid URL.' });
  }

  try {
    const snapshots = await listSnapshots(target);
    res.json({ url: target, snapshots });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Imports one existing Wayback Machine snapshot, reusing the exact same background-job/SSE/stop
// machinery as a live archive (see POST /api/archive above) since this also does real Puppeteer
// work - it just renders already-fetched HTML instead of navigating live.
app.post('/api/wayback/import', captureOnly, async (req, res) => {
  const { url, timestamp } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A url is required.' });
  }
  if (!timestamp || !/^\d{14}$/.test(timestamp)) {
    return res.status(400).json({ error: 'A valid Wayback snapshot timestamp is required.' });
  }

  let target;
  try {
    target = normalizeUrl(url);
  } catch {
    return res.status(400).json({ error: 'That does not look like a valid URL.' });
  }

  const ip = getClientIp(req);
  log(`Wayback import requested: ${target} @ ${timestamp} from ${ip}`);

  try {
    const job = startCapture({ kind: 'wayback', target, timestampHint: timestamp, ip, owner: req.account.username });
    res.json({ jobId: job.id });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Read-only reflection of config.js's website-facing knobs - there's no PUT here on purpose,
// since these are server-operator settings (see config.js), not something a visitor can change.
app.get('/api/settings', (req, res) => {
  res.json({
    showTimeline: config.SHOW_TIMELINE_FEED,
    enableAnimatedBackground: config.ENABLE_ANIMATED_BACKGROUND,
    enableMediaDownloads: config.ENABLE_MEDIA_DOWNLOADS,
    role: req.account.role,
    sharedAccess: access.enabled,
  });
});

app.get('/api/sites', async (req, res) => {
  try {
    res.json(await listSites(ARCHIVE_DIR, await access.allowedRoots(req)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/timeline', async (req, res) => {
  try {
    const roots = await access.allowedRoots(req);
    res.json((await listTimeline(ARCHIVE_DIR)).filter((entry) => !roots || roots.has(entry.dir)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sites/:domain', async (req, res) => {
  try {
    const roots = await access.allowedRoots(req);
    const history = (await listSiteHistory(ARCHIVE_DIR, req.params.domain))?.filter((entry) => !roots || roots.has(entry.dir));
    if (!history || (roots && !history.length)) return res.status(404).json({ error: 'Site not found.' });
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    res.json(await searchArchives(ARCHIVE_DIR, String(req.query.q || ''), {
      timeline: req.query.scope === 'timeline', allowedRoots: await access.allowedRoots(req),
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tags', async (req, res) => {
  try {
    res.json(await listTags(ARCHIVE_DIR, await access.allowedRoots(req)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tags/:tag', async (req, res) => {
  try {
    res.json(await listByTag(ARCHIVE_DIR, req.params.tag, await access.allowedRoots(req)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/diff', async (req, res) => {
  const { from, to } = req.query;
  try {
    if (!await access.canRead(req, from) || !await access.canRead(req, to)) {
      return res.status(404).json({ error: 'Snapshot not found.' });
    }
    const before = await snapshotDirectory(ARCHIVE_DIR, from);
    const after = await snapshotDirectory(ARCHIVE_DIR, to);
    if (!before || !after || !sameUrl(before.meta.url, after.meta.url)) {
      return res.status(404).json({ error: 'Comparable snapshots not found.' });
    }
    const [textA, textB] = await comparisonText(before.absolute, after.absolute);
    if (textA == null || textB == null) {
      return res.status(404).json({ error: 'Saved text is unavailable for one or both snapshots.' });
    }

    const parts = diffWords(textA, textB).map((p) => ({ value: p.value, added: Boolean(p.added), removed: Boolean(p.removed) }));
    res.json({ parts, textA, textB });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/replay', async (req, res) => {
  try {
    const { dir } = req.query;
    if (!await access.canRead(req, dir)) return res.status(404).json({ error: 'Snapshot not found.' });
    const snapshot = await snapshotDirectory(ARCHIVE_DIR, dir);
    if (!snapshot) return res.status(404).json({ error: 'Snapshot not found.' });
    const versions = (await listAllArchives(ARCHIVE_DIR, await access.allowedRoots(req)))
      .filter((entry) => entry.dir !== dir && sameUrl(entry.url, snapshot.meta.url))
      .sort((a, b) => new Date(b.archivedAt) - new Date(a.archivedAt));
    res.json({ formats: await snapshotFormats(snapshot), versions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/replay/:format', async (req, res) => {
  try {
    const { dir } = req.query;
    const { format } = req.params;
    if (!['reader', 'warc'].includes(format) || !await access.canRead(req, dir)) {
      return res.status(404).json({ error: 'Snapshot format not found.' });
    }
    const snapshot = await snapshotDirectory(ARCHIVE_DIR, dir);
    if (!snapshot || !(await snapshotFormats(snapshot))[format]) {
      return res.status(404).json({ error: 'Snapshot format not found.' });
    }
    if (format === 'reader') return res.type('text/plain').sendFile(path.join(snapshot.absolute, formats.reader));
    const replay = await readWarc(snapshot);
    if (!replay) return res.status(404).json({ error: 'The WARC has no replayable HTML response.' });
    res.json(replay);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/sites/:domain', adminOnly, async (req, res) => {
  try {
    const deleted = await deleteSite(ARCHIVE_DIR, req.params.domain);
    if (!deleted) return res.status(404).json({ error: 'Site not found.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/archives/delete', adminOnly, async (req, res) => {
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

app.post('/api/archives/organize', adminOnly, async (req, res) => {
  const { dirs, action, value } = req.body || {};
  try {
    const count = await organizeArchives(ARCHIVE_DIR, dirs, action, value);
    res.json({ count });
    for (const dir of new Set(dirs)) {
      storage.replicate(dir).catch((err) => log('S3 replication failed: ' + err.message));
      if (action === 'move') operations.mirrorCapture(dir)
        .catch((err) => operations.notify('Public mirror failed', { dir, error: err.message }));
    }
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

function operation(handler) {
  return async (req, res) => {
    try { res.json(await handler(req)); }
    catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  };
}

app.get('/api/operations/jobs', captureOnly, operation((req) => listJobs(
  req.account.username, req.account.role === 'admin',
).map(summarizeJob)));
app.post('/api/operations/jobs/:jobId/retry', captureOnly, operation((req) => {
  const job = jobFor(req);
  if (!job) throw operationError('Job not found.', 404);
  if (!summarizeJob(job).canRetry) throw operationError('This job cannot be retried.', 409);
  return summarizeJob(startCapture(job.descriptor));
}));

app.get('/api/operations/schedules', adminOnly, operation(() => ({
  schedules: operations.schedules,
  notifications: operations.notifications,
})));
app.post('/api/operations/schedules', adminOnly, operation((req) =>
  operations.schedule(req.body || {}, canonicalizeUrl, req.account.username)));
app.patch('/api/operations/schedules/:id', adminOnly, operation((req) =>
  operations.setSchedule(req.params.id, req.body?.enabled)));
app.delete('/api/operations/schedules/:id', adminOnly, operation((req) => {
  operations.removeSchedule(req.params.id);
  return { ok: true };
}));
app.post('/api/operations/schedules/:id/run', adminOnly, operation((req) => {
  const record = operations.schedules.find((item) => item.id === req.params.id);
  if (!record) throw operationError('Schedule not found.', 404);
  const job = runScheduledCapture(record);
  if (!job) throw operationError('A capture is already queued for this schedule.', 409);
  return summarizeJob(job);
}));

app.get('/api/operations/storage', adminOnly, operation(async () => ({
  usage: await storageUsage(ARCHIVE_DIR), s3: storage.enabled, replicate: storage.replicateEnabled,
})));
app.post('/api/operations/retention/preview', adminOnly, operation(async (req) =>
  operations.previewRetention(await listTimeline(ARCHIVE_DIR), req.body || {})));
app.post('/api/operations/retention/apply', adminOnly, operation(async (req) => {
  const dirs = operations.retentionSelection(req.body?.token);
  await deleteMainDirs(ARCHIVE_DIR, dirs);
  return { deleted: dirs.length };
}));
function requireIdleCaptureQueue() {
  if (listJobs(null, true).some((job) => !isFinished(job))) {
    throw operationError('Wait for running and queued captures to finish.', 409);
  }
}

app.post('/api/operations/storage/backup', adminOnly, operation(() => {
  requireIdleCaptureQueue();
  return storage.backup();
}));
app.post('/api/operations/storage/restore', adminOnly, operation(async () => {
  requireIdleCaptureQueue();
  const result = await storage.restore();
  backfillSearchIndex(true);
  return result;
}));

app.get('/api/operations/mirrors', adminOnly, operation(async () => ({
  enabled: operations.mirrorAvailable,
  collections: [...new Set((await listTimeline(ARCHIVE_DIR)).map((entry) => entry.collection).filter(Boolean))],
  publicCollections: operations.publicCollections,
})));
app.post('/api/operations/mirrors', adminOnly, operation(async (req) => {
  const { collection, enabled } = req.body || {};
  if (enabled && !(await listTimeline(ARCHIVE_DIR)).some((entry) => entry.collection === collection)) {
    throw operationError('The collection does not exist.', 404);
  }
  operations.setPublicCollection(collection, enabled);
  return { publicCollections: operations.publicCollections };
}));

app.get('/api/operations/assets', adminOnly, operation(async (req) => {
  const { dir } = req.query;
  if (!await access.canRead(req, dir)) throw operationError('Snapshot not found.', 404);
  const snapshot = await snapshotDirectory(ARCHIVE_DIR, dir);
  if (!snapshot) throw operationError('Snapshot not found.', 404);
  return readFailedAssets(snapshot);
}));
app.post('/api/operations/assets/retry', adminOnly, operation(async (req) => {
  const { dir, index } = req.body || {};
  if (!await access.canRead(req, dir)) throw operationError('Snapshot not found.', 404);
  const snapshot = await snapshotDirectory(ARCHIVE_DIR, dir);
  if (!snapshot) throw operationError('Snapshot not found.', 404);
  return retryFailedAsset(snapshot, index);
}));

function sendArchiveZip(res, zip, prefix) {
  const filename = `${prefix}-${new Date().toISOString().slice(0, 10)}.zip`;
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.send(zip.toBuffer());
}

app.post('/api/archives/export', adminOnly, async (req, res) => {
  try {
    const archives = await resolveSelectedArchives(ARCHIVE_DIR, req.body?.dirs);
    const zip = new AdmZip();
    for (const { dir, absolute } of archives) zip.addLocalFolder(absolute, dir);
    sendArchiveZip(res, zip, 'timecapsule-selection');
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/export', adminOnly, async (req, res) => {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    return res.status(404).json({ error: 'Nothing archived yet.' });
  }

  try {
    const zip = new AdmZip();
    zip.addLocalFolder(ARCHIVE_DIR);
    sendArchiveZip(res, zip, 'timecapsule-export');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/import', adminOnly, upload.single('archive'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  try {
    const zip = new AdmZip(req.file.buffer);
    await fs.promises.mkdir(ARCHIVE_DIR, { recursive: true });
    zip.extractAllTo(ARCHIVE_DIR, true);
    backfillSearchIndex(true);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: `That doesn't look like a valid TimeCapsule export: ${err.message}` });
  }
});

// Self-healing full-text search index: catches up on any archive that predates the search
// feature, was imported from another machine, or exists because the index file was deleted.
// Runs in the background so it never delays the server actually starting up.
async function backfillSearchIndex(force = false) {
  try {
    const archives = await listAllArchives(ARCHIVE_DIR);
    const indexed = getIndexedDirs();
    let added = 0;

    for (const entry of archives) {
      if (!force && indexed.has(entry.dir)) continue;
      const html = await fs.promises.readFile(path.join(ARCHIVE_DIR, entry.dir, 'page.html'), 'utf8').catch(() => null);
      if (html == null) continue;
      const ocrText = await fs.promises.readFile(path.join(ARCHIVE_DIR, entry.dir, 'ocr.txt'), 'utf8').catch(() => '');
      indexPage({ ...entry, html, ocrText });
      added += 1;
    }

    if (added) log(`Search index: backfilled ${added} archive(s).`);
  } catch (err) {
    log(`Search index backfill failed: ${err.message}`);
  }
}

app.listen(PORT, async () => {
  log(`TimeCapsule running at http://localhost:${PORT}`);
  await Promise.all(restoredJobs.interrupted.map((job) => removeInterruptedCapture(job)
    .catch((err) => log('Interrupted capture cleanup failed: ' + err.message))));
  backfillSearchIndex();
  for (const job of restoredJobs.pending) runCapture(job).catch((err) => log('Queue restore failed: ' + err.message));
  runDueSchedules();
  setInterval(runDueSchedules, 15_000).unref();
});

async function shutDown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    await browser?.close().catch(() => {});
  }
  process.exit(0);
}

process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);
