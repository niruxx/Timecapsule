/* ============================================================
   Elements
   ============================================================ */

const form = document.getElementById('archive-form');
const input = document.getElementById('url-input');
const btn = document.getElementById('archive-btn');
const recursiveCheckbox = document.getElementById('recursive-checkbox');
const recursiveWarning = document.getElementById('recursive-warning');
const appProgress = document.getElementById('app-progress');

const toast = document.getElementById('toast');
const toastIcon = document.getElementById('toast-icon');
const toastText = document.getElementById('toast-text');

const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');
const searchResults = document.getElementById('search-results');

const snapshotsBtn = document.getElementById('snapshots-btn');
const exportBtn = document.getElementById('export-btn');
const importBtn = document.getElementById('import-btn');
const importFile = document.getElementById('import-file');
const themeToggle = document.getElementById('theme-toggle');

const dialogOverlay = document.getElementById('dialog-overlay');
const dialogTitle = document.getElementById('dialog-title');
const dialogBack = document.getElementById('dialog-back');
const dialogClose = document.getElementById('dialog-close');
const dialogBody = document.getElementById('dialog-body');

const timelineEl = document.getElementById('timeline');

const viewer = document.getElementById('viewer');
const viewerImg = document.getElementById('viewer-img');
const viewerUrl = document.getElementById('viewer-url');
const viewerDate = document.getElementById('viewer-date');
const viewerHtml = document.getElementById('viewer-html');
const viewerPdf = document.getElementById('viewer-pdf');
const viewerClose = document.getElementById('viewer-close');
const viewerDelete = document.getElementById('viewer-delete');

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/* ============================================================
   Helpers
   ============================================================ */

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function thumbStyle(thumbnail) {
  return thumbnail ? `background-image: url('/archived/${thumbnail}')` : '';
}

function dayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

// "Today" / "Yesterday" / "Monday, July 20" / "July 20, 2025"
function friendlyDate(date) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (dayKey(date) === dayKey(today)) return 'Today';
  if (dayKey(date) === dayKey(yesterday)) return 'Yesterday';

  const opts = date.getFullYear() === today.getFullYear()
    ? { weekday: 'long', month: 'long', day: 'numeric' }
    : { month: 'long', day: 'numeric', year: 'numeric' };
  return date.toLocaleDateString(undefined, opts);
}

/* Material-style ripple on any button press */
function attachRipple(el) {
  el.addEventListener('pointerdown', (e) => {
    const rect = el.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const span = document.createElement('span');
    span.className = 'ripple';
    span.style.width = span.style.height = `${size}px`;
    span.style.left = `${e.clientX - rect.left - size / 2}px`;
    span.style.top = `${e.clientY - rect.top - size / 2}px`;
    el.appendChild(span);
    setTimeout(() => span.remove(), 600);
  });
}

function wireRipples(root = document) {
  root.querySelectorAll('.btn-filled, .btn-tonal, .icon-pill').forEach((el) => {
    if (el.dataset.rippled) return;
    el.dataset.rippled = '1';
    attachRipple(el);
  });
}

wireRipples();

/* ============================================================
   Theme
   ============================================================ */

const THEME_KEY = 'timecapsule-theme';
const themeIcon = themeToggle.querySelector('.theme-icon');

function syncThemeToggle(theme) {
  themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
  themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
}

syncThemeToggle(document.documentElement.getAttribute('data-theme') || 'light');

themeToggle.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(THEME_KEY, next);

  themeIcon.classList.remove('swap');
  void themeIcon.offsetWidth; // restart the animation
  themeIcon.classList.add('swap');
  setTimeout(() => syncThemeToggle(next), 220);
});

/* ============================================================
   Snackbar
   ============================================================ */

let toastTimer;
function showToast(message, variant = 'success') {
  clearTimeout(toastTimer);
  toastIcon.textContent = variant === 'success' ? '✅' : '⚠️';
  toastText.textContent = message;
  toast.classList.toggle('error', variant === 'error');
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

/* ============================================================
   Timeline — the main Google-Photos-style grid
   ============================================================ */

function skeletonGrid(n = 8) {
  return `<div class="tl-group"><div class="tl-grid">${
    Array.from({ length: n }, () => '<div class="skeleton"></div>').join('')
  }</div></div>`;
}

async function loadTimeline({ skeleton = true } = {}) {
  if (skeleton && !timelineEl.dataset.loaded) timelineEl.innerHTML = skeletonGrid();

  try {
    const res = await fetch('/api/timeline');
    const entries = await res.json();
    if (!res.ok) throw new Error(entries.error || 'Could not load your archive.');

    timelineEl.dataset.loaded = '1';

    if (!entries.length) {
      timelineEl.innerHTML = `
        <div class="tl-empty">
          <div class="tl-empty-art">🗂️</div>
          <div class="tl-empty-title">Nothing archived yet</div>
          <div class="tl-empty-hint">Paste a link above to save your first snapshot.</div>
        </div>`;
      return;
    }

    // Group by calendar day, preserving the newest-first order from the API.
    const groups = [];
    const index = new Map();
    for (const entry of entries) {
      const date = new Date(entry.archivedAt);
      const key = dayKey(date);
      if (!index.has(key)) {
        index.set(key, { label: friendlyDate(date), items: [] });
        groups.push(index.get(key));
      }
      index.get(key).items.push(entry);
    }

    let n = 0;
    timelineEl.innerHTML = groups.map((group) => `
      <section class="tl-group">
        <header class="tl-group-head">
          <h2 class="tl-group-title">${escapeHtml(group.label)}</h2>
          <span class="tl-group-count">${group.items.length} snapshot${group.items.length === 1 ? '' : 's'}</span>
        </header>
        <div class="tl-grid">${group.items.map((entry) => renderTimelineCard(entry, n++)).join('')}</div>
      </section>
    `).join('');

    timelineEl.querySelectorAll('.tl-card').forEach((card) => {
      const entry = entries[Number(card.dataset.index)];
      card.addEventListener('click', () => openViewer(entry));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openViewer(entry); }
      });
    });
  } catch (err) {
    timelineEl.innerHTML = `<div class="tl-empty"><div class="tl-empty-title">${escapeHtml(err.message)}</div></div>`;
  }
}

function renderTimelineCard(entry, i) {
  const time = new Date(entry.archivedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const subs = entry.sublinkCount
    ? `<div class="tl-badge">${entry.sublinkCount} sub-link${entry.sublinkCount === 1 ? '' : 's'}</div>`
    : '';
  // Stagger the entrance, but cap the delay so a large archive still appears promptly.
  const delay = Math.min(i * 35, 700);

  return `
    <div class="tl-card" data-index="${i}" tabindex="0" role="button"
         aria-label="Open snapshot of ${escapeHtml(entry.url)}"
         style="animation-delay:${delay}ms">
      <div class="tl-thumb" style="${thumbStyle(entry.thumbnail)}">${entry.thumbnail ? '' : '🌐'}</div>
      ${subs}
      <div class="tl-veil"></div>
      <div class="tl-info">
        <div class="tl-domain">${escapeHtml(entry.domain)}</div>
        <div class="tl-sub">${escapeHtml(time)}</div>
      </div>
    </div>`;
}

loadTimeline();

/* ============================================================
   Viewer (lightbox)
   ============================================================ */

let viewerEntry = null;

function openViewer(entry) {
  viewerEntry = entry;
  viewerUrl.textContent = entry.url;
  viewerDate.textContent = new Date(entry.archivedAt).toLocaleString();
  viewerImg.src = entry.thumbnail ? `/archived/${entry.thumbnail}` : '';
  viewerImg.alt = `Snapshot of ${entry.url}`;
  viewerHtml.href = `/archived/${entry.dir}/page.html`;
  viewerPdf.href = `/archived/${entry.dir}/page.pdf`;
  viewer.hidden = false;
  document.body.style.overflow = 'hidden';
  viewerClose.focus();
}

function closeViewer() {
  viewer.classList.add('closing');
  setTimeout(() => {
    viewer.classList.remove('closing');
    viewer.hidden = true;
    viewerImg.src = '';
    viewerEntry = null;
    document.body.style.overflow = '';
  }, 200);
}

viewerClose.addEventListener('click', closeViewer);
viewer.addEventListener('click', (e) => {
  if (e.target === viewer || e.target.classList.contains('viewer-stage')) closeViewer();
});

viewerDelete.addEventListener('click', async () => {
  if (!viewerEntry) return;
  const label = new Date(viewerEntry.archivedAt).toLocaleString();
  if (!confirm(`Delete this snapshot of ${viewerEntry.url} from ${label}? This cannot be undone.`)) return;

  try {
    const res = await fetch('/api/archives/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dirs: [viewerEntry.dir] })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || 'Delete failed', 'error'); return; }

    showToast('Snapshot deleted');
    closeViewer();
    loadTimeline({ skeleton: false });
  } catch (err) {
    showToast(err.message || 'Delete failed', 'error');
  }
});

/* ============================================================
   Archive form
   ============================================================ */

recursiveCheckbox.addEventListener('change', () => {
  recursiveWarning.hidden = !recursiveCheckbox.checked;
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = input.value.trim();
  if (!url) return;

  const recursive = recursiveCheckbox.checked;

  btn.disabled = true;
  btn.classList.add('loading');
  appProgress.hidden = false;

  try {
    const res = await fetch('/api/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, recursive })
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Archive failed', 'error');
      return;
    }

    const savedSublinks = data.sublinks.filter((s) => !s.error).length;
    const capNote = data.truncated ? ' — stopped at the page limit' : '';
    showToast(
      savedSublinks
        ? `Archived — ${savedSublinks} sub-link${savedSublinks === 1 ? '' : 's'} saved${capNote}`
        : 'Archive completed'
    );
    input.value = '';
    loadTimeline({ skeleton: false });
  } catch (err) {
    showToast(err.message || 'Archive failed', 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    appProgress.hidden = true;
  }
});

/* ============================================================
   Search
   ============================================================ */

let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  searchClear.hidden = !q;

  if (!q) { searchResults.classList.remove('show'); return; }
  searchTimer = setTimeout(() => runSearch(q), 220);
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.hidden = true;
  searchResults.classList.remove('show');
  searchInput.focus();
});

document.addEventListener('click', (e) => {
  if (!searchResults.contains(e.target) && e.target !== searchInput) {
    searchResults.classList.remove('show');
  }
});

async function runSearch(q) {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    renderSearchResults(await res.json());
  } catch {
    searchResults.innerHTML = '<div class="search-empty">Search failed.</div>';
    searchResults.classList.add('show');
  }
}

function renderSearchResults(results) {
  if (!results.length) {
    searchResults.innerHTML = '<div class="search-empty">No archived links match.</div>';
    searchResults.classList.add('show');
    return;
  }

  searchResults.innerHTML = results.map((entry, i) => `
    <div class="search-row" data-index="${i}">
      <div class="search-thumb" style="${thumbStyle(entry.thumbnail)}">${entry.thumbnail ? '' : '🌐'}</div>
      <div class="search-row-text">
        <div class="search-row-url">${escapeHtml(entry.url)}</div>
        <div class="search-row-meta">${escapeHtml(entry.domain)} · ${escapeHtml(new Date(entry.archivedAt).toLocaleString())}</div>
      </div>
      <div class="snapshot-links">
        <a href="/archived/${entry.dir}/page.html" target="_blank" rel="noopener">HTML</a>
        <a href="/archived/${entry.dir}/page.pdf" target="_blank" rel="noopener">PDF</a>
      </div>
    </div>
  `).join('');

  searchResults.querySelectorAll('.search-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      const entry = results[Number(row.dataset.index)];
      searchResults.classList.remove('show');
      openSiteCalendar(entry.domain);
    });
  });

  searchResults.classList.add('show');
}

/* ============================================================
   Dialog shell
   ============================================================ */

function openDialog() {
  dialogOverlay.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeDialog() {
  dialogOverlay.classList.add('closing');
  setTimeout(() => {
    dialogOverlay.classList.remove('closing');
    dialogOverlay.hidden = true;
    document.body.style.overflow = '';
  }, 200);
}

dialogClose.addEventListener('click', closeDialog);
dialogOverlay.addEventListener('click', (e) => {
  if (e.target === dialogOverlay) closeDialog();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!viewer.hidden) closeViewer();
  else if (!dialogOverlay.hidden) closeDialog();
});

snapshotsBtn.addEventListener('click', () => {
  openDialog();
  showSitesGrid();
});

/* ============================================================
   Library grid (per-site)
   ============================================================ */

async function showSitesGrid() {
  dialogTitle.textContent = 'Library';
  dialogBack.hidden = true;
  dialogBack.onclick = null;
  dialogBody.innerHTML = '<div class="dialog-loading">Loading…</div>';

  try {
    const res = await fetch('/api/sites');
    const sites = await res.json();

    if (!sites.length) {
      dialogBody.innerHTML = `
        <div class="dialog-empty">
          <div class="tl-empty-art">🗂️</div>
          <div>No archived sites yet.</div>
        </div>`;
      return;
    }

    dialogBody.innerHTML = `<div class="site-grid">${sites.map(renderSiteCard).join('')}</div>`;

    dialogBody.querySelectorAll('[data-domain]').forEach((card) => {
      card.addEventListener('click', () => showCalendar(card.dataset.domain));
    });

    dialogBody.querySelectorAll('[data-delete-site]').forEach((delBtn) => {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const domain = delBtn.dataset.deleteSite;
        const count = Number(delBtn.dataset.count);

        if (!confirm(`Delete all ${count} snapshot${count === 1 ? '' : 's'} for ${domain}? This cannot be undone.`)) return;

        try {
          const res = await fetch(`/api/sites/${encodeURIComponent(domain)}`, { method: 'DELETE' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) { showToast(data.error || 'Delete failed', 'error'); return; }
          showToast(`Deleted ${domain}`);
          showSitesGrid();
          loadTimeline({ skeleton: false });
        } catch (err) {
          showToast(err.message || 'Delete failed', 'error');
        }
      });
    });
  } catch (err) {
    dialogBody.innerHTML = `<div class="dialog-empty">${escapeHtml(err.message)}</div>`;
  }
}

function renderSiteCard(site, i) {
  return `
    <div class="site-card" data-domain="${escapeHtml(site.domain)}" style="animation-delay:${Math.min(i * 45, 500)}ms">
      <div class="site-thumb" style="${thumbStyle(site.thumbnail)}">${site.thumbnail ? '' : '🌐'}</div>
      <button type="button" class="site-delete-btn"
              data-delete-site="${escapeHtml(site.domain)}" data-count="${site.count}"
              aria-label="Delete all snapshots for ${escapeHtml(site.domain)}">🗑️</button>
      <div class="site-info">
        <div class="site-domain">${escapeHtml(site.domain)}</div>
        <div class="site-meta">${site.count} snapshot${site.count === 1 ? '' : 's'} · ${escapeHtml(new Date(site.latestArchivedAt).toLocaleDateString())}</div>
      </div>
    </div>`;
}

function openSiteCalendar(domain) {
  openDialog();
  showCalendar(domain);
}

/* ============================================================
   Per-site calendar
   ============================================================ */

async function showCalendar(domain) {
  dialogTitle.textContent = domain;
  dialogBack.hidden = false;
  dialogBack.onclick = () => showSitesGrid();
  dialogBody.innerHTML = '<div class="dialog-loading">Loading…</div>';

  try {
    const res = await fetch(`/api/sites/${encodeURIComponent(domain)}`);
    const entries = await res.json();

    if (!res.ok) {
      dialogBody.innerHTML = `<div class="dialog-empty">${escapeHtml(entries.error || 'Site not found.')}</div>`;
      return;
    }
    if (!entries.length) {
      dialogBody.innerHTML = '<div class="dialog-empty">No snapshots for this site.</div>';
      return;
    }

    const byDay = new Map();
    for (const entry of entries) {
      const key = dayKey(new Date(entry.archivedAt));
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(entry);
    }

    const latest = new Date(entries[entries.length - 1].archivedAt);
    let viewYear = latest.getFullYear();
    let viewMonth = latest.getMonth();
    let selectedKey = dayKey(latest);

    dialogBody.innerHTML = `
      <div class="calendar-header">
        <button class="icon-pill" id="cal-prev" type="button" aria-label="Previous month">‹</button>
        <span id="cal-month-label"></span>
        <button class="icon-pill" id="cal-next" type="button" aria-label="Next month">›</button>
      </div>
      <div class="calendar-grid" id="calendar-grid"></div>
      <div class="calendar-day-panel" id="calendar-day-panel"></div>
    `;
    wireRipples(dialogBody);

    const grid = document.getElementById('calendar-grid');
    const monthLabel = document.getElementById('cal-month-label');
    const dayPanel = document.getElementById('calendar-day-panel');

    function renderMonth() {
      monthLabel.textContent = `${MONTH_NAMES[viewMonth]} ${viewYear}`;

      const cells = WEEKDAYS.map((d) => `<div class="calendar-weekday">${d}</div>`);
      const firstOfMonth = new Date(viewYear, viewMonth, 1);
      const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

      for (let i = 0; i < firstOfMonth.getDay(); i++) {
        cells.push('<div class="calendar-day empty"></div>');
      }

      for (let day = 1; day <= daysInMonth; day++) {
        const key = `${viewYear}-${viewMonth}-${day}`;
        const hasArchive = byDay.has(key);
        const isSelected = key === selectedKey;
        cells.push(
          `<div class="calendar-day${hasArchive ? ' has-archive' : ''}${isSelected ? ' selected' : ''}" data-key="${key}">${day}</div>`
        );
      }

      grid.innerHTML = cells.join('');

      grid.querySelectorAll('.calendar-day.has-archive').forEach((cell) => {
        cell.addEventListener('click', () => {
          selectedKey = cell.dataset.key;
          renderMonth();
          renderDayPanel();
        });
      });
    }

    function renderDayPanel() {
      const dayEntries = byDay.get(selectedKey);
      if (!dayEntries) {
        dayPanel.innerHTML = '<div class="dialog-empty">Pick a highlighted date to see its snapshots.</div>';
        return;
      }

      const dateLabel = new Date(dayEntries[0].archivedAt).toLocaleDateString(undefined, {
        month: 'long', day: 'numeric', year: 'numeric'
      });

      dayPanel.innerHTML = `
        <div class="day-panel-header">
          <span>${dayEntries.length} snapshot${dayEntries.length === 1 ? '' : 's'} on ${dateLabel}</span>
          <button type="button" class="btn-tonal btn-danger" id="delete-day-btn">🗑️ Delete this day</button>
        </div>
        ${dayEntries.map((entry, i) => renderSnapshotRow(entry, i, domain)).join('')}
      `;
      wireRipples(dayPanel);

      dayPanel.querySelectorAll('[data-view-index]').forEach((thumb) => {
        thumb.addEventListener('click', () => {
          const entry = dayEntries[Number(thumb.dataset.viewIndex)];
          openViewer({ ...entry, domain });
        });
      });

      document.getElementById('delete-day-btn').addEventListener('click', async () => {
        if (!confirm(`Delete ${dayEntries.length} snapshot${dayEntries.length === 1 ? '' : 's'} from ${dateLabel}? This cannot be undone.`)) return;

        try {
          const res = await fetch('/api/archives/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dirs: dayEntries.map((e) => e.dir) })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) { showToast(data.error || 'Delete failed', 'error'); return; }
          showToast('Day deleted');
          showCalendar(domain);
          loadTimeline({ skeleton: false });
        } catch (err) {
          showToast(err.message || 'Delete failed', 'error');
        }
      });
    }

    document.getElementById('cal-prev').addEventListener('click', () => {
      viewMonth -= 1;
      if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
      renderMonth();
    });
    document.getElementById('cal-next').addEventListener('click', () => {
      viewMonth += 1;
      if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
      renderMonth();
    });

    renderMonth();
    renderDayPanel();
  } catch (err) {
    dialogBody.innerHTML = `<div class="dialog-empty">${escapeHtml(err.message)}</div>`;
  }
}

function renderSnapshotRow(entry, i, domain) {
  const time = new Date(entry.archivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const subText = entry.sublinkCount ? ` · ${entry.sublinkCount} sub-link${entry.sublinkCount === 1 ? '' : 's'}` : '';
  return `
    <div class="snapshot-row" style="animation-delay:${Math.min(i * 45, 400)}ms">
      <div class="snapshot-thumb" data-view-index="${i}" style="${thumbStyle(entry.thumbnail)}"
           role="button" tabindex="0" aria-label="Open this snapshot"></div>
      <div class="snapshot-info">
        <div class="snapshot-url">${escapeHtml(entry.url)}</div>
        <div class="snapshot-time">${time}${subText}</div>
      </div>
      <div class="snapshot-links">
        <a href="/archived/${entry.dir}/page.html" target="_blank" rel="noopener">HTML</a>
        <a href="/archived/${entry.dir}/page.pdf" target="_blank" rel="noopener">PDF</a>
      </div>
    </div>`;
}

/* ============================================================
   Export / import
   ============================================================ */

exportBtn.addEventListener('click', async () => {
  exportBtn.disabled = true;
  appProgress.hidden = false;
  try {
    const res = await fetch('/api/export');
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || 'Export failed', 'error');
      return;
    }

    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="(.+)"/);
    const filename = match ? match[1] : 'timecapsule-export.zip';

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Export downloaded');
  } catch (err) {
    showToast(err.message || 'Export failed', 'error');
  } finally {
    exportBtn.disabled = false;
    appProgress.hidden = true;
  }
});

importBtn.addEventListener('click', () => importFile.click());

importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('archive', file);

  importBtn.disabled = true;
  appProgress.hidden = false;
  try {
    const res = await fetch('/api/import', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) { showToast(data.error || 'Import failed', 'error'); return; }

    showToast('Import completed');
    if (!dialogOverlay.hidden) showSitesGrid();
    loadTimeline({ skeleton: false });
  } catch (err) {
    showToast(err.message || 'Import failed', 'error');
  } finally {
    importBtn.disabled = false;
    importFile.value = '';
    appProgress.hidden = true;
  }
});
