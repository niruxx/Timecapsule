const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const YTDlpWrap = require('yt-dlp-wrap-plus').default;

const BIN_DIR = path.join(__dirname, '..', 'bin');
const BINARY_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const MAX_MEDIA_ITEMS = 2;
const MEDIA_TIMEOUT_MS = 90 * 1000;
const MAX_MEDIA_FILESIZE = '250M';

const KNOWN_VIDEO_HOST_RE = /(^|\.)youtube\.com$|^youtu\.be$|(^|\.)vimeo\.com$/i;

function isKnownVideoUrl(url) {
  try {
    return KNOWN_VIDEO_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
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
async function downloadMedia(candidateUrls, dir) {
  const urls = [...new Set(candidateUrls)].slice(0, MAX_MEDIA_ITEMS);
  if (!urls.length) return [];

  const mediaDir = path.join(dir, 'media');
  const saved = [];

  for (const sourceUrl of urls) {
    try {
      await ensureBinary();
      await fs.mkdir(mediaDir, { recursive: true });
      const before = new Set(await fs.readdir(mediaDir));

      await ytDlp.execPromise(
        [
          sourceUrl,
          '-o', path.join(mediaDir, '%(title).80s-%(id)s.%(ext)s'),
          '-f', 'best[ext=mp4]/best',
          '--max-filesize', MAX_MEDIA_FILESIZE,
          '--no-playlist',
          '--no-warnings',
          '--windows-filenames',
        ],
        {},
        AbortSignal.timeout(MEDIA_TIMEOUT_MS)
      );

      const after = await fs.readdir(mediaDir);
      for (const file of after) {
        if (!before.has(file)) saved.push({ sourceUrl, file: `media/${file}` });
      }
    } catch {
      // not downloadable (unsupported site, no media found, network error, filesize cap, etc.) - skip
    }
  }

  if (!saved.length) {
    await fs.rm(mediaDir, { recursive: true, force: true }).catch(() => {});
  }

  return saved;
}

module.exports = { downloadMedia, isKnownVideoUrl };
