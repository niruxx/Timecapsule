# TimeCapsule

![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-informational)

**A self-hosted, open-source alternative to Archive.org and ArchiveBox.** Paste a URL into the address bar and TimeCapsule renders it in headless Chrome, then saves a real, self-contained HTML snapshot, a PDF, and a thumbnail — all on your own disk, under your own control.

The UI is a Google Photos-style timeline: every snapshot you've ever taken, grouped by day, in one scrollable grid — click any thumbnail to open it full-screen.

> **Built with AI assistance.** Most of this codebase — the capture pipeline, the UI, this README — was written with Claude (Anthropic's AI coding assistant) working alongside a human who directed the design, tested every feature against a real running server, and decided what shipped. If you're reading the source: expect the usual shape of AI-assisted code (consistent patterns, thorough comments explaining *why*, occasional over-explaining) rather than a hand-crafted, decade-old style. It's been exercised in practice, not just written and forgotten, but review it yourself before trusting it with anything sensitive, same as you would any other self-hosted tool.

## Why AI-assisted development

Features like the bot-check hand-off, Wayback link auto-import, and cancellable background jobs with live progress aren't things ArchiveBox or a `wget --mirror` script does. AI assistance is what made building this specific, non-standard feature set practical for a one-person project.

## Screenshots

<table>
<tr>
<td width="50%"><img src="docs/screenshots/timeline-light.png" alt="Timeline in light mode"></td>
<td width="50%"><img src="docs/screenshots/timeline-dark.png" alt="Timeline in dark mode"></td>
</tr>
<tr>
<td align="center"><sub><b>Timeline</b> — light mode</sub></td>
<td align="center"><sub><b>Timeline</b> — dark mode, with the animated aurora background</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/library.png" alt="Library grid of every archived site"></td>
<td width="50%"><img src="docs/screenshots/calendar.png" alt="Per-site calendar of archive dates"></td>
</tr>
<tr>
<td align="center"><sub><b>Library</b> — every archived site, thumbnail-first</sub></td>
<td align="center"><sub><b>Calendar</b> — every date a site was archived, Wayback-Machine-style</sub></td>
</tr>
</table>

<img src="docs/screenshots/viewer.png" alt="Full-screen snapshot viewer" width="100%">
<p align="center"><sub><b>Viewer</b> — open any snapshot full-screen, with Open HTML / Open PDF / Delete right there</sub></p>

## Contents

- [Why AI-assisted development](#why-ai-assisted-development)
- [Screenshots](#screenshots)
- [Features](#features)
- [Roadmap](#roadmap)
- [Installing](#installing)
- [Running on a Workstation](#running-on-a-workstation)
- [Managing the Service](#managing-the-service)
- [Hosting as a Server](#hosting-as-a-server)
- [How It Works](#how-it-works)
  - [How pages are captured](#how-pages-are-captured)
  - [Archive depth](#archive-depth)
  - [Advanced archive options](#advanced-archive-options)
  - [Progress, cancelling, and human verification](#progress-cancelling-and-human-verification)
  - [Importing from the Wayback Machine](#importing-from-the-wayback-machine)
  - [AI summaries & tags](#ai-summaries--tags)
  - [Change detection](#change-detection)
  - [Directory layout](#directory-layout)
  - [Export and import](#export-and-import)
  - [Concurrency](#concurrency)
  - [Dark mode](#dark-mode)
  - [Logging](#logging)
- [Configuration reference](#configuration-reference)
- [Requirements](#requirements)

## Features

| Feature | What it does |
|---|---|
| **Archive** | Paste a URL, get back a self-contained single-file HTML snapshot (`page.html`, every stylesheet/image/font inlined as `data:` URIs) + a full-page vector PDF + a thumbnail, saved to disk. |
| **WARC capture** | Every archive also saves `page.warc.gz` — a real [WARC/1.1](https://iipc.github.io/warc-specifications/) file built from the actual HTTP request/response pairs Chromium made while loading the page, parseable by warcio/pywb/ReplayWeb.page. Capped at the same per-resource size limit as the HTML inlining, so very large resources appear as headers without a full replayable body — see [How pages are captured](#how-pages-are-captured). |
| **Custom User-Agent, extra wait, cookie import & save toggles** | "Advanced options" under the address bar lets you override the browser's User-Agent, add extra time after the page loads (for slow JS-heavy sites), import cookies (Netscape `cookies.txt` or JSON) so paywalled or logged-in pages archive as you'd actually see them, and toggle whether images get saved into the archive (vs. linked back to the original) and whether video/audio download runs at all. |
| **Live progress & cancel** | Archiving runs as a background job with a small circular progress indicator (bottom-right) showing which capture stage is running, plus a Stop button next to Archive that hard-cancels the job and deletes whatever partial files it had already written. |
| **Human verification hand-off** | If a site throws up a bot-check (Cloudflare, hCaptcha, reCAPTCHA, Turnstile) while archiving, TimeCapsule opens a second, visible browser window on your desktop so you can solve it yourself — once cleared, the resulting session cookies are copied back into the headless capture and archiving continues automatically. |
| **Media extractor** | Downloads any video/audio TimeCapsule can find on the page (native `<video>`/`<audio>`, or a YouTube/Vimeo embed) via a lazily-downloaded [yt-dlp](https://github.com/yt-dlp/yt-dlp) binary, saved under `media/` in the archive folder. Best-effort — unsupported sites, oversized files, or pages with no media are silently skipped rather than failing the archive. Can be hard-disabled instance-wide via `ENABLE_MEDIA_DOWNLOADS` in `config.js`. |
| **Full-page screenshot** | A separate `screenshot.png` capturing the *entire* rendered page top to bottom (not just the viewport-sized thumbnail used in the grids) — for citations, visual records, or just seeing the whole page at a glance without opening the HTML. Shown as an "Open Screenshot" button wherever a snapshot appears. |
| **Clean article extraction** | Every archive also runs [Readability.js](https://github.com/mozilla/readability) against the page and, when it looks like an article, saves a clean Markdown (`article.md`) and plain-text (`article.txt`) copy alongside it — byline, excerpt, and title included — with ads, nav, and cookie banners stripped out. Shows up as an "Open Article" button next to Open HTML / Open PDF wherever a snapshot appears. |
| **Timeline** | Every snapshot you've ever taken, newest first, grouped into "Today" / "Yesterday" / dated sections — just like Google Photos. Click a thumbnail to open it full-screen in a lightbox, with Open HTML / Open PDF / Delete right there. |
| **Archive depth** | Choose how wide each archive run goes: just this page, this page plus its outbound links (the default), or a full recursive crawl of the whole site (warns you first — it's much heavier). See [Archive depth](#archive-depth). |
| **Full-text search** | Search reaches inside every archived page's actual content, not just its URL — an embedded [SQLite FTS5](https://www.sqlite.org/fts5.html) index (`data/search.db`, self-healing: rebuilt for anything missing from it on startup) is checked alongside the existing URL/domain matching, with a highlighted snippet shown for content-only matches. If the native SQLite binding can't load on your platform, search silently falls back to URL/domain-only rather than breaking. |
| **AI summaries & tags** *(optional)* | When `ANTHROPIC_API_KEY` is set, every article-like archive gets a 2–3 sentence summary, a handful of topical tags, and named entities via the Claude API, shown right in the viewer. Off by default (it's the one feature that adds real per-archive latency) — nothing changes until you set the env var. See [AI summaries & tags](#ai-summaries--tags). |
| **Tags (Smart Collections)** | Browse every archive by AI-generated tag from a "Tags" button in the top bar (only appears once at least one archive has a tag). Click a tag to see every snapshot carrying it, across every site. |
| **URL canonicalization & dedup** | Incoming URLs are normalized (tracking params like `utm_*`/`fbclid` stripped, host lowercased, trailing slash and fragment removed) before archiving, so the same article reached through different tracking links is recognized as the same page. A plain, unconfigured re-request for a URL archived in the last 5 minutes reuses that snapshot instead of re-capturing — an explicit User-Agent, extra wait, or cookies always forces a fresh capture, though. |
| **Change detection & text diffs** | Re-archiving a URL you've saved before compares its new article text against the last time, flagging "changed" with a line-level +/− count and a "View Changes" button in the viewer that opens a real word-level diff (insertions/deletions highlighted). Only compares article-like main pages, not incidental sub-links. |
| **Library** | A thumbnail grid of every archived site; click through to a Wayback-Machine-style calendar of every date it was archived. Delete a single day's snapshots from the calendar, or an entire site's history from the grid. |
| **Export / Import** | Back up everything to a single `.zip` and restore it later — including onto a different OS. |
| **Wayback Machine import** | Look up a URL's existing snapshots on web.archive.org (via the CDX API) and import one directly - it goes through the exact same capture pipeline as a live archive (PDF, screenshot, WARC, article extraction) via a real browser render of the fetched HTML, and is filed under the date it was *actually* captured on the web, not today. Pasting a `web.archive.org/web/...` link straight into the main Archive bar is also recognized and routed the same way. See [Importing from the Wayback Machine](#importing-from-the-wayback-machine). |
| **Concurrent archiving** | More than one archive/import job can run its Puppeteer work at once (capped at `MAX_CONCURRENT_ARCHIVES` in `config.js`, default 2) - extra requests queue and start automatically as a slot frees, rather than blocking or getting rejected. Media downloads within a page's media pass run concurrently too (`MAX_CONCURRENT_MEDIA_DOWNLOADS`). |
| **Dark mode** | Follows your system theme by default; toggle it manually from the top bar. The animated background changes mood with it — soft pastels in light mode, a glowing aurora in dark mode. |
| **Logging** | Prints progress to the terminal as pages are archived, and appends every archive request (URL + requester IP) to `traffic.log`. |

## Roadmap

Planned improvements — not yet implemented, listed here to track direction. (WARC capture and cookie/User-Agent handling used to be listed here too; both now ship — see the Features table above. WACZ packaging and stealth-plugin anti-bot evasion are deliberately not included: WACZ is just a zipped WARC + index, low-value to add on its own, and stealth plugins are a maintenance-heavy arms race that doesn't fit a simple self-hosted tool well.)

**Search, organization & management:**

Full-text search, AI summaries/tags, tag-based browsing, URL canonicalization/dedup, and text-based change detection all now ship — see the Features table above. What's left from this section:

- **OCR search over images** — extract text baked into images (screenshots-of-text, scanned documents, memes) via Tesseract, so a search can match text that never existed anywhere in the DOM. Deliberately not implemented yet: OCR takes real per-image time (seconds, not milliseconds), and running it synchronously in the current one-shot archive flow would make every archive noticeably slower even when nothing in the works. This is a much better fit once the resource-throttled worker queue below exists, so OCR can run as a background job after the archive itself has already completed.
- **Folder-based organization** — the shipped Smart Collections covers tag-based browsing; grouping by folder or by domain-matching rule is still just tags-only for now.
- **Side-by-side visual diffs** — the shipped change detection is text-only (word-level, via the `diff` package); comparing two snapshots' *screenshots* pixel-by-pixel is still open, and is really the same underlying feature as the "side-by-side visual diff viewer" listed under UI below.

**System architecture & storage:**

- **Resource-throttled workers** — a concurrency cap now ships (see Features above: `MAX_CONCURRENT_ARCHIVES` in `config.js`), which covers "don't run unbounded jobs at once." Still open: a real queue-based worker architecture (e.g. Redis + Celery, or Go workers) with actual CPU/RAM throttling rather than just a job count limit, for genuinely resource-constrained hardware like a Raspberry Pi.
- **Storage provider flexibility** — save archived data to local disk, S3-compatible object storage (MinIO, Cloudflare R2, AWS S3), or SMB/NFS network shares, instead of only the local filesystem.
- **Public archive mirroring (optional)** — a toggle to auto-submit pages to external public archives (Internet Archive's Save Page Now, Archive.today) as an extra backup layer.
- **Multi-user access control** — role-based permissions allowing public read-only collections while restricting who can trigger archives or change administrative settings.

**UI:**

- **Interactive timeline calendar** — map captures onto a GitHub-style activity heatmap or calendar view, with dots or color codes for HTTP status or whether the content changed that day.
- **Side-by-side visual diff viewer** — pick two capture dates for a single URL and view a split-screen or sliding-curtain diff, highlighting DOM changes or visual pixel shifts.
- **Format switcher replay bar** — a top navigation banner on replayed pages for toggling instantly between execution modes: WARC Replay | SingleFile HTML | PDF | Reader View | Screenshot.

**Dashboard & operational UI:**

- **Live job queue & worker monitor** — per-job progress and a cancel button now ship (see Features above) for the single archive you just kicked off; still open is a dashboard view across *multiple concurrent* jobs — a queue list, CPU/RAM utilization per job, and retry.
- **Quick-add command palette (Cmd+K)** — a global modal, accessible anywhere in the app, to quickly submit URLs, assign tags, or jump directly to archived domains.
- **Storage breakdowns & cleanup tools** — a pie chart breaking down disk usage by format (WARCs vs. screenshots vs. video files), paired with a "prune rules" interface (e.g. delete screenshots older than 90 days for specific domains).
- **Broken asset & link checker** — a sub-view highlighting archived pages that failed to fetch sub-resources (missing CSS/fonts, blocked scripts), with options to re-fetch individual assets.

## Installing

**Prerequisites:** [Node.js](https://nodejs.org/) 18 or newer. On Linux you'll also need a handful of Chromium system libraries — see [Requirements](#requirements).

```
git clone <this-repository-url>
cd TimeCapsule
npm install
```

The first install downloads a bundled Chromium via Puppeteer's postinstall script. If your environment blocks install scripts (e.g. npm's `allow-scripts` guard, or a locked-down CI runner), approve it first, then install again:

```
npm approve-scripts puppeteer
npm install
```

## Running on a Workstation

For personal, local-only use — nothing else needs to reach it:

```
npm start
```

Open `http://localhost:3000`, archive some pages, and press `Ctrl+C` in the terminal when you're done. That's the whole workflow: no background service, no database, just this one process while you're using it. Archived files land in `archived/` right next to the project.

Use a different port if 3000 is taken:

```
PORT=8080 npm start
```

## Managing the Service

This section is for running TimeCapsule continuously — e.g. always-on on a home server or NAS — as opposed to starting it only when you want to use it.

**Starting / stopping / restarting**, using [pm2](https://pm2.keymetrics.io/) as a process manager:

```
npm install -g pm2
pm2 start server.js --name timecapsule   # start
pm2 stop timecapsule                     # stop
pm2 restart timecapsule                  # restart
pm2 logs timecapsule                     # tail logs
```

Running it as a systemd service instead is covered under [Hosting as a Server](#hosting-as-a-server) — that also makes it survive a reboot.

**Updating to a new version:**

```
git pull
npm install
pm2 restart timecapsule   # or just re-run `npm start` if you run it in the foreground
```

`npm install` re-checks Puppeteer's bundled Chromium and only re-downloads it if the required version changed.

**Backing up:** everything TimeCapsule knows lives under `archived/`. Click Export in the top bar (or hit `GET /api/export`) to download it as a single `.zip` — see [Export and import](#export-and-import) for the full picture, including moving to a different OS entirely.

**Changing the port:** set the `PORT` environment variable before starting. With pm2, set it on the first launch (`PORT=8080 pm2 start server.js --name timecapsule`) — pm2 remembers the environment from that run.

## Hosting as a Server

TimeCapsule is a plain Node/Express process — any host that can run a long-lived Node service works, from a spare machine at home to a small VPS. This walks through setting it up on a **dedicated server that stays on 24/7**, so it just keeps archiving whenever you need it without you having to start it by hand.

1. **Get the code onto the server** and run `npm install` there (Chromium is downloaded per-platform, so don't just copy `node_modules/` from a different OS).
2. **Keep it running** with pm2 (see [Managing the Service](#managing-the-service)) and make it survive reboots:
   ```
   pm2 save
   pm2 startup   # wires pm2 into your OS's boot process
   ```
   Or use a systemd unit instead:
   ```ini
   # /etc/systemd/system/timecapsule.service
   [Unit]
   Description=TimeCapsule
   After=network.target

   [Service]
   WorkingDirectory=/opt/timecapsule
   ExecStart=/usr/bin/node server.js
   Environment=PORT=3000
   Restart=on-failure
   User=timecapsule

   [Install]
   WantedBy=multi-user.target
   ```
   Then `sudo systemctl enable --now timecapsule`.
3. **Put a reverse proxy in front of it** (nginx, Caddy, etc.) to handle TLS and your domain name, proxying to `http://127.0.0.1:3000`. Caddy example:
   ```
   archive.yourdomain.com {
     reverse_proxy 127.0.0.1:3000
   }
   ```
   If you plan to use [recursive archiving](#recursive-archiving) on larger sites, raise your proxy's read/response timeout (e.g. nginx's `proxy_read_timeout`) — the request to `/api/archive` doesn't return until the whole crawl finishes, and a big one can take a while.
4. **Persist the `archived/` directory.** It holds every saved archive, so back it up like you would a database and, if you containerize the app, mount it as a volume rather than baking it into the image.
5. **Access control.** TimeCapsule has no authentication of its own — anything reachable can trigger an archive and browse `archived/`. If exposing it beyond your local network, put it behind your reverse proxy's auth (e.g. Caddy's `basic_auth`, an nginx `auth_basic` block, or a VPN/tailnet) rather than the open internet.

### Docker (optional)

If you prefer a container, Puppeteer's official base image already includes Chromium and its dependencies:

```dockerfile
FROM ghcr.io/puppeteer/puppeteer:22.15.0
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
```

Mount `archived/` as a volume so archives survive container restarts:

```
docker build -t timecapsule .
docker run -d -p 3000:3000 -v $(pwd)/archived:/app/archived --name timecapsule timecapsule
```

### Keeping it healthy long-term

A couple of things are worth checking in on periodically once TimeCapsule has been running unattended for a while, since neither grows on its own until you notice — they just quietly get bigger:

- **`archived/` grows without limit.** Every archive adds an HTML file, a PDF, and a thumbnail, and [recursive archiving](#recursive-archiving) multiplies that by up to 100 pages per run. Keep an eye on free disk space (`df -h` on Linux) and prune old sites you don't need from the [Library](#features) view, or export and move them elsewhere with [Export and import](#export-and-import).
- **`traffic.log` grows without limit too**, one line per archive request forever. On Linux, hand it to `logrotate` rather than letting it grow unbounded:
  ```
  # /etc/logrotate.d/timecapsule
  /opt/timecapsule/traffic.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
  }
  ```
- **Crash recovery is already handled** by the setup above — pm2 restarts a crashed process automatically, and the systemd unit's `Restart=on-failure` does the same — so there's nothing extra to configure there, just something worth knowing is already covered.

## How It Works

### How pages are captured

Getting a faithful, self-contained snapshot from a live page takes more than one `page.content()` call, so `lib/archiver.js` does the following for every URL it archives:

1. Loads the page and waits for the network to go idle, recording every HTTP request/response pair Chromium makes along the way (used for step 9's WARC file) - with a custom User-Agent and imported cookies already applied, if you set either under [Advanced archive options](#advanced-archive-options). If the page comes back as a bot-check (Cloudflare, hCaptcha, reCAPTCHA, Turnstile) instead of real content, a second, visible browser window opens on your desktop so you can solve it yourself - the resulting cookies are copied back into the capture and it re-navigates automatically. Only checked for the main URL you typed, not sub-links, since the resolved session cookies carry over to them anyway.
2. **Scrolls through the full page and waits again** (longer, if you set an extra wait under Advanced archive options). Lots of sites only fetch images (or trigger other lazy-loaded content) once an element scrolls into view; without this step those images are missing from both the PDF and the saved HTML.
3. **Runs [Readability.js](https://github.com/mozilla/readability) against a cloned copy of the DOM** and, if the page looks like an article (enough extracted text to be worth it), saves the result as `article.md` and `article.txt` — title, byline, and excerpt included, ads/nav/cookie-banners stripped out. Non-article pages (home pages, search results, etc.) simply don't get these files.
4. Captures the PDF, a small viewport thumbnail for the UI grids, and a separate full-page `screenshot.png` from that fully-loaded state (the full-page capture is skipped, rather than failing the whole archive, if the page is too tall for Chromium's screenshot buffer).
5. **Inlines every stylesheet, image, and font it saw load as a `data:` URI directly into the HTML**, and rewrites any it couldn't capture (too large, blocked, etc.) to an absolute URL instead of a relative one. This is what makes `page.html` open correctly on its own, later, on another machine, with no dependency on the original site still being up or reachable at the same relative paths. Images specifically can be excluded from this via the "Save images" toggle under [Advanced archive options](#advanced-archive-options) - stylesheets and fonts always inline, since skipping those would break the page's layout entirely.
6. **Strips `<script>` tags** from the saved HTML. The DOM has already been fully rendered by that point, so scripts add no visual value in a static snapshot — keeping them would only risk them re-executing against a site that's since changed or gone offline (broken widgets, tracking pings, JS errors).
7. Rewrites `<a href>` links to absolute URLs so they still work (by going back to the live site) when you open an archived page later.
8. **Looks for video/audio worth pulling down** — native `<video>`/`<audio>` sources, or a YouTube/Vimeo embed — and hands anything it finds to [yt-dlp](https://github.com/yt-dlp/yt-dlp), saving whatever comes back under `media/`. Off by default; enable the "Download video/audio" toggle under [Advanced archive options](#advanced-archive-options) to turn it on for a given archive run. Same best-effort spirit as the rest of this list: unsupported sites, no media present, oversized files, or a slow/failed download just mean no `media/` folder, not a failed archive.
9. **Builds `page.warc.gz`** (`lib/warc.js`) from the transactions recorded in step 1 - a `warcinfo` record plus a `response`/`request` record pair per HTTP transaction, gzip-compressed per the WARC spec. Transactions over the same size cap as step 5's inlining (`MAX_INLINE_BYTES`, 8MB) are left out of the WARC entirely, the same as they're left out of the inlined HTML.
10. **Summarizes and tags the article text** via the Claude API - see [AI summaries & tags](#ai-summaries--tags) - only for article-like pages, and only when `ANTHROPIC_API_KEY` is set.
11. **Compares the article text against the last archive of this same URL**, if there is one - see [Change detection](#change-detection) - only for the main URL you typed, not sub-links.

Known limitation: assets loaded from Chromium's disk cache (rather than over the network) can occasionally fail to inline; when that happens the archiver falls back to an absolute URL for that one asset rather than failing the whole capture.

### Archive depth

The "How much to archive" control under the address bar picks one of three depths, sent to `POST /api/archive` as `depth`:

| Depth | What it archives |
|---|---|
| **Just this page** (`page`) | Only the URL you typed. No sub-links at all. |
| **This page + its links** (`links`, the default) | The URL you typed, plus the same-domain links found directly on it, up to `MAX_SUBLINKS` (15). |
| **Entire site** (`recursive`) | Follows same-domain links breadth-first — pages found on those sub-pages get crawled too, and so on — until either there's nothing left to follow or it hits the `MAX_RECURSIVE_PAGES` safety cap (100 pages, including the main one). |

Sub-links found at any depth land in the same place: `archived/<domain>/<timestamp>/sub-links/<path>/<timestamp>/`. Whenever a page had more matching links than the depth's cap allowed, the response (and the completion toast) say so as `truncated: true`, rather than silently archiving only part of what was there.

The UI shows an extra warning before you pick **Entire site**, since a full-site crawl is dramatically heavier than the other two depths: many more pages means many more HTML/PDF/thumbnail files (a lot more disk space) and a much longer archive run, since every page still gets the full capture treatment (scroll, wait, extract article, inline assets, PDF, screenshots) one at a time.

### Advanced archive options

The "Advanced options" disclosure under the depth control (and the matching fields on `POST /api/archive`) cover the cases a plain `fetch()` can't handle - a paywall, a login wall, or a site that's slow to render:

| Option | Request field | What it does |
|---|---|---|
| Custom User-Agent | `userAgent` (string, ≤300 chars) | Overrides Chromium's default User-Agent string for every request the archive makes - useful for sites that serve different content (or block) based on it. |
| Extra wait | `extraWaitMs` (number, 0–30000) | Adds to how long TimeCapsule waits for the network to go idle after scrolling, for slow, JS-heavy pages that need more than the default `LAZY_LOAD_WAIT_MS` (8s) to finish rendering. |
| Cookie import | `cookiesText` (string) | Applies cookies to every page in the archive run before it navigates, so pages behind a login or paywall archive as your session actually sees them. Accepts a Netscape `cookies.txt` export (what most "export cookies" browser extensions produce) or a JSON array of `{name, value, domain, ...}` objects. |
| Save images | `saveImages` (boolean, default `true`) | When off, images are left as links back to the original site instead of being inlined as `data:` URIs - a smaller archive, at the cost of those images disappearing if the source site ever goes offline. |
| Download video/audio | `saveMedia` (boolean, default `false`) | Turns on the yt-dlp media extractor (step 8 above) for this archive run. Off by default since it's the slowest optional step. |

All five are entirely optional and apply to every page in the run (the main URL and every sub-link), not just the first one. A malformed cookies file is rejected up front with a 400 before any browser work starts; an individual cookie missing both `domain` and `url` is skipped rather than failing the whole archive.

### Progress, cancelling, and human verification

`POST /api/archive` returns immediately with `{ jobId }` rather than blocking until the whole archive finishes - the actual capture runs in the background (`lib/jobs.js` tracks it), and the UI subscribes to `GET /api/archive/:jobId/events` (Server-Sent Events) to drive the circular progress indicator in the bottom-right corner. `POST /api/archive/:jobId/stop` hard-cancels a running job: it closes whatever browser page (or human-verification window) is currently in flight, which aborts Chromium/yt-dlp mid-operation, then deletes the partial archive directory that job had already written to disk.

If a site's bot-check trips during the main page's capture, the job's status becomes `awaiting-verification` and a second, visible Chrome window opens - solve the check there and archiving picks back up on its own (see step 1 above). This only does anything useful because TimeCapsule runs on your own desktop with a real display; it's a no-op on a truly headless server.

More than one archive/import job can be running at once - see [Concurrency](#concurrency) below for the cap and how to change it.

### Importing from the Wayback Machine

The clock-arrow icon in the top bar opens an "Import from Wayback Machine" dialog: paste a URL, and `GET /api/wayback/snapshots?url=` (`lib/wayback.js`) queries the Internet Archive's [CDX API](https://archive.org/help/wayback_api.php) for every distinct HTML snapshot it has of that URL (deduped by content digest, newest first). Pick one and `POST /api/wayback/import` fetches that exact snapshot's raw HTML (the documented `id_` modifier - no Wayback toolbar or link-rewriting mixed in) and runs it through the same background-job machinery as a live archive, described above.

Pasting a link copied straight out of the Wayback Machine itself (`web.archive.org/web/<timestamp>/<url>`) into the main **Archive** bar works too - `POST /api/archive` recognizes that shape before it does anything else, pulls out the original URL and timestamp, and routes the request into the same import path instead of dutifully archiving Wayback's own replay page. Depth/User-Agent/cookies/save-toggles on the request are ignored in that case, since there's only ever one page to import; a toast confirms what happened ("Recognized a Wayback Machine link…") since otherwise it'd look like a plain archive.

The archive bar itself gives an earlier hint too: as soon as its text matches that same shape, a glowing rainbow outline animates around it - purely a client-side cue (the same pattern check as the server's, just for show), so it fades away the instant you edit the URL into something else or hit Archive.

The import doesn't just save the bare HTML: it hands that HTML to `page.setContent()` in a real Puppeteer page (with a `<base>` tag injected so relative URLs resolve against the *original* site) and lets the normal capture pipeline take it from there - PDF, screenshot, WARC, image inlining, Readability article extraction, and AI summaries/tags (if configured) all happen exactly as they would for a live capture. The one thing that's skipped is change detection, since comparing an old imported snapshot against whatever you happen to have archived most recently doesn't mean anything.

Two things worth knowing:

- **Embedded images/CSS are fetched live**, from the original site as it exists today, not from the Wayback Machine - only the page's own HTML is guaranteed to match the historical capture. If the original site is gone, those assets just won't inline, the same graceful degradation as any archive with dead sub-resources.
- **The archive's date reflects the snapshot**, not the day you imported it - it's filed under `archived/<domain>/<the-snapshot's-own-timestamp>/`, so it shows up in the right place in your timeline/library, alongside anything you archived yourself around that date.

### AI summaries & tags

Set the `ANTHROPIC_API_KEY` environment variable before starting TimeCapsule and every article-like archive (the same ones that get `article.md`/`article.txt` - see step 3 below) also gets a 2-3 sentence summary, 3-8 topical tags, and any named people/organizations/places, via the [Claude API](https://claude.com/platform/api) (`claude-opus-5`, `lib/ai-enrich.js`). This is the one optional feature that adds real per-archive latency (an API round trip), so unlike everything else in this list it's off unless you explicitly opt in by setting the key - nothing about a normal archive changes until you do.

Once at least one archive has a tag, a **Tags** button appears in the top bar - it opens a tag cloud (every tag in use, with a count), and clicking a tag lists every archive that carries it, across every site. This is also what the roadmap called "Smart Collections": browsing by tag rather than by domain/date like the Library view does.

If the API call fails for any reason (rate limit, network error, no credit) the archive still completes normally, just without a summary/tags for that one page.

### Change detection

Re-archiving a URL you've already saved compares the new capture's article text against the most recent *previous* archive of that same URL (any age - not the 5-minute dedup window above) and stores how many lines were added/removed. Scoped to the URL you actually typed, not incidental sub-links swept up along the way, and only when both captures look like articles.

When something changed, the viewer shows a small banner (`+N / -M lines`) with a **View Changes** button - it opens a word-level diff (`GET /api/diff?from=<dir>&to=<dir>`, built with the [`diff`](https://github.com/kpdecker/jsdiff) package) with insertions and deletions highlighted. This is a text diff, not a pixel/visual one - comparing two snapshots' screenshots image-by-image is a separate, still-unbuilt roadmap item ("side-by-side visual diff viewer").

### Directory layout

```
archived/
  example.com/
    2026-07-25_21-35-56/            <- the URL you typed (https://example.com/blog/post)
      page.html
      page.pdf
      page.warc.gz                  <- the same page as a WARC/1.1 file
      thumbnail.jpg
      screenshot.png                <- full-page capture, separate from the small thumbnail above
      article.md                    <- only present when the page looked like an article
      article.txt
      media/                        <- only present when video/audio was found and downloaded
        my-video-title-abc123.mp4
      metadata.json
      sub-links/
        blog/
          post-1/
            2026-07-25_21-36-10/    <- https://example.com/blog/post-1, found on that page
              page.html
              page.pdf
              thumbnail.jpg
              metadata.json
```

- The URL you type always becomes `archived/<domain>/<timestamp>/`, whether or not it has a path.
- Same-domain links discovered on that page are archived inside that same folder, under `sub-links/<path>/<timestamp>/` (see [Archive depth](#archive-depth) for how many).
- The timeline, Library, and calendar views are all derived purely by walking this directory tree (`lib/history.js`) — `archived/` alone is a complete, self-describing copy of everything TimeCapsule knows, no database required to make sense of it.
- The one exception is full-text search: `data/search.db` (a SQLite file, outside `archived/` on purpose - see [Export and import](#export-and-import)) indexes each page's text so search can look inside content, not just URLs. It's disposable - delete it and TimeCapsule rebuilds it from `archived/` the next time it starts.

### Export and import

Everything TimeCapsule knows is just files under `archived/` — folder and file names use only plain ASCII, so the archive tree itself is already portable across Windows/macOS/Linux. Export/Import just wraps that in a single file for convenience:

- **Export** (top bar, or `GET /api/export`) downloads a `.zip` of the entire `archived/` directory.
- **Import** (top bar, or `POST /api/import` with the zip as a `multipart/form-data` field named `archive`) extracts that zip into `archived/` on whatever machine you run it on. Existing archives already on that machine are kept — importing merges rather than replaces, so it's also safe to combine two machines' archives into one.

To move to a different OS: click Export on the old machine, copy the `.zip` over by whatever means (USB drive, cloud storage, `scp`, etc.), [install](#installing) TimeCapsule on the new machine, start it, and click Import. `data/search.db` deliberately isn't part of the export - it's just an index, not a source of truth, and TimeCapsule backfills it for any imported archive it doesn't recognize the next time it starts (see [Directory layout](#directory-layout)).

### Concurrency

By default, up to `MAX_CONCURRENT_ARCHIVES` (2) archive/import jobs run their actual browser work at the same time - a third request kicked off while both slots are busy shows as "Queued" in its progress indicator and starts automatically the moment a slot frees, rather than blocking your request or being rejected. This is a fixed job-count cap, not a real resource scheduler (no CPU/RAM awareness) - see the [Roadmap](#roadmap) for the fuller worker-queue version.

This, and everything else in `config.js`, is deliberately a server file rather than a website setting - restart required to change it - since these are all operator decisions (what this machine's hardware can handle, how the homepage looks for everyone hitting it), not something to expose as a per-visitor control:

```js
// config.js
module.exports = {
  MAX_CONCURRENT_ARCHIVES: 2,          // simultaneous archive/import jobs
  MAX_CONCURRENT_MEDIA_DOWNLOADS: 2,   // simultaneous yt-dlp downloads within one page's media pass
  SHOW_TIMELINE_FEED: true,            // show the "Today"/"Yesterday" feed on the homepage
  ENABLE_ANIMATED_BACKGROUND: true,    // the drifting colored blobs behind the homepage
  ENABLE_MEDIA_DOWNLOADS: true,        // master switch for the yt-dlp backend
};
```

Lower `MAX_CONCURRENT_ARCHIVES` on something like a Raspberry Pi (each job is a real headless-Chromium page load); raise it on a beefier machine. Set `SHOW_TIMELINE_FEED: false` if you'd rather the homepage was just the archive bar - everything's still reachable from Library either way, this only hides the inline feed. Set `ENABLE_ANIMATED_BACKGROUND: false` for a plain, static theme background instead of the drifting blobs - purely cosmetic. Set `ENABLE_MEDIA_DOWNLOADS: false` to hard-disable the yt-dlp backend: `lib/media.js` returns immediately without ever downloading the yt-dlp binary or spawning it, even if a request explicitly asks for media, and the "Download video/audio" advanced option is disabled in the UI to match - useful on a locked-down or bandwidth-constrained host.

### Dark mode

TimeCapsule follows your system's light/dark preference (`prefers-color-scheme`) the first time you open it. Use the 🌙/☀️ toggle in the top-right of the app bar to override that — your choice is remembered in the browser (`localStorage`) and takes precedence over the system setting from then on, independently per browser/device.

### Logging

While it's running, TimeCapsule prints one line per event to the terminal, each timestamped:

```
[2026-07-26T05:09:50.014Z] Archive requested: https://example.com/ from ::1
[2026-07-26T05:09:51.903Z]   [::1] archived https://example.com/
[2026-07-26T05:09:51.920Z] Archive completed: https://example.com/ (0 sub-link(s)) for ::1
```

For a recursive or many-sub-link archive, every page gets its own `archived <url>` line (or `failed <url>: <reason>` if that one page couldn't be captured) as it happens, so you can watch the crawl's progress in real time rather than waiting on one big response at the end.

Every top-level archive request also appends one line to `traffic.log` in the project root — the website that was requested, followed by the requester's IP:

```
2026-07-26T05:09:50.014Z https://example.com/ 127.0.0.1
2026-07-26T05:10:00.147Z https://www.iana.org/help/example-domains 192.168.1.42
```

(Sub-links discovered and archived along the way show up in the terminal output, not as separate `traffic.log` lines — the log tracks *requests*, one per site a client actually asked for.) The IP is always normalized to IPv4 where possible — Node's dual-stack server reports IPv4 clients as an IPv6-mapped address (`::ffff:1.2.3.4`) or the IPv6 loopback (`::1`), and both get converted back to plain IPv4 before logging. If TimeCapsule is behind a reverse proxy, the IP recorded is taken from the `X-Forwarded-For` header when present (which nginx and Caddy set by default), falling back to the direct connection's address otherwise.

All of this — what gets printed, what gets written to `traffic.log`, and in what format — is controlled from one place: `lib/logger.js`. Edit `log()` or `logTraffic()` there to change it (e.g. write JSON lines instead, log to a different file, or add fields).

## Configuration reference

| Setting | Default | Where | Purpose |
|---|---|---|---|
| `PORT` (env var) | `3000` | shell environment | Port the server listens on |
| `ANTHROPIC_API_KEY` (env var) | unset | shell environment | Turns on [AI summaries & tags](#ai-summaries--tags). Archiving works identically without it, just without summaries/tags. |
| `MAX_SUBLINKS` | `15` | `lib/archiver.js` | "This page + its links" depth: max links archived from the one page you typed |
| `MAX_RECURSIVE_PAGES` | `100` | `lib/archiver.js` | "Entire site" depth: max total pages crawled per site, including the main page |
| Media items per page | `2` | `lib/media.js` (`MAX_MEDIA_ITEMS`) | Max video/audio files downloaded per archived page |
| Media file size cap | `250M` | `lib/media.js` (`MAX_MEDIA_FILESIZE`) | yt-dlp skips anything larger than this rather than downloading it |
| `MAX_INLINE_BYTES` | `8MB` | `lib/archiver.js` | Max size of a single resource inlined into `page.html` *and* included in `page.warc.gz` |
| Custom User-Agent length cap | `300` chars | `server.js` (`MAX_USER_AGENT_LENGTH`) | Longest `userAgent` value `POST /api/archive` accepts |
| Extra wait cap | `30000` ms | `server.js` (`MAX_EXTRA_WAIT_MS`) | Longest `extraWaitMs` value `POST /api/archive` accepts |
| Cookies text size cap | `200KB` | `server.js` (`MAX_COOKIES_TEXT_LENGTH`) | Largest `cookiesText` payload `POST /api/archive` accepts |
| Dedup window | `5` minutes | `server.js` (`DEDUP_WINDOW_MS`) | How recently a plain, unconfigured re-request for the same URL must have been archived to be served from that snapshot instead of re-captured |
| Human verification timeout | `10` minutes | `lib/archiver.js` (`VERIFY_TIMEOUT_MS`) | How long the visible hand-off browser window waits for you to clear a bot-check before giving up and failing the archive |
| Finished job retention | `10` minutes | `lib/jobs.js` (`JOB_TTL_MS`) | How long a completed/errored/stopped job's status stays queryable via `GET /api/archive/:jobId/events` before it's forgotten |
| `MAX_CONCURRENT_ARCHIVES` | `2` | `config.js` | Archive/import jobs allowed to run their Puppeteer work at once - see [Concurrency](#concurrency) |
| `MAX_CONCURRENT_MEDIA_DOWNLOADS` | `2` | `config.js` | yt-dlp downloads allowed to run at once within a single page's media pass |
| `SHOW_TIMELINE_FEED` | `true` | `config.js` | Whether the "Today"/"Yesterday" recent-snapshots feed shows on the homepage |
| `ENABLE_ANIMATED_BACKGROUND` | `true` | `config.js` | Whether the homepage's drifting background blobs animate |
| `ENABLE_MEDIA_DOWNLOADS` | `true` | `config.js` | Master switch for the yt-dlp backend - `false` hard-disables video/audio download entirely |

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer.
- No Python and nothing else to install for the media extractor: the first time TimeCapsule finds video/audio to download, it fetches a standalone [yt-dlp](https://github.com/yt-dlp/yt-dlp) binary for your OS into `bin/` (like Puppeteer does for Chromium) and reuses it after that. Needs outbound internet access the first time; every archive before that point works normally, just without media downloads.
- Full-text search uses [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3), a native module that ships prebuilt binaries for common platforms via `npm install` - no compiler needed on those. If it can't load on yours (an unusual OS/arch with no prebuilt binary available), TimeCapsule logs a warning and keeps running with URL/domain-only search rather than failing to start.
- On Linux, Chromium (used via Puppeteer) needs a few system libraries. If `npm start` fails to launch the browser, install them, e.g. on Debian/Ubuntu:
  ```
  sudo apt-get install -y ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils
  ```
