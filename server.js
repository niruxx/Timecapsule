const fs = require('fs');
const path = require('path');
const express = require('express');
const puppeteer = require('puppeteer');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { archiveUrl } = require('./lib/archiver');
const { listSites, listTimeline, listSiteHistory, searchArchives, deleteSite, deleteMainDirs } = require('./lib/history');
const { log, logTraffic } = require('./lib/logger');

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

app.post('/api/archive', async (req, res) => {
  const { url, recursive } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A url is required.' });
  }

  let target;
  try {
    target = normalizeUrl(url);
  } catch {
    return res.status(400).json({ error: 'That does not look like a valid URL.' });
  }

  const ip = getClientIp(req);
  log(`Archive requested: ${target}${recursive ? ' (recursive)' : ''} from ${ip}`);
  logTraffic(target, ip);

  try {
    const browser = await getBrowser();
    const result = await archiveUrl(browser, target, ARCHIVE_DIR, {
      recursive: Boolean(recursive),
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

app.listen(PORT, () => {
  log(`TimeCapsule running at http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
  process.exit(0);
});
