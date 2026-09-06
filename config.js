// Server-side tuning knobs - deliberately not exposed anywhere in the website UI, since these
// control how much load this machine takes on at once, which is an operator decision (what the
// hardware can handle), not something to expose as a per-archive request option. Edit this file
// and restart the server to change them.
module.exports = {
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
