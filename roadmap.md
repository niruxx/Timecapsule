# TimeCapsule roadmap

TimeCapsule’s core workflow is to capture a URL, find it again, and open the best saved copy for the task. Work through these phases in order and update the checklists as each item lands.

| Phase | Outcome | Status |
| --- | --- | --- |
| 1. Archive workspace | Capture and browse snapshots from a consistent desktop and mobile interface | Implemented |
| 2. Organization and intake | Organize larger archives and save links in batches | Implemented |
| 3. Replay and comparison | Read, replay, and compare versions from one snapshot workspace | Implemented |
| 4. Capture operations | Manage capture jobs, recurring checks, and storage from the UI | Implemented |
| 5. Hosting and access | Support more storage options and shared instances | Implemented |

## Phase 1 — Archive workspace

- [x] Replace the homepage with a responsive workspace, persistent navigation, and a dedicated URL capture panel.
- [x] Provide a day-grouped timeline with grid and list layouts, site and format filters, and empty and error states.
- [x] Add keyboard access to search and open the exact snapshot from a search result.
- [x] Restyle Library, the per-site calendar, Wayback import, job progress, and the snapshot viewer in both themes.

## Phase 2 — Organization and intake

- [x] Add user-managed tags and collections, with AI tags remaining available as suggestions.
- [x] Add date and tag filters, sorting, and bookmarked searches to the main archive view.
- [x] Support bulk capture from pasted URLs and browser bookmark exports, with a preview and duplicate handling.
- [x] Add bulk tag, move, and export actions with a preview of the affected snapshots.
- [x] Add a browser save bookmarklet and a command palette for adding URLs and navigating the archive.

**Exit criteria.** A user can import a bookmark collection, organize the resulting snapshots without AI enabled, and retrieve them by date, site, or tag.

## Phase 3 — Replay and comparison

- [x] Add a format switcher for HTML, PDF, screenshot, Reader, and offline WARC replay where available.
- [x] Add an archive-wide calendar with capture counts and change indicators.
- [x] Let users choose two captures of the same URL and compare text and screenshots side by side.
- [x] Show available formats and comparable versions on older snapshots, plus failed assets where a report was recorded.

**Exit criteria.** A user can find two versions of a page, inspect their differences, and open available formats without leaving the snapshot workflow.

## Phase 4 — Capture operations

- [x] Build a job dashboard with queued, running, completed, and failed captures, cancellation, retry, and stage details.
- [x] Persist the job queue, configure concurrency and capture time limits, and support optional background screenshot OCR.
- [x] Add scheduled recapture with in-app change notifications and a per-URL history.
- [x] Report storage usage by format, preview retention rules, and report failed assets with a targeted retry option.

**Exit criteria.** A queued capture survives a server restart, and operators can diagnose failures, review changes, and preview cleanup from the dashboard.

## Phase 5 — Hosting and access

- [x] Add S3-compatible checkpoint backups, optional snapshot replication, and SHA-256-verified restore. Document SMB/NFS mounts for the working archive.
- [x] Add user roles for capture, administration, and read-only collection access.
- [x] Add opt-in public Wayback mirroring with a per-collection publishing setting.

**Exit criteria.** An operator can restore a backup onto a supported storage target and verify that read-only accounts can browse their assigned collections.

## Product references

- Bookmark ingestion, capture formats, and archive search. [ArchiveBox](https://archivebox.io/)
- Manual tagging, reader view, and browser capture. [wallabag](https://wallabag.org/) · [Tagging workflow](https://doc.wallabag.org/user/tags/)
- Scheduled checks and screenshot comparison. [changedetection.io](https://github.com/dgtlmoon/changedetection.io/blob/master/README.md)
