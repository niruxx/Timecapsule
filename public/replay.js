'use strict';

const replayButtons = document.getElementById('replay-formats');
const replayNotice = document.getElementById('replay-notice');
const replayFrame = document.getElementById('replay-frame');
const replayReader = document.getElementById('replay-reader');
const compareVersions = document.getElementById('compare-versions');
const snapshotAssets = document.getElementById('snapshot-assets');
const replayLabels = { screenshot: 'Screenshot', html: 'HTML', pdf: 'PDF', reader: 'Reader', warc: 'WARC replay', thumbnail: 'Thumbnail' };
let replayGeneration = 0;
let compareGeneration = 0;

function clearReplay() {
  replayGeneration++;
  replayFrame.hidden = true;
  replayReader.hidden = true;
  replayFrame.removeAttribute('src');
  replayFrame.removeAttribute('srcdoc');
  replayReader.textContent = '';
}

async function loadReplay(entry) {
  clearReplay();
  const request = replayGeneration;
  compareVersions.hidden = true;
  snapshotAssets.hidden = true;
  replayButtons.replaceChildren();
  replayNotice.textContent = 'Checking saved formats…';
  try {
    const { formats, versions } = await apiJson('/api/replay?dir=' + encodeURIComponent(entry.dir));
    if (replayGeneration !== request || viewerEntry !== entry) return;
    viewerHtml.hidden = !formats.html;
    viewerPdf.hidden = !formats.pdf;
    const missing = Object.keys(replayLabels).filter((key) => key !== 'thumbnail' && !formats[key]);
    replayNotice.textContent = missing.length ? 'Unavailable: ' + missing.map((key) => replayLabels[key]).join(', ') : '';
    const choices = Object.keys(replayLabels).filter((key) => formats[key] && (key !== 'thumbnail' || !formats.screenshot));
    const notice = replayNotice.textContent;
    for (const key of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-tonal';
      button.textContent = replayLabels[key];
      button.dataset.replay = key;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => showReplayFormat(entry, key, formats[key], notice));
      replayButtons.append(button);
    }
    if (choices.length) showReplayFormat(entry, choices[0], formats[choices[0]], notice);
    compareVersions.hidden = !versions.length;
    compareVersions.onclick = () => showVersionComparison([entry, ...versions]);
    if (canManageArchive) checkFailedAssetButton(entry);
  } catch (err) {
    if (replayGeneration === request) replayNotice.textContent = err.message;
  }
}

async function showReplayFormat(entry, key, filename, notice) {
  clearReplay();
  const request = replayGeneration;
  for (const button of replayButtons.children) button.setAttribute('aria-pressed', String(button.dataset.replay === key));
  replayNotice.textContent = notice;
  viewerImg.hidden = true;
  viewerPlaceholder.hidden = true;
  const source = archivePath(entry.dir + '/' + filename);
  try {
    if (key === 'screenshot' || key === 'thumbnail') {
      viewerImg.src = source;
      viewerImg.hidden = false;
    } else if (key === 'html' || key === 'pdf') {
      if (key === 'pdf') replayFrame.removeAttribute('sandbox');
      else replayFrame.setAttribute('sandbox', '');
      replayFrame.src = source;
      replayFrame.hidden = false;
    } else {
      const res = await fetch('/api/replay/' + key + '?dir=' + encodeURIComponent(entry.dir));
      if (!res.ok) throw new Error((await res.json()).error);
      const content = await (key === 'reader' ? res.text() : res.json());
      if (request !== replayGeneration) return;
      if (key === 'reader') {
        replayReader.textContent = content;
        replayReader.hidden = false;
      } else {
        replayFrame.setAttribute('sandbox', '');
        replayFrame.srcdoc = warcDocument(content);
        replayFrame.hidden = false;
        replayNotice.textContent = 'Offline WARC replay. Only captured styles, images, and fonts are shown.';
      }
    }
  } catch (err) {
    if (request === replayGeneration) replayNotice.textContent = err.message;
  }
}

function warcDocument({ html, url, resources }) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const contents = template.content;
  const resolved = (asset, base = url) => {
    try { return resources[new URL(asset, base).href] || ''; } catch { return ''; }
  };
  const localCss = (css, base) => css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (_match, _quote, asset) => `url("${resolved(asset.trim(), base) || 'about:blank'}")`);

  for (const node of contents.querySelectorAll('script, iframe, object, embed, base, meta[http-equiv]')) node.remove();
  for (const node of contents.querySelectorAll('link[href], img[src], input[src], source[src]')) {
    const key = node.localName === 'link' ? 'href' : 'src';
    const asset = node.getAttribute(key);
    const data = resolved(asset);
    if (node.localName === 'link' && data.startsWith('data:text/css;')) {
      const css = new TextDecoder().decode(Uint8Array.from(atob(data.split(',')[1]), (value) => value.charCodeAt(0)));
      const style = document.createElement('style');
      style.textContent = localCss(css, new URL(asset, url).href);
      node.replaceWith(style);
    } else if (data.startsWith('data:image/')) node.setAttribute(key, data);
    else node.removeAttribute(key);
  }
  for (const node of contents.querySelectorAll('[srcset], a[href], area[href]')) {
    node.removeAttribute('srcset');
    node.removeAttribute('href');
  }
  for (const node of contents.querySelectorAll('[style]')) node.setAttribute('style', localCss(node.getAttribute('style'), url));
  for (const node of contents.querySelectorAll('style')) node.textContent = localCss(node.textContent, url);
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'">${template.innerHTML}`;
}

function showVersionComparison(versions) {
  showModal(diffOverlay, diffClose);
  document.getElementById('diff-title').textContent = 'Compare snapshot versions';
  const options = versions.map((entry, index) => `<option value="${index}">${escapeHtml(new Date(entry.archivedAt).toLocaleString())}</option>`).join('');
  diffBody.innerHTML = `
    <div class="comparison">
      <div class="comparison-controls">
        <label>Left snapshot <select id="compare-left">${options}</select></label>
        <label>Right snapshot <select id="compare-right">${options}</select></label>
      </div>
      <div id="compare-results" aria-live="polite"></div>
    </div>`;
  const left = document.getElementById('compare-left');
  const right = document.getElementById('compare-right');
  const results = document.getElementById('compare-results');
  left.value = '1';
  right.value = '0';

  async function render() {
    const request = ++compareGeneration;
    const entries = [versions[Number(left.value)], versions[Number(right.value)]];
    results.textContent = 'Loading snapshot comparison…';
    if (left.value === right.value) {
      results.textContent = 'Choose two different snapshots.';
      return;
    }
    const panes = await Promise.all(entries.map(async (entry) => {
      const query = '?dir=' + encodeURIComponent(entry.dir);
      const { formats } = await apiJson('/api/replay' + query);
      const image = formats.screenshot || formats.thumbnail;
      return { entry, image };
    })).catch(() => null);
    if (request !== compareGeneration || !results.isConnected) return;
    if (!panes) { results.textContent = 'Could not load the comparison.'; return; }
    results.innerHTML = `
      <div class="compare-pair">${panes.map(({ entry, image }) => `<section class="compare-pane">
        <h3>${escapeHtml(new Date(entry.archivedAt).toLocaleString())}</h3>
        ${image ? `<div class="compare-image"><img src="${archivePath(entry.dir + '/' + image)}" alt="Snapshot screenshot"></div>` : '<p>Screenshot unavailable.</p>'}
        <pre>Loading saved text…</pre>
      </section>`).join('')}</div>
      <div id="comparison-diff"></div>`;
    const [from, to] = entries.map(({ dir }) => encodeURIComponent(dir));
    const delta = await apiJson(`/api/diff?from=${from}&to=${to}`).catch(() => null);
    if (request !== compareGeneration || !results.isConnected) return;
    const [leftText, rightText] = results.querySelectorAll('.compare-pane pre');
    leftText.textContent = delta?.textA || 'Saved text unavailable.';
    rightText.textContent = delta?.textB || 'Saved text unavailable.';
    if (!delta) return;
    results.querySelector('#comparison-diff').innerHTML = '<h3>Text changes</h3>' + delta.parts.map((part) => {
      const value = escapeHtml(part.value);
      if (part.added) return `<ins>${value}</ins>`;
      if (part.removed) return `<del>${value}</del>`;
      return value;
    }).join('');
  }
  left.addEventListener('change', render);
  right.addEventListener('change', render);
  render();
}

document.getElementById('calendar-btn').addEventListener('click', async () => {
  showWorkspaceDialog('Archive calendar', '<div id="archive-calendar" class="archive-calendar">Loading…</div>');
  const panel = document.getElementById('archive-calendar');
  try {
    const entries = await apiJson('/api/timeline');
    if (!panel.isConnected) return;
    if (!entries.length) { panel.textContent = 'No captures yet.'; return; }
    const byDay = new Map();
    for (const entry of entries) {
      const key = dayKey(new Date(entry.archivedAt));
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(entry);
    }
    const first = new Date(entries[0].archivedAt);
    panel.innerHTML = `
      <label class="calendar-month-field">Month <input type="month"></label>
      <div class="calendar-grid"></div><div class="workspace-list calendar-captures"></div>`;
    const month = panel.querySelector('input');
    const grid = panel.querySelector('.calendar-grid');
    const list = panel.querySelector('.calendar-captures');
    month.value = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}`;
    function showDay(captures) {
      list.replaceChildren(...captures.map((entry) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'workspace-list-item';
        button.textContent = (entry.title || entry.url) + (entry.change?.changed ? ' · Changed' : '');
        button.addEventListener('click', () => openViewer(entry));
        return button;
      }));
    }
    function showMonth() {
      if (!month.value) return;
      const [year, number] = month.value.split('-').map(Number);
      const firstDay = new Date(year, number - 1, 1);
      const total = new Date(year, number, 0).getDate();
      const days = WEEKDAYS.map((name) => `<div class="calendar-weekday">${name}</div>`);
      for (let i = 0; i < firstDay.getDay(); i++) days.push('<div class="calendar-day empty"></div>');
      for (let day = 1; day <= total; day++) {
        const captures = byDay.get(dayKey(new Date(year, number - 1, day)));
        if (!captures) { days.push(`<span class="calendar-day">${day}</span>`); continue; }
        const changed = captures.filter((entry) => entry.change?.changed).length;
        days.push(`<button type="button" class="calendar-day has-archive" data-day="${day}" aria-pressed="false"
          aria-label="Day ${day}, ${captures.length} captures, ${changed} changed">
          <span>${day}</span><small>${captures.length}${changed ? ' · changed' : ''}</small></button>`);
      }
      grid.innerHTML = days.join('');
      list.textContent = 'Choose a capture date.';
      for (const button of grid.querySelectorAll('[data-day]')) button.addEventListener('click', () => {
        grid.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-pressed', 'true');
        showDay(byDay.get(dayKey(new Date(year, number - 1, Number(button.dataset.day)))));
      });
    }
    month.addEventListener('change', showMonth);
    showMonth();
    grid.querySelector('[data-day="' + first.getDate() + '"]')?.click();
  } catch (err) { panel.textContent = err.message; }
});
