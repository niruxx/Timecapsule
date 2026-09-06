const fs = require('fs/promises');
const path = require('path');
const puppeteer = require('puppeteer');
const TurndownService = require('turndown');
const { downloadMedia, isKnownVideoUrl } = require('./media');
const { buildWarc } = require('./warc');
const { indexPage } = require('./search-index');
const { enrichContent } = require('./ai-enrich');
const { summarizeChange } = require('./change-detect');
const { findLatestArchiveOfUrl } = require('./history');

const MAX_SUBLINKS = 15;
const MAX_RECURSIVE_PAGES = 100;
const NAV_TIMEOUT_MS = 30000;
const LAZY_LOAD_WAIT_MS = 8000;
const MAX_INLINE_BYTES = 8 * 1024 * 1024;
const MIN_ARTICLE_TEXT_LENGTH = 200;
const READABILITY_SCRIPT_PATH = require.resolve('@mozilla/readability/Readability.js');

const VERIFY_POLL_MS = 1500;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

// Weighted stages within a single page capture, used only to drive the progress indicator -
// the weights are rough guesses at relative cost, not measured, since exact timing varies
// wildly per site.
const STAGES = [
  ['navigate', 'Loading page', 10],
  ['scan', 'Scanning for media', 5],
  ['capture', 'Capturing PDF & screenshot', 20],
  ['warc', 'Recording network traffic', 15],
  ['inline', 'Inlining images & styles', 20],
  ['write', 'Writing files', 10],
  ['article', 'Extracting article & summary', 15],
  ['media', 'Downloading media', 5],
];

function isStopped(options) {
  return Boolean(options.job && options.job.abortController.signal.aborted);
}

function stopError() {
  return Object.assign(new Error('Archive stopped by user.'), { isStop: true });
}

function throwIfStopped(options) {
  if (isStopped(options)) throw stopError();
}

// Best-effort bot-check detector: looks for the handful of interstitial patterns that actually
// show up in practice (Cloudflare's challenge page, hCaptcha/reCAPTCHA/Turnstile widgets), not
// an exhaustive list - a missed challenge just means the page gets archived as-is instead of
// triggering the human hand-off below.
async function detectChallenge(page) {
  return page
    .evaluate(() => {
      const re = /just a moment|attention required|verify you are human|checking your browser|enable javascript and cookies to continue|please verify you are a human/i;
      const title = document.title || '';
      const bodyText = document.body ? document.body.innerText.slice(0, 3000) : '';
      const hasWidget = Boolean(
        document.querySelector(
          'iframe[src*="hcaptcha.com"], iframe[src*="recaptcha"], iframe[src*="challenges.cloudflare.com"], #cf-challenge-running, .cf-turnstile, #turnstile-wrapper, #challenge-form'
        )
      );
      return hasWidget || re.test(title) || re.test(bodyText);
    })
    .catch(() => false);
}

// Hands a bot-check off to a human: opens a second, *visible* Chrome window on the same URL and
// waits for the challenge to clear in it, then copies the resulting cookies back onto the
// original (still headless) page and re-navigates it. Only viable because TimeCapsule runs on
// the user's own desktop with a real display - this would do nothing useful on a headless server.
async function handleVerification(page, targetUrl, options) {
  const { job } = options;
  options.onVerification && options.onVerification({ status: 'opened' });

  const verifyBrowser = await puppeteer.launch({ headless: false, args: ['--window-size=1280,900'] });
  if (job) job.verifyBrowser = verifyBrowser;

  try {
    const verifyPage = await verifyBrowser.newPage();
    await verifyPage.setViewport({ width: 1280, height: 900 });
    if (options.userAgent) await verifyPage.setUserAgent(options.userAgent);
    if (options.cookies && options.cookies.length) {
      await verifyPage.setCookie(...options.cookies).catch(() => {});
    }
    await verifyPage.goto(targetUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS }).catch(() => {});

    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let stillChallenged = await detectChallenge(verifyPage);
    while (stillChallenged && Date.now() < deadline) {
      throwIfStopped(options);
      await new Promise((resolve) => setTimeout(resolve, VERIFY_POLL_MS));
      stillChallenged = await detectChallenge(verifyPage);
    }

    if (stillChallenged) throw new Error('Human verification was not completed in time.');

    const resolvedCookies = await verifyPage.cookies();
    if (resolvedCookies.length) await page.setCookie(...resolvedCookies).catch(() => {});
    options.onVerification && options.onVerification({ status: 'resolved' });
  } finally {
    if (job) job.verifyBrowser = null;
    await verifyBrowser.close().catch(() => {});
  }

  throwIfStopped(options);
  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
}

const turndownService = new TurndownService({ headingStyle: 'atx' });

function sanitizeSegment(segment) {
  const cleaned = segment.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return cleaned || '_';
}

function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

// The URL you archive -> archived/<domain>/<timestamp>/
function buildMainDir(baseDir, targetUrl, timestamp) {
  const domain = sanitizeSegment(new URL(targetUrl).hostname);
  return path.join(baseDir, domain, timestamp);
}

// A same-domain link found on that page -> <mainDir>/sub-links/<path>/<timestamp>/
function buildSublinkDir(mainDir, targetUrl, timestamp) {
  const pathSegments = new URL(targetUrl).pathname.split('/').filter(Boolean).map(sanitizeSegment);
  return path.join(mainDir, 'sub-links', ...pathSegments, timestamp);
}

function isInlinable(contentType) {
  return (
    /^image\//.test(contentType) ||
    /^font\//.test(contentType) ||
    /^application\/(x-)?font/.test(contentType) ||
    /^application\/vnd\.ms-fontobject/.test(contentType) ||
    /^text\/css/.test(contentType)
  );
}

// Scrolls the page to trigger lazy-loaded images/sections, then returns to the top.
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const distance = 600;
      const maxScroll = 15000;
      let scrolled = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        scrolled += distance;
        const atBottom = window.scrollY + window.innerHeight >= document.body.scrollHeight;
        if (atBottom || scrolled >= maxScroll) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 150);
    });
  });
}

// Runs inside the browser page (after Readability.js has been injected via addScriptTag).
// Parses a cloned copy of the DOM rather than the live one, since Readability.parse() is
// destructive - it strips the clone down to just the article as it works. A synthetic <base>
// tag is needed because cloneNode(true) on `document` drops the original document's URL, which
// Readability otherwise relies on to resolve the relative links/images inside the article.
function runReadability() {
  if (typeof Readability === 'undefined') return null;
  const clone = document.cloneNode(true);
  const base = clone.createElement('base');
  base.href = document.baseURI;
  clone.head.insertBefore(base, clone.head.firstChild);

  let article;
  try {
    article = new Readability(clone).parse();
  } catch {
    return null;
  }
  if (!article || !article.content) return null;

  return {
    title: article.title || null,
    byline: article.byline || null,
    excerpt: article.excerpt || null,
    contentHtml: article.content,
    textContent: article.textContent || '',
  };
}

// Runs inside the browser page: collects candidate video/audio URLs worth handing to yt-dlp -
// native <video>/<audio> sources plus known-embeddable iframe players (YouTube/Vimeo). Deliberately
// narrow (rather than every iframe) since yt-dlp can only do anything useful with a handful of
// sites anyway, and most iframes on a page are ads/widgets, not media.
function findMediaCandidates() {
  const embedRe = /youtube\.com\/embed|player\.vimeo\.com\/video/i;
  const urls = new Set();

  document.querySelectorAll('video[src], audio[src], video source[src], audio source[src]').forEach((el) => {
    try {
      urls.add(new URL(el.getAttribute('src'), location.href).href);
    } catch {
      // malformed src - ignore
    }
  });

  document.querySelectorAll('iframe[src]').forEach((el) => {
    const src = el.getAttribute('src');
    if (!src || !embedRe.test(src)) return;
    try {
      urls.add(new URL(src, location.href).href);
    } catch {
      // malformed src - ignore
    }
  });

  return Array.from(urls);
}

// Inlines a stylesheet's own url(...)/@import references using already-captured resources,
// recursing into @import'd stylesheets (guarded against cycles via `seen`).
function processCss(url, buffer, resources, seen) {
  if (seen.has(url)) return '';
  seen.add(url);
  let text = buffer.toString('utf8');

  text = text.replace(/@import\s+(?:url\()?["']?([^"')]+)["']?\)?\s*;/g, (match, importUrl) => {
    let resolved;
    try {
      resolved = new URL(importUrl, url).href;
    } catch {
      return match;
    }
    const nested = resources.get(resolved);
    if (nested && /^text\/css/.test(nested.contentType)) {
      return processCss(resolved, nested.buffer, resources, seen);
    }
    return `@import url("${resolved}");`;
  });

  text = text.replace(/url\((['"]?)(.*?)\1\)/g, (match, quote, inner) => {
    if (/^data:/.test(inner)) return match;
    let resolved;
    try {
      resolved = new URL(inner, url).href;
    } catch {
      return match;
    }
    const nested = resources.get(resolved);
    if (nested && !/^text\/css/.test(nested.contentType)) {
      return `url(${quote}data:${nested.contentType};base64,${nested.buffer.toString('base64')}${quote})`;
    }
    return `url(${quote}${resolved}${quote})`;
  });

  return text;
}

// Runs inside the browser page: makes the DOM self-contained (inline images/fonts/CSS as
// data URIs, absolute-ize remaining links) and strips scripts, since the DOM has already
// been fully rendered and a frozen static copy is what we want to keep.
function inlineDom(resourceMap, cssMap) {
  const abs = (url) => {
    try {
      return new URL(url, location.href).href;
    } catch {
      return url;
    }
  };
  const lookup = (url) => resourceMap[abs(url)];

  document.querySelectorAll('img, source, video, audio').forEach((el) => {
    const src = el.getAttribute('src');
    if (src) el.setAttribute('src', lookup(src) || abs(src));

    const srcset = el.getAttribute('srcset');
    if (srcset) {
      const rewritten = srcset
        .split(',')
        .map((part) => {
          const trimmed = part.trim();
          const spaceIdx = trimmed.indexOf(' ');
          const url = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
          const descriptor = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx);
          return (lookup(url) || abs(url)) + descriptor;
        })
        .join(', ');
      el.setAttribute('srcset', rewritten);
    }
  });

  document.querySelectorAll('video[poster]').forEach((el) => {
    const poster = el.getAttribute('poster');
    el.setAttribute('poster', lookup(poster) || abs(poster));
  });

  // Iframes (e.g. embedded video players) can't be made self-contained, but their src should
  // still point at the live original rather than staying relative - relative to what, once this
  // file has been moved or opened from somewhere else entirely?
  document.querySelectorAll('iframe[src]').forEach((el) => {
    el.setAttribute('src', abs(el.getAttribute('src')));
  });

  document.querySelectorAll('[style*="url("]').forEach((el) => {
    el.setAttribute(
      'style',
      el.getAttribute('style').replace(/url\((['"]?)(.*?)\1\)/g, (m, q, url) => `url(${q}${lookup(url) || abs(url)}${q})`)
    );
  });

  document.querySelectorAll('link[rel~="stylesheet"]').forEach((link) => {
    const href = link.getAttribute('href');
    const cssText = href ? cssMap[abs(href)] : undefined;
    if (cssText === undefined) {
      if (href) link.setAttribute('href', abs(href));
      return;
    }
    const style = document.createElement('style');
    style.textContent = cssText;
    link.replaceWith(style);
  });

  document.querySelectorAll('style').forEach((style) => {
    style.textContent = style.textContent.replace(/url\((['"]?)(.*?)\1\)/g, (m, q, url) => {
      if (/^data:/.test(url)) return m;
      return `url(${q}${lookup(url) || abs(url)}${q})`;
    });
  });

  document.querySelectorAll('link[rel*="icon"]').forEach((link) => {
    const href = link.getAttribute('href');
    if (href) link.setAttribute('href', lookup(href) || abs(href));
  });

  document.querySelectorAll('a[href]').forEach((a) => {
    a.setAttribute('href', abs(a.getAttribute('href')));
  });

  document.querySelectorAll('link[rel="preload"], link[rel="prefetch"], link[rel="modulepreload"]').forEach((el) => el.remove());
  document.querySelectorAll('script').forEach((el) => el.remove());
}

async function saveArchive(page, targetUrl, dir, baseDir, options = {}) {
  const stageOffsets = new Map();
  let offset = 0;
  for (const [key, label, weight] of STAGES) {
    stageOffsets.set(key, [offset, label]);
    offset += weight;
  }
  const emitStage = (key) => {
    if (!options.onStage) return;
    const [pct, label] = stageOffsets.get(key);
    options.onStage(pct, label);
  };

  throwIfStopped(options);
  await page.setViewport({ width: 1024, height: 768 });
  if (options.userAgent) {
    await page.setUserAgent(options.userAgent);
  }
  if (options.cookies && options.cookies.length) {
    // A cookie missing both `domain` and `url` is rejected by CDP - rather than aborting the
    // whole archive over one bad entry in an imported file, skip cookies and keep going.
    await page.setCookie(...options.cookies).catch(() => {});
  }

  const saveImages = options.saveImages !== false;
  const resources = new Map();
  const transactions = [];
  const onResponse = async (response) => {
    try {
      const contentType = (response.headers()['content-type'] || '').split(';')[0].trim();
      const buffer = await response.buffer();
      if (buffer.length > MAX_INLINE_BYTES) return;

      const skipImage = !saveImages && /^image\//.test(contentType);
      if (isInlinable(contentType) && !skipImage) {
        resources.set(response.url(), { buffer, contentType });
      }

      // Kept for the WARC capture (lib/warc.js) - every transaction under the size cap, not
      // just the inlinable ones, since a WARC is meant to hold the whole HTTP conversation.
      const request = response.request();
      transactions.push({
        url: response.url(),
        status: response.status(),
        statusText: response.statusText(),
        method: request.method(),
        requestHeaders: request.headers(),
        responseHeaders: response.headers(),
        body: buffer,
      });
    } catch {
      // resource body unavailable (redirected, aborted, served from disk cache) - skip it
    }
  };
  page.on('response', onResponse);

  emitStage('navigate');
  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });

  // Only checked for the page you actually asked to archive - a hand-off window per sub-link
  // would be unworkable, and once the main page's session cookies are resolved they carry over
  // to sub-link requests anyway (all pages share the same browser's cookie jar).
  if (options.isMainPage && (await detectChallenge(page))) {
    await handleVerification(page, targetUrl, options);
  }

  await autoScroll(page);
  await page.waitForNetworkIdle({ idleTime: 500, timeout: options.extraWaitMs ?? LAZY_LOAD_WAIT_MS }).catch(() => {});

  await page.addScriptTag({ path: READABILITY_SCRIPT_PATH });
  const article = await page.evaluate(runReadability).catch(() => null);

  emitStage('scan');
  const mediaCandidates = options.saveMedia
    ? [
        ...(isKnownVideoUrl(targetUrl) ? [targetUrl] : []),
        ...(await page.evaluate(findMediaCandidates).catch(() => [])),
      ]
    : [];

  emitStage('capture');
  const pdf = await page.pdf({ format: 'A4', printBackground: true });
  const thumbnail = await page.screenshot({ type: 'jpeg', quality: 70 });
  // Full-page screenshot, separate from the small viewport-only thumbnail used in the UI grids.
  // Wrapped in a catch because extremely tall pages can exceed Chromium's screenshot buffer -
  // better to skip this one file than fail the whole capture over it.
  const screenshot = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);

  page.off('response', onResponse);
  const capturedAt = new Date().toISOString();

  // Best-effort bonus format alongside page.html - if building the WARC fails for some reason,
  // that shouldn't take down a capture that otherwise succeeded.
  emitStage('warc');
  const warc = await buildWarc(targetUrl, transactions, capturedAt).catch(() => null);

  emitStage('inline');
  const resourceMap = {};
  const cssMap = {};
  for (const [url, { buffer, contentType }] of resources) {
    if (/^text\/css/.test(contentType)) {
      cssMap[url] = processCss(url, buffer, resources, new Set());
    } else {
      resourceMap[url] = `data:${contentType};base64,${buffer.toString('base64')}`;
    }
  }

  await page.evaluate(inlineDom, resourceMap, cssMap);
  const html = await page.content();

  emitStage('write');
  throwIfStopped(options);
  await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(path.join(dir, 'page.html'), html, 'utf8');
  await fs.writeFile(path.join(dir, 'page.pdf'), pdf);
  await fs.writeFile(path.join(dir, 'thumbnail.jpg'), thumbnail);
  if (screenshot) {
    await fs.writeFile(path.join(dir, 'screenshot.png'), screenshot);
  }
  if (warc) {
    await fs.writeFile(path.join(dir, 'page.warc.gz'), warc);
  }

  // Only keep the article extraction when it found enough real text to be worth it -
  // skips nav-only/landing pages where Readability still returns *something*, just not
  // anything resembling an article.
  emitStage('article');
  let articleMeta = null;
  let aiMeta = null;
  let changeMeta = null;
  if (article && article.textContent.trim().length >= MIN_ARTICLE_TEXT_LENGTH) {
    const markdown = (article.title ? `# ${article.title}\n\n` : '') + turndownService.turndown(article.contentHtml);
    await fs.writeFile(path.join(dir, 'article.md'), markdown, 'utf8');
    await fs.writeFile(path.join(dir, 'article.txt'), article.textContent.trim(), 'utf8');
    articleMeta = { title: article.title, byline: article.byline, excerpt: article.excerpt };

    // Only attempted for article-like pages, both because a nav/search-results page has
    // nothing worth summarizing and to keep this opt-in feature's API usage cost-conscious
    // by default. No-ops entirely unless ANTHROPIC_API_KEY is set.
    const enrichment = await enrichContent(article.textContent, article.title);
    if (enrichment) {
      aiMeta = { aiSummary: enrichment.summary, aiTags: enrichment.tags, aiEntities: enrichment.entities };
    }

    // Change detection: only for the URL you actually asked to archive (not incidental
    // sub-links swept up along the way), and only compared against a genuinely prior capture -
    // this is the current archive's own dir, but since it isn't written into metadata.json (and
    // therefore isn't visible to listAllMains) until later below, it can't match itself here.
    if (options.isMainPage) {
      try {
        const previous = await findLatestArchiveOfUrl(baseDir, targetUrl);
        if (previous) {
          const previousText = await fs.readFile(path.join(baseDir, previous.dir, 'article.txt'), 'utf8').catch(() => null);
          const change = summarizeChange(previousText, article.textContent.trim());
          if (change) changeMeta = { changeSincePrevious: change, previousArchiveDir: previous.dir };
        }
      } catch {
        // change detection is a bonus, not a required part of a successful archive
      }
    }
  }

  emitStage('media');
  throwIfStopped(options);
  const media = mediaCandidates.length
    ? await downloadMedia(mediaCandidates, dir, options.job && options.job.abortController.signal)
    : [];

  await fs.writeFile(
    path.join(dir, 'metadata.json'),
    JSON.stringify(
      { url: targetUrl, archivedAt: capturedAt, ...articleMeta, ...aiMeta, ...changeMeta, ...(media.length ? { media } : null) },
      null,
      2
    ),
    'utf8'
  );

  // Full-text search indexing is a bonus, not a required part of a successful archive - a
  // native-module or disk hiccup here shouldn't take down a capture that otherwise succeeded.
  try {
    indexPage({
      dir: path.relative(baseDir, dir).split(path.sep).join('/'),
      url: targetUrl,
      domain: new URL(targetUrl).hostname,
      title: articleMeta ? articleMeta.title : null,
      archivedAt: capturedAt,
      html,
    });
  } catch {
    // indexing failed - the archive itself is still complete and on disk
  }

  return { url: targetUrl, dir };
}

// Same-domain links found on the page, excluding anything already in `visited`.
// Newly found links are added to `visited` as they're returned, so the same URL
// is never queued twice across an entire crawl. `hasMore` reports whether at least
// one additional qualifying link existed beyond `limit`, so callers can tell a real
// "there was more we didn't capture" apart from "that's genuinely everything".
async function extractSameDomainLinks(page, targetUrl, visited, limit) {
  const origin = new URL(targetUrl).hostname;
  const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.href));

  const links = [];
  let hasMore = false;

  for (const href of hrefs) {
    let normalized;
    try {
      const u = new URL(href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      u.hash = '';
      normalized = u.toString();
      if (u.hostname !== origin) continue;
      if (visited.has(normalized)) continue;
    } catch {
      continue; // ignore malformed hrefs (e.g. mailto:, javascript:)
    }

    if (links.length >= limit) {
      hasMore = true;
      break;
    }
    visited.add(normalized);
    links.push(normalized);
  }

  return { links, hasMore };
}

function toRelative(baseDir, entry) {
  if (entry.error) return entry;
  return { ...entry, dir: path.relative(baseDir, entry.dir).split(path.sep).join('/') };
}

// Three depths of archiving:
// - 'page': just the URL you gave it, nothing else.
// - 'links': that page plus the same-domain links found on it, up to MAX_SUBLINKS (the default).
// - 'recursive': every same-domain page reachable by following links, breadth first, up to the
//   MAX_RECURSIVE_PAGES safety cap - real sites can be effectively unbounded, so this still means
//   "bounded, but generously" rather than "the whole internet".
async function archiveUrl(browser, targetUrl, baseDir, options = {}) {
  const depth = options.depth || 'links';
  const recursive = depth === 'recursive';
  const onProgress = options.onProgress || (() => {});
  const job = options.job || null;
  const maxTotalPages = depth === 'page' ? 1 : depth === 'recursive' ? MAX_RECURSIVE_PAGES : MAX_SUBLINKS + 1;
  const basePageOptions = {
    userAgent: options.userAgent,
    cookies: options.cookies,
    extraWaitMs: options.extraWaitMs,
    saveImages: options.saveImages,
    saveMedia: options.saveMedia,
    job,
  };

  // Drives the corner progress indicator: a page-local 0-100 (from the STAGES weights above) is
  // rescaled against how many pages we currently think there are in total. That total is only an
  // estimate - it grows as more same-domain links are discovered - so the percent can occasionally
  // step backwards slightly rather than being perfectly monotonic; capped below 100 until the
  // whole job is actually done so it never looks finished early.
  let estimatedTotalPages = 1;
  let pagesDone = 0;
  const makeStageHandler = (url) => (pagePercent, label) => {
    const overall = Math.min(99, Math.round(((pagesDone + pagePercent / 100) / estimatedTotalPages) * 100));
    onProgress({ type: 'stage', percent: overall, label, url });
  };

  const page = await browser.newPage();
  if (job) job.page = page;
  try {
    const mainDir = buildMainDir(baseDir, targetUrl, formatTimestamp(new Date()));
    if (job) job.mainDir = mainDir;
    const main = await saveArchive(page, targetUrl, mainDir, baseDir, {
      ...basePageOptions,
      isMainPage: true,
      onStage: makeStageHandler(targetUrl),
      onVerification: (event) => onProgress({ type: 'verification', ...event }),
    });
    pagesDone = 1;
    onProgress({ type: 'page', role: 'main', url: targetUrl });

    const visited = new Set([targetUrl]);
    const firstBatch = maxTotalPages > 1
      ? await extractSameDomainLinks(page, targetUrl, visited, maxTotalPages - 1)
      : { links: [], hasMore: false };
    const queue = firstBatch.links;
    let truncated = firstBatch.hasMore;
    estimatedTotalPages = Math.min(maxTotalPages, 1 + queue.length) || 1;

    const subResults = [];
    while (queue.length && subResults.length < maxTotalPages - 1) {
      if (job && job.abortController.signal.aborted) break;
      const link = queue.shift();
      const subPage = await browser.newPage();
      if (job) job.page = subPage;
      try {
        const subDir = buildSublinkDir(mainDir, link, formatTimestamp(new Date()));
        subResults.push(await saveArchive(subPage, link, subDir, baseDir, {
          ...basePageOptions,
          onStage: makeStageHandler(link),
        }));
        pagesDone += 1;
        onProgress({ type: 'page', role: 'sublink', url: link, count: subResults.length });

        if (recursive) {
          const remaining = Math.max(maxTotalPages - 1 - subResults.length - queue.length, 0);
          const more = await extractSameDomainLinks(subPage, link, visited, remaining);
          truncated = truncated || more.hasMore;
          queue.push(...more.links);
          estimatedTotalPages = Math.min(maxTotalPages, pagesDone + queue.length + 1);
        }
      } catch (err) {
        if (job && job.abortController.signal.aborted) break;
        subResults.push({ url: link, error: err.message });
        onProgress({ type: 'error', role: 'sublink', url: link, error: err.message });
      } finally {
        await subPage.close().catch(() => {});
      }
    }

    if (job && job.abortController.signal.aborted) throw stopError();

    onProgress({ type: 'stage', percent: 100, label: 'Done', url: targetUrl });
    return {
      main: toRelative(baseDir, main),
      sublinks: subResults.map((entry) => toRelative(baseDir, entry)),
      truncated: depth !== 'page' && (truncated || queue.length > 0),
    };
  } finally {
    if (job) job.page = null;
    await page.close().catch(() => {});
  }
}

module.exports = { archiveUrl, buildMainDir, buildSublinkDir, formatTimestamp, MAX_SUBLINKS, MAX_RECURSIVE_PAGES };
