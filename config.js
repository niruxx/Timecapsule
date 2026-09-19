const fs = require('fs');
const path = require('path');

// Server-side tuning knobs - deliberately not exposed anywhere in the website UI, since these
// control how much load this machine takes on at once, which is an operator decision (what the
// hardware can handle), not something to expose as a per-archive request option.
//
// The values below are the defaults. To change one without editing this (tracked) file, create a
// config.json next to it - it's gitignored, so `git pull` / update.sh never conflict with it - e.g.
//
//   { "PORT": 8080, "MAX_CONCURRENT_ARCHIVES": 4 }
//
// Keys are the same names as below (case-insensitive: "port" works too). Restart the server to
// apply changes. Precedence for the port: the PORT environment variable, then config.json,
// then the default here.
const defaults = {
  // Port the server listens on. The PORT environment variable still overrides this when set
  // (existing systemd/pm2/Docker setups that already export PORT keep working unchanged).
  PORT: 3000,

  // How many archive/import jobs run their actual Puppeteer work at once (each one is a real
  // headless-Chromium page load). Requests beyond this limit still queue up and start as soon as
  // a slot frees, rather than being rejected - see lib/semaphore.js. Raise this on a beefier
  // machine, lower it on something like a Raspberry Pi.
  MAX_CONCURRENT_ARCHIVES: 10,

  // How many video/audio downloads (each a real yt-dlp subprocess) run at once within a single
  // page's media pass. Independent of MAX_CONCURRENT_ARCHIVES.
  MAX_CONCURRENT_MEDIA_DOWNLOADS: 2,

  // Whether the homepage shows the "Today"/"Yesterday" recent-snapshots feed below the archive
  // bar. There's no in-website control for this (no Settings button) - it's a look-and-feel
  // choice for whoever's running this instance, not a per-visitor preference.
  SHOW_TIMELINE_FEED: true,

  // Whether the drifting colored blobs behind the homepage animate. Disabling this leaves the
  // plain theme background in place - purely cosmetic, no effect on archiving.
  ENABLE_ANIMATED_BACKGROUND: true,

  // Master switch for the yt-dlp backend. When false, video/audio download is hard-disabled -
  // lib/media.js returns immediately without downloading the yt-dlp binary or spawning it, even
  // if a request explicitly asks for media (the "Download video/audio" advanced option is also
  // disabled in the UI in that case). Turn this off if you don't want this instance running
  // yt-dlp at all, e.g. on a locked-down or bandwidth-constrained host.
  ENABLE_MEDIA_DOWNLOADS: true,
};

const OVERRIDES_FILE = path.join(__dirname, 'config.json');

// A bad value is an error rather than something to skip past: silently ignoring a typo'd port
// would leave the server running somewhere other than where you told it to.
function validate(key, value) {
  const expected = typeof defaults[key];

  if (expected === 'number') {
    const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`"${key}" must be a whole number of 1 or more (got ${JSON.stringify(value)})`);
    }
    if (key === 'PORT' && n > 65535) {
      throw new Error(`"PORT" must be between 1 and 65535 (got ${n})`);
    }
    return n;
  }

  if (typeof value !== expected) {
    throw new Error(`"${key}" must be true or false (got ${JSON.stringify(value)})`);
  }
  return value;
}

function loadOverrides() {
  let raw;
  try {
    raw = fs.readFileSync(OVERRIDES_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`couldn't read config.json: ${err.message}`);
  }

  // Windows Notepad writes a UTF-8 byte-order mark, which JSON.parse rejects.
  let parsed;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    throw new Error(`config.json isn't valid JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config.json must contain a JSON object, e.g. { "PORT": 8080 }');
  }

  const overrides = {};
  for (const [rawKey, value] of Object.entries(parsed)) {
    const key = rawKey.toUpperCase();
    if (!(key in defaults)) {
      console.warn(`config.json: ignoring unknown setting "${rawKey}" (known settings: ${Object.keys(defaults).join(', ')})`);
      continue;
    }
    overrides[key] = validate(key, value);
  }
  return overrides;
}

let overrides;
try {
  overrides = loadOverrides();
} catch (err) {
  console.error(`\nTimeCapsule configuration error: ${err.message}\nFix ${OVERRIDES_FILE} (or delete it to use the defaults) and start again.\n`);
  process.exit(1);
}

module.exports = { ...defaults, ...overrides };
