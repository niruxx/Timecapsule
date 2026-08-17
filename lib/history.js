const fs = require('fs/promises');
const path = require('path');

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
      thumbnail: await thumbnailWebPath(baseDir, dir),
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
        thumbnail: await thumbnailWebPath(baseDir, mainDir),
        sublinks: sublinks.sort((a, b) => a.url.localeCompare(b.url)),
      });
    }
  }

  mains.sort((a, b) => new Date(b.archivedAt) - new Date(a.archivedAt));
  return mains;
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

// Every archive run across every site, newest first - powers the main photo-grid timeline.
async function listTimeline(baseDir) {
  const mains = await listAllMains(baseDir);
  return mains.map((entry) => ({
    domain: entry.domain,
    url: entry.url,
    archivedAt: entry.archivedAt,
    dir: entry.dir,
    thumbnail: entry.thumbnail,
    sublinkCount: entry.sublinks.length,
  }));
}

// Every archive run for one domain, for the per-site calendar view.
async function listSiteHistory(baseDir, domain) {
  const domainEntries = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  const match = domainEntries.find((e) => e.isDirectory() && e.name === domain);
  if (!match) return null;

  const mains = await listAllMains(baseDir);
  return mains
    .filter((entry) => entry.domain === domain)
    .map((entry) => ({
      url: entry.url,
      archivedAt: entry.archivedAt,
      dir: entry.dir,
      thumbnail: entry.thumbnail,
      sublinkCount: entry.sublinks.length,
    }))
    .sort((a, b) => new Date(a.archivedAt) - new Date(b.archivedAt));
}

async function searchArchives(baseDir, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const mains = await listAllMains(baseDir);
  const results = [];

  for (const entry of mains) {
    if (entry.domain.toLowerCase().includes(q) || entry.url.toLowerCase().includes(q)) {
      results.push({
        domain: entry.domain,
        url: entry.url,
        archivedAt: entry.archivedAt,
        dir: entry.dir,
        thumbnail: entry.thumbnail,
        isSublink: false,
      });
    }
    for (const sub of entry.sublinks) {
      if (sub.url.toLowerCase().includes(q)) {
        results.push({
          domain: entry.domain,
          url: sub.url,
          archivedAt: sub.archivedAt,
          dir: sub.dir,
          thumbnail: sub.thumbnail,
          isSublink: true,
        });
      }
    }
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

    const domainDir = path.dirname(fullPath);
    const remaining = await fs.readdir(domainDir).catch(() => null);
    if (remaining && remaining.length === 0) {
      await fs.rmdir(domainDir).catch(() => {});
    }
  }
}

module.exports = { listSites, listTimeline, listSiteHistory, searchArchives, deleteSite, deleteMainDirs };
