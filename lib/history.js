const fs = require('fs/promises');
const path = require('path');
const { searchContent, removeDomainFromIndex, removeTreeFromIndex } = require('./search-index');

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readMetadata(dir) {
  try {
    const raw = await fs.readFile(path.join(dir, 'metadata.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toWebPath(baseDir, absoluteDir) {
  return path.relative(baseDir, absoluteDir).split(path.sep).join('/');
}

async function thumbnailWebPath(baseDir, dir) {
  const thumbPath = path.join(dir, 'thumbnail.jpg');
  return (await pathExists(thumbPath)) ? toWebPath(baseDir, thumbPath) : null;
}

async function articleWebPath(baseDir, dir) {
  const articlePath = path.join(dir, 'article.md');
  return (await pathExists(articlePath)) ? toWebPath(baseDir, articlePath) : null;
}

async function screenshotWebPath(baseDir, dir) {
  const screenshotPath = path.join(dir, 'screenshot.png');
  return (await pathExists(screenshotPath)) ? toWebPath(baseDir, screenshotPath) : null;
}

async function warcWebPath(baseDir, dir) {
  const warcPath = path.join(dir, 'page.warc.gz');
  return (await pathExists(warcPath)) ? toWebPath(baseDir, warcPath) : null;
}

// `meta.media` stores paths relative to the archive dir (e.g. "media/video.mp4"); expose them
// as full paths relative to baseDir, like every other asset path here.
function mediaWebPaths(baseDir, dir, meta) {
  const items = Array.isArray(meta.media) ? meta.media : [];
  return items.map((m) => ({ sourceUrl: m.sourceUrl, file: toWebPath(baseDir, path.join(dir, m.file)) }));
}

// Every non-identity field an archived page can carry - pulled into one place since every
// caller below (findArchives, listAllMains) needs the same set, and each addition here
// (screenshot, warc, media, AI summary/tags/entities) used to mean editing five call sites.
async function buildAssetFields(baseDir, dir, meta) {
  return {
    title: meta.title || null,
    thumbnail: await thumbnailWebPath(baseDir, dir),
    article: await articleWebPath(baseDir, dir),
    screenshot: await screenshotWebPath(baseDir, dir),
    warc: await warcWebPath(baseDir, dir),
    media: mediaWebPaths(baseDir, dir, meta),
    summary: meta.aiSummary || null,
    tags: Array.isArray(meta.aiTags) ? meta.aiTags : [],
    entities: Array.isArray(meta.aiEntities) ? meta.aiEntities : [],
    change: meta.changeSincePrevious || null,
    previousArchiveDir: meta.previousArchiveDir || null,
  };
}

// Recursively finds archive folders (directories containing metadata.json) under `dir`,
// without descending into an archive folder once one is found.
async function findArchives(baseDir, dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  if (entries.some((e) => e.isFile() && e.name === 'metadata.json')) {
    const meta = await readMetadata(dir);
    if (!meta) return [];
    return [{
      url: meta.url,
      archivedAt: meta.archivedAt,
      dir: toWebPath(baseDir, dir),
      ...(await buildAssetFields(baseDir, dir, meta)),
    }];
  }

  const nested = await Promise.all(
    entries.filter((e) => e.isDirectory()).map((e) => findArchives(baseDir, path.join(dir, e.name)))
  );
  return nested.flat();
}

// Flat list of every top-level archived URL (one per archive run), each with its nested sub-links.
async function listAllMains(baseDir) {
  if (!(await pathExists(baseDir))) return [];

  const domainEntries = await fs.readdir(baseDir, { withFileTypes: true });
  const mains = [];

  for (const domainEntry of domainEntries) {
    if (!domainEntry.isDirectory()) continue;
    const domainDir = path.join(baseDir, domainEntry.name);
    const timestampEntries = await fs.readdir(domainDir, { withFileTypes: true });

    for (const tsEntry of timestampEntries) {
      if (!tsEntry.isDirectory()) continue;
      const mainDir = path.join(domainDir, tsEntry.name);
      const meta = await readMetadata(mainDir);
      if (!meta) continue;

      const sublinksDir = path.join(mainDir, 'sub-links');
      const sublinks = (await pathExists(sublinksDir)) ? await findArchives(baseDir, sublinksDir) : [];

      mains.push({
        domain: domainEntry.name,
        url: meta.url,
        archivedAt: meta.archivedAt,
        dir: toWebPath(baseDir, mainDir),
        ...(await buildAssetFields(baseDir, mainDir, meta)),
        sublinks: sublinks.sort((a, b) => a.url.localeCompare(b.url)),
      });
    }
  }

  mains.sort((a, b) => new Date(b.archivedAt) - new Date(a.archivedAt));
  return mains;
}

// The most recent main-URL archive of `url` within the last `withinMs`, if any - used to skip
// re-capturing a URL that was just archived moments ago (an accidental double-submit, or a feed
// polling the same link twice) without blocking a genuine "archive this again to track changes"
// request made any real time later.
async function findRecentArchive(baseDir, url, withinMs) {
  const mains = await listAllMains(baseDir);
  const cutoff = Date.now() - withinMs;
  return mains.find((m) => m.url === url && new Date(m.archivedAt).getTime() >= cutoff) || null;
}

// The most recent PRIOR archive of `url`, regardless of age - used for change detection, where
// "did this page change since the last time I looked" should work whether that was five minutes
// or five months ago (unlike findRecentArchive's short dedup window above).
async function findLatestArchiveOfUrl(baseDir, url) {
  const mains = await listAllMains(baseDir);
  const matches = mains.filter((m) => m.url === url);
  if (!matches.length) return null;
  matches.sort((a, b) => new Date(b.archivedAt) - new Date(a.archivedAt));
  return matches[0];
}

// Every individual archived page - mains and their sub-links, flattened - for tasks (like
// backfilling the search index, or building the tag index) that need to walk every archive
// regardless of where it sits in the tree.
async function listAllArchives(baseDir) {
  const mains = await listAllMains(baseDir);
  const flat = [];
  for (const entry of mains) {
    flat.push({
      dir: entry.dir, url: entry.url, domain: entry.domain, title: entry.title,
      archivedAt: entry.archivedAt, tags: entry.tags,
    });
    for (const sub of entry.sublinks) {
      flat.push({
        dir: sub.dir, url: sub.url, domain: entry.domain, title: sub.title,
        archivedAt: sub.archivedAt, tags: sub.tags,
      });
    }
  }
  return flat;
}

// One card per domain, for the Snapshots grid.
async function listSites(baseDir) {
  const mains = await listAllMains(baseDir);
  const byDomain = new Map();

  for (const entry of mains) {
    const existing = byDomain.get(entry.domain);
    if (!existing) {
      byDomain.set(entry.domain, {
        domain: entry.domain,
        count: 1,
        latestUrl: entry.url,
        latestArchivedAt: entry.archivedAt,
        thumbnail: entry.thumbnail,
      });
    } else {
      existing.count += 1;
      if (new Date(entry.archivedAt) > new Date(existing.latestArchivedAt)) {
        existing.latestUrl = entry.url;
        existing.latestArchivedAt = entry.archivedAt;
        existing.thumbnail = entry.thumbnail;
      }
    }
  }

  return Array.from(byDomain.values()).sort(
    (a, b) => new Date(b.latestArchivedAt) - new Date(a.latestArchivedAt)
  );
}

// Strips `sublinks` off a listAllMains() entry, leaving just the fields callers actually expose.
function toPublicMain(entry) {
  const { sublinks, ...rest } = entry;
  return rest;
}

// A sub-link entry (from findArchives) never carries its own `domain` - it inherits its parent's.
function toPublicSub(entry, domain) {
  return { domain, ...entry };
}

// Every archive run across every site, newest first - powers the main photo-grid timeline.
async function listTimeline(baseDir) {
  const mains = await listAllMains(baseDir);
  return mains.map((entry) => ({ ...toPublicMain(entry), sublinkCount: entry.sublinks.length }));
}

// Every archive run for one domain, for the per-site calendar view.
async function listSiteHistory(baseDir, domain) {
  const domainEntries = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  const match = domainEntries.find((e) => e.isDirectory() && e.name === domain);
  if (!match) return null;

  const mains = await listAllMains(baseDir);
  return mains
    .filter((entry) => entry.domain === domain)
    .map((entry) => ({ ...toPublicMain(entry), sublinkCount: entry.sublinks.length }))
    .sort((a, b) => new Date(a.archivedAt) - new Date(b.archivedAt));
}

// Every unique AI tag currently in use, with how many archives carry it - powers the tag
// browser (Smart Collections). Cheap to compute on demand: it's just a scan of already-loaded
// metadata, no separate index to keep in sync.
async function listTags(baseDir) {
  const archives = await listAllArchives(baseDir);
  const counts = new Map();
  for (const entry of archives) {
    for (const tag of entry.tags || []) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// Every archive (main or sub-link) carrying a given tag, newest first - the tag browser's
// per-tag view.
async function listByTag(baseDir, tag) {
  const mains = await listAllMains(baseDir);
  const results = [];

  for (const entry of mains) {
    if (entry.tags.includes(tag)) results.push(toPublicMain(entry));
    for (const sub of entry.sublinks) {
      if (sub.tags.includes(tag)) results.push(toPublicSub(sub, entry.domain));
    }
  }

  results.sort((a, b) => new Date(b.archivedAt) - new Date(a.archivedAt));
  return results;
}

async function searchArchives(baseDir, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const mains = await listAllMains(baseDir);
  const results = [];
  const seenDirs = new Set();
  const byDir = new Map();

  for (const entry of mains) {
    const mainAsset = toPublicMain(entry);
    byDir.set(entry.dir, { ...mainAsset, isSublink: false });

    if (entry.domain.toLowerCase().includes(q) || entry.url.toLowerCase().includes(q)) {
      results.push({ ...mainAsset, isSublink: false });
      seenDirs.add(entry.dir);
    }

    for (const sub of entry.sublinks) {
      const subAsset = toPublicSub(sub, entry.domain);
      byDir.set(sub.dir, { ...subAsset, isSublink: true });

      if (sub.url.toLowerCase().includes(q)) {
        results.push({ ...subAsset, isSublink: true });
        seenDirs.add(sub.dir);
      }
    }
  }

  // Full-text matches inside the archived page content itself, merged in after the URL/domain
  // matches above (a "content match without also matching the URL" is a different, weaker kind
  // of relevance than "the site/link you actually remember"). Skipped entirely, rather than
  // erroring, if the search index is unavailable.
  for (const hit of searchContent(q)) {
    if (seenDirs.has(hit.dir)) continue;
    const asset = byDir.get(hit.dir);
    if (!asset) continue; // indexed but the archive has since been deleted/moved
    results.push({ ...asset, snippet: hit.snippet });
    seenDirs.add(hit.dir);
  }

  results.sort((a, b) => new Date(b.archivedAt) - new Date(a.archivedAt));
  return results.slice(0, 20);
}

// Deletes an entire domain's worth of archives, used by the Snapshots grid's per-site delete.
async function deleteSite(baseDir, domain) {
  const domainEntries = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  const match = domainEntries.find((e) => e.isDirectory() && e.name === domain);
  if (!match) return false;

  await fs.rm(path.join(baseDir, domain), { recursive: true, force: true });
  removeDomainFromIndex(domain);
  return true;
}

// A "main" archive dir is exactly <domain>/<timestamp> under baseDir - never a sub-links
// folder or anything deeper, and never outside baseDir.
function isMainDirPath(baseDir, relDir) {
  if (typeof relDir !== 'string' || !relDir || path.isAbsolute(relDir)) return false;
  const resolved = path.resolve(baseDir, relDir);
  const rel = path.relative(baseDir, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return rel.split(path.sep).length === 2;
}

// Deletes a batch of specific main archive dirs, used to delete everything archived on
// one calendar day. The caller (the calendar UI) already knows exactly which dirs fall on
// that day, so this trusts the provided list rather than re-deriving "day" boundaries
// server-side, which would be ambiguous across client/server time zones.
async function deleteMainDirs(baseDir, dirs) {
  const invalid = dirs.filter((d) => !isMainDirPath(baseDir, d));
  if (invalid.length) {
    const err = new Error(`Invalid archive path(s): ${invalid.join(', ')}`);
    err.status = 400;
    throw err;
  }

  for (const dir of dirs) {
    const fullPath = path.join(baseDir, dir);
    await fs.rm(fullPath, { recursive: true, force: true });
    removeTreeFromIndex(dir);

    const domainDir = path.dirname(fullPath);
    const remaining = await fs.readdir(domainDir).catch(() => null);
    if (remaining && remaining.length === 0) {
      await fs.rmdir(domainDir).catch(() => {});
    }
  }
}

module.exports = {
  listSites, listTimeline, listSiteHistory, searchArchives, deleteSite, deleteMainDirs,
  listAllArchives, listTags, listByTag, findRecentArchive, findLatestArchiveOfUrl,
};
