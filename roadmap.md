# TimeCapsule roadmap

TimeCapsule’s core workflow is to capture a URL, find it again, and open the best saved copy for the task. Work through these phases in order and update the checklists as each item lands.

| Phase | Outcome | Status |
| --- | --- | --- |
| 1. Archive workspace | Capture and browse snapshots from a consistent desktop and mobile interface | Implemented |
| 2. Organization and intake | Organize larger archives and save links in batches | Planned |
| 3. Replay and comparison | Read, replay, and compare versions from one snapshot workspace | Planned |
| 4. Capture operations | Manage capture jobs, recurring checks, and storage from the UI | Planned |
| 5. Hosting and access | Support more storage options and shared instances | Planned |

## Phase 1 — Archive workspace

- [x] Replace the homepage with a responsive workspace, persistent navigation, and a dedicated URL capture panel.
- [x] Provide a day-grouped timeline with grid and list layouts, site and format filters, and empty and error states.
- [x] Add keyboard access to search and open the exact snapshot from a search result.
- [x] Restyle Library, the per-site calendar, Wayback import, job progress, and the snapshot viewer in both themes.

## Phase 2 — Organization and intake

- [ ] Add user-managed tags and collections, with AI tags remaining available as suggestions.
- [ ] Add date and tag filters, sorting, and bookmarked searches to the main archive view.
- [ ] Support bulk capture from pasted URLs and browser bookmark exports, with a preview and duplicate handling.
- [ ] Add bulk tag, move, and export actions with a preview of the affected snapshots.
- [ ] Add a browser save action and a command palette for adding URLs and navigating the archive.

**Exit criteria.** A user can import a bookmark collection, organize the resulting snapshots without AI enabled, and retrieve them by date, site, or tag.

## Phase 3 — Replay and comparison

- [ ] Add a format switcher for HTML, PDF, screenshot, reader view, and WARC replay where available.
- [ ] Add an archive-wide calendar with capture counts and change indicators.
- [ ] Let users choose two captures of the same URL and compare text and screenshots side by side.
- [ ] Show available formats, missing assets, and comparable versions on older snapshots.

**Exit criteria.** A user can find two versions of a page, inspect their differences, and open available formats without leaving the snapshot workflow.

## Phase 4 — Capture operations

- [ ] Build a job dashboard with queued, running, completed, and failed captures, cancellation, retry, and stage details.
- [ ] Persist the job queue and add resource limits for smaller hosts. Run optional OCR indexing after capture completes.
- [ ] Add scheduled recapture with change notifications and a per-URL history.
- [ ] Report storage usage by format, preview retention rules, and report failed assets with a targeted retry option.

**Exit criteria.** A queued capture survives a server restart, and operators can diagnose failures, review changes, and preview cleanup from the dashboard.

## Phase 5 — Hosting and access

- [ ] Add S3-compatible storage and document SMB/NFS deployments, including backup and restore verification.
- [ ] Add user roles for capture, administration, and read-only collection access.
- [ ] Add opt-in mirroring to external public archives with a per-collection publishing setting.

**Exit criteria.** An operator can restore a backup onto a supported storage target and verify that read-only accounts can browse their assigned collections.

## Product references

- Bookmark ingestion, capture formats, and archive search. [ArchiveBox](https://archivebox.io/)
- Manual tagging, reader view, and browser capture. [wallabag](https://wallabag.org/) · [Tagging workflow](https://doc.wallabag.org/user/tags/)
- Scheduled checks and screenshot comparison. [changedetection.io](https://github.com/dgtlmoon/changedetection.io/blob/master/README.md)
