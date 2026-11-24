const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { readJson, writeJsonAtomic } = require('./jobs');
const { Semaphore } = require('./semaphore');
const { snapshotDirectory } = require('./replay');
const { listTimeline } = require('./history');
const { indexPage } = require('./search-index');

const exec = promisify(execFile);
const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
const MAX_ASSET_BYTES = 12 * 1024 * 1024;

function operationError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function captureUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw operationError('Enter a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw operationError('Enter an HTTP or HTTPS URL without embedded credentials.');
  }
  return url.toString();
}

function createOperations(file, archiveDir, config) {
  const { schedules = [], notifications = [], publicCollections = [] } = readJson(file, {});
  const retentionPreviews = new Map();
  const ocr = new Semaphore(1);
  const mirrorKey = process.env.TIMECAPSULE_WAYBACK_KEY;
  const mirrorSecret = process.env.TIMECAPSULE_WAYBACK_SECRET;
  const mirrorsInFlight = new Set();

  function save() { writeJsonAtomic(file, { schedules, notifications, publicCollections }); }

  function schedule(input, canonicalize, owner) {
    const interval = Number(input.interval);
    if (!Number.isInteger(interval) || interval < 1 || interval > 525600) {
      throw operationError('Choose an interval from 1 to 525600 minutes.');
    }
    const url = canonicalize(captureUrl(input.url));
    const collection = typeof input.collection === 'string' ? input.collection.trim() : '';
    if (collection.length > 80) throw operationError('Collection names are limited to 80 characters.');
    if (schedules.some((item) => item.url === url)) throw operationError('A schedule already exists for this URL.', 409);
    const record = { id: randomUUID(), url, interval, collection, owner, enabled: true,
      nextAt: Date.now() + interval * MINUTE, lastAt: null };
    schedules.push(record);
    save();
    return record;
  }

  function setSchedule(id, enabled) {
    const record = schedules.find((item) => item.id === id);
    if (!record) throw operationError('Schedule not found.', 404);
    if (typeof enabled !== 'boolean') throw operationError('Choose whether to enable the schedule.');
    record.enabled = enabled;
    if (enabled) record.nextAt = Date.now() + record.interval * MINUTE;
    save();
    return record;
  }

  function removeSchedule(id) {
    const index = schedules.findIndex((item) => item.id === id);
    if (index < 0) throw operationError('Schedule not found.', 404);
    schedules.splice(index, 1);
    save();
  }

  function advanceSchedule(record) {
    record.lastAt = Date.now();
    record.nextAt = record.lastAt + record.interval * MINUTE;
    save();
  }

  function notify(message, details = {}) {
    notifications.unshift({ id: randomUUID(), at: Date.now(), message, ...details });
    if (notifications.length > 100) notifications.length = 100;
    save();
  }

  async function indexScreenshot(dir) {
    if (!config.ENABLE_OCR) return;
    await ocr.acquire();
    try {
      const snapshot = await snapshotDirectory(archiveDir, dir);
      if (!snapshot) return;
      const screenshot = path.join(snapshot.absolute, 'screenshot.png');
      try { await fs.access(screenshot); } catch { return; }
      const { stdout } = await exec('tesseract', [screenshot, 'stdout'], {
        timeout: 120_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, OMP_THREAD_LIMIT: '1' },
      });
      const html = await fs.readFile(path.join(snapshot.absolute, 'page.html'), 'utf8');
      await fs.writeFile(path.join(snapshot.absolute, 'ocr.txt'), stdout, 'utf8');
      indexPage({ dir, domain: dir.split('/')[0], ...snapshot.meta, html, ocrText: stdout });
    } finally { ocr.release(); }
  }

  function previewRetention(entries, input) {
    const days = Number(input.days);
    if (!Number.isInteger(days) || days < 1 || days > 36500) throw operationError('Enter a retention period in days.');
    const domain = typeof input.domain === 'string' ? input.domain.trim() : '';
    const cutoff = Date.now() - days * DAY;
    const candidates = entries.filter((entry) => Date.parse(entry.archivedAt) < cutoff && (!domain || entry.domain === domain));
    const now = Date.now();
    for (const [token, preview] of retentionPreviews) {
      if (preview.expires <= now) retentionPreviews.delete(token);
    }
    if (retentionPreviews.size >= 50) retentionPreviews.delete(retentionPreviews.keys().next().value);
    const token = randomUUID();
    retentionPreviews.set(token, { expires: now + 5 * MINUTE, dirs: candidates.map(({ dir }) => dir) });
    return { token, candidates };
  }

  function retentionSelection(token) {
    const preview = retentionPreviews.get(token);
    if (!preview || preview.expires <= Date.now()) throw operationError('The retention preview expired. Preview the rule again.', 409);
    retentionPreviews.delete(token);
    return preview.dirs;
  }

  function setPublicCollection(collection, enabled) {
    if (!mirrorKey || !mirrorSecret) throw operationError('Configure the Wayback API credentials first.');
    if (typeof collection !== 'string' || !collection.trim() || collection.length > 80 || typeof enabled !== 'boolean') {
      throw operationError('Select a collection and choose whether to publish.');
    }
    const index = publicCollections.indexOf(collection);
    if (enabled && index < 0) publicCollections.push(collection);
    if (!enabled && index >= 0) publicCollections.splice(index, 1);
    save();
  }

  async function mirrorCapture(dir) {
    if (!mirrorKey || !mirrorSecret || !publicCollections.length || mirrorsInFlight.has(dir)) return;
    mirrorsInFlight.add(dir);
    try {
      const entry = (await listTimeline(archiveDir)).find((item) => item.dir === dir);
      if (!entry?.collection || !publicCollections.includes(entry.collection) || entry.source === 'wayback' || entry.privateCapture) return;
      const file = path.join(archiveDir, dir, 'public-mirror.json');
      if (readJson(file, null)) return;
      const url = captureUrl(entry.url);
      const response = await fetch('https://web.archive.org/save', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: 'LOW ' + mirrorKey + ':' + mirrorSecret, Accept: 'application/json' },
        body: new URLSearchParams({ url }),
      });
      if (!response.ok) throw operationError(`Wayback rejected the mirror request (HTTP ${response.status}).`, 502);
      const data = await response.json();
      if (typeof data.job_id !== 'string') throw operationError('Wayback did not return a public capture job ID.', 502);
      writeJsonAtomic(file, { jobId: data.job_id, at: Date.now() });
      notify('Submitted to Wayback Machine', { url, dir, externalJobId: data.job_id });
    } finally { mirrorsInFlight.delete(dir); }
  }

  return {
    schedules, notifications, publicCollections, schedule, setSchedule, removeSchedule, advanceSchedule,
    notify, indexScreenshot, previewRetention, retentionSelection, setPublicCollection, mirrorCapture,
    mirrorAvailable: Boolean(mirrorKey && mirrorSecret),
  };
}

async function storageUsage(root) {
  const usage = Object.create(null);
  async function visit(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true }).catch((err) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) { await visit(full); continue; }
      if (!entry.isFile()) continue;
      const info = await fs.stat(full).catch((err) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (!info) continue;
      const relative = path.relative(root, full).split(path.sep);
      const ext = entry.name.split('.').pop().toLowerCase();
      const kind = relative.includes('media') ? 'Media' : entry.name.endsWith('.warc.gz') ? 'WARC'
        : ['png', 'jpg', 'jpeg'].includes(ext) ? 'Screenshots and thumbnails' : ext === 'html' ? 'HTML'
        : ext === 'pdf' ? 'PDF' : ['md', 'txt'].includes(ext) ? 'Text and OCR' : 'Metadata and other files';
      usage[kind] = (usage[kind] || 0) + info.size;
    }
  }
  await visit(root);
  return Object.entries(usage).map(([format, bytes]) => ({ format, bytes })).sort((a, b) => b.bytes - a.bytes);
}

async function readFailedAssets(snapshot) {
  return fs.readFile(path.join(snapshot.absolute, 'failed-assets.json'), 'utf8').then(JSON.parse).catch((err) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
}

async function retryFailedAsset(snapshot, index) {
  const assets = await readFailedAssets(snapshot);
  const asset = Number.isInteger(index) ? assets[index] : null;
  if (!asset || asset.status === 'recovered') throw operationError('Failed asset not found.', 404);
  const url = captureUrl(asset.url);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.body) throw operationError(`Asset retry failed (HTTP ${response.status}).`, 502);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > MAX_ASSET_BYTES) throw operationError('Recovered asset exceeds the size limit.', 413);
    chunks.push(Buffer.from(chunk));
  }
  const filename = `recovered-asset-${index}.bin`;
  await fs.writeFile(path.join(snapshot.absolute, filename), Buffer.concat(chunks));
  // Keep the original capture intact. Reload the report so retries of other rows aren't lost.
  const latest = await readFailedAssets(snapshot);
  latest[index] = { ...asset, status: 'recovered', filename };
  writeJsonAtomic(path.join(snapshot.absolute, 'failed-assets.json'), latest);
  return latest[index];
}

module.exports = { createOperations, operationError, storageUsage, readFailedAssets, retryFailedAsset };
