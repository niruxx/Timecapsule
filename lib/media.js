const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const YTDlpWrap = require('yt-dlp-wrap-plus').default;
const { MAX_CONCURRENT_MEDIA_DOWNLOADS, ENABLE_MEDIA_DOWNLOADS } = require('../config');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const BINARY_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const MAX_MEDIA_ITEMS = 2;
const MEDIA_TIMEOUT_MS = 90 * 1000;
const MAX_MEDIA_FILESIZE = '250M';

// Runs `fn` over `items` with at most `limit` calls in flight at once, rather than either fully
// sequential (slow) or a bare Promise.all (unbounded - fine for MAX_MEDIA_ITEMS' current small
// value, but this stays correct if that's ever raised).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

const KNOWN_VIDEO_HOST_RE = /(^|\.)youtube\.com$|^youtu\.be$|(^|\.)vimeo\.com$/i;

function isKnownVideoUrl(url) {
  try {
    return KNOWN_VIDEO_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Combines the per-item download timeout with a caller-supplied abort signal (e.g. a job's
// "stop" button) so either one can cut a yt-dlp download short - manual merge rather than
// AbortSignal.any() to avoid depending on a newer Node version than the rest of the app needs.
function combineSignals(a, b) {
  if (!a) return b;
  if (!b) return a;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a.addEventListener('abort', onAbort);
  b.addEventListener('abort', onAbort);
  return controller.signal;
}

let ytDlp;
let ensureBinaryPromise;

// Lazily downloads the yt-dlp binary the first time it's actually needed, rather than at
// `npm install` (like Puppeteer does for Chromium) - most archives never touch a video page,
// so there's no reason to make every install pay for a ~15MB download it may never use.
function ensureBinary() {
  if (!ensureBinaryPromise) {
    ensureBinaryPromise = (async () => {
      if (!fssync.existsSync(BINARY_PATH)) {
        await fs.mkdir(BIN_DIR, { recursive: true });
        await YTDlpWrap.downloadFromGithub(BINARY_PATH);
      }
      ytDlp = new YTDlpWrap(BINARY_PATH);
    })().catch((err) => {
      // Don't cache a failed download (e.g. a transient network blip) forever - let the next
      // archive that needs media retry it instead of being silently broken for the rest of the
      // process's lifetime.
      ensureBinaryPromise = null;
      throw err;
    });
  }
  return ensureBinaryPromise;
}

// Best-effort: downloads any video/audio TimeCapsule can find for this page into <dir>/media/.
// Anything that goes wrong here (unsupported site, no video actually present, network error,
// oversized file, missing binary download) is swallowed rather than failing the whole archive -
// this is a bonus capture on top of the HTML/PDF/screenshot, not a required one.
async function downloadMedia(candidateUrls, dir, externalSignal) {
  // Master switch (config.js) - checked before anything else so a disabled instance never
  // downloads the yt-dlp binary or spawns it, regardless of what a request asks for.
  if (!ENABLE_MEDIA_DOWNLOADS) return [];

  const urls = [...new Set(candidateUrls)].slice(0, MAX_MEDIA_ITEMS);
  if (!urls.length) return [];

  const mediaDir = path.join(dir, 'media');

  // Each item downloads into its own throwaway subdirectory rather than sharing mediaDir - lets
  // several downloads run concurrently (mapWithConcurrency below) without racing on a single
  // before/after directory listing to figure out which new file came from which source.
  const results = await mapWithConcurrency(urls, MAX_CONCURRENT_MEDIA_DOWNLOADS, async (sourceUrl, index) => {
    if (externalSignal && externalSignal.aborted) return null;
    const itemDir = path.join(mediaDir, `.tmp-${index}`);
    try {
      await ensureBinary();
      await fs.mkdir(itemDir, { recursive: true });

      await ytDlp.execPromise(
        [
          sourceUrl,
          '-o', path.join(itemDir, '%(title).80s-%(id)s.%(ext)s'),
          '-f', 'best[ext=mp4]/best',
          '--max-filesize', MAX_MEDIA_FILESIZE,
          '--no-playlist',
          '--no-warnings',
          '--windows-filenames',
        ],
        {},
        combineSignals(AbortSignal.timeout(MEDIA_TIMEOUT_MS), externalSignal)
      );

      const files = await fs.readdir(itemDir);
      if (!files.length) return null;

      await fs.mkdir(mediaDir, { recursive: true });
      const saved = [];
      for (const file of files) {
        await fs.rename(path.join(itemDir, file), path.join(mediaDir, file));
        saved.push({ sourceUrl, file: `media/${file}` });
      }
      return saved;
    } catch {
      // not downloadable (unsupported site, no media found, network error, filesize cap, etc.) - skip
      return null;
    } finally {
      await fs.rm(itemDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  const saved = results.filter(Boolean).flat();
  if (!saved.length) {
    await fs.rm(mediaDir, { recursive: true, force: true }).catch(() => {});
  }

  return saved;
}

module.exports = { downloadMedia, isKnownVideoUrl };
