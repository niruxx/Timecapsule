'use strict';

const operationsButton = document.getElementById('operations-btn');
const operationTabs = ['Jobs', 'Schedules', 'Storage', 'Public mirrors'];
let operationPoll;

function openOperations(initialTab = 'Jobs') {
  clearTimeout(operationPoll);
  const tabs = canManageArchive ? operationTabs : ['Jobs'];
  showWorkspaceDialog('Capture operations', `
    <nav class="operations-tabs" aria-label="Operations">
      ${tabs.map((tab) => `<button class="btn-tonal" type="button" data-operation-tab="${tab}">${tab}</button>`).join('')}
    </nav>
    <div id="operation-panel" class="operation-panel"></div>`);
  const panel = document.getElementById('operation-panel');
  const buttons = dialogBody.querySelectorAll('[data-operation-tab]');
  let active;

  async function select(tab) {
    clearTimeout(operationPoll);
    active = tab;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.operationTab === tab));
    const content = document.createElement('div');
    content.className = 'workspace-dialog-content';
    panel.replaceChildren(content);
    content.textContent = 'Loading…';
    try {
      if (tab === 'Jobs') {
        await renderJobs(content);
        function poll() {
          if (!content.isConnected || dialogOverlay.hidden || active !== 'Jobs') return;
          operationPoll = setTimeout(async () => {
            if (!content.contains(document.activeElement) && !content.dataset.busy) {
              try { await renderJobs(content); } catch (err) { content.textContent = err.message; }
            }
            poll();
          }, 2500);
        }
        poll();
      } else if (tab === 'Schedules') await renderSchedules(content, () => select(tab));
      else if (tab === 'Storage') await renderStorage(content, () => select(tab));
      else await renderMirrors(content, () => select(tab));
    } catch (err) { content.textContent = err.message; }
  }
  for (const button of buttons) button.addEventListener('click', () => select(button.dataset.operationTab));
  select(tabs.includes(initialTab) ? initialTab : 'Jobs');
}

operationsButton.addEventListener('click', () => openOperations());

const jobStatus = {
  queued: 'Queued', running: 'Running', 'awaiting-verification': 'Awaiting verification',
  done: 'Completed', error: 'Failed', stopped: 'Cancelled',
};

function bindOperation(button, action, onSuccess = () => {}) {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await action(); await onSuccess(); }
    catch (err) { showToast(err.message, 'error'); }
    finally { button.disabled = false; }
  });
}

async function renderJobs(panel) {
  const jobs = await apiJson('/api/operations/jobs');
  if (!panel.isConnected) return;
  panel.innerHTML = jobs.length ? `<div class="workspace-list jobs-list">${jobs.map((job, index) => `
    <article class="workspace-list-item job-card">
      <div class="job-info">
        <strong>${escapeHtml(job.target)}</strong>
        <small>${jobStatus[job.status] || 'Unknown'} · ${escapeHtml(new Date(job.createdAt).toLocaleString())}</small>
        <small>${escapeHtml(job.error || job.progress?.label || '')}</small>
      </div>
      <div class="dialog-actions">
        ${job.archiveDir ? `<button type="button" class="btn-tonal" data-job-open="${index}">Open capture</button>` : ''}
        ${job.canRetry ? `<button type="button" class="btn-tonal" data-job-retry="${index}">Retry</button>` : ''}
        ${['queued', 'running', 'awaiting-verification'].includes(job.status)
          ? `<button type="button" class="btn-tonal btn-danger" data-job-stop="${index}">Cancel</button>` : ''}
      </div>
    </article>`).join('')}</div>` : '<p class="dialog-note">Archive a URL to see its job here.</p>';
  for (const button of panel.querySelectorAll('[data-job-retry], [data-job-stop]')) {
    const retry = button.dataset.jobRetry !== undefined;
    const job = jobs[Number(button.dataset.jobRetry ?? button.dataset.jobStop)];
    const url = retry ? '/api/operations/jobs/' + job.id + '/retry' : '/api/archive/' + job.id + '/stop';
    bindOperation(button, async () => {
      panel.dataset.busy = 'true';
      try { await apiJson(url, { method: 'POST' }); } finally { delete panel.dataset.busy; }
    }, () => renderJobs(panel));
  }
  for (const button of panel.querySelectorAll('[data-job-open]')) {
    bindOperation(button, async () => {
      const entries = await apiJson('/api/timeline');
      const entry = entries.find(({ dir }) => dir === jobs[Number(button.dataset.jobOpen)].archiveDir);
      if (!entry) throw new Error('The capture is no longer available.');
      openViewer(entry);
    });
  }
}

async function renderSchedules(panel, refresh) {
  const { schedules, notifications } = await apiJson('/api/operations/schedules');
  if (!panel.isConnected) return;
  panel.innerHTML = `
    <form class="workspace-form operations-form">
      <label>Page URL <input name="url" type="url" required placeholder="https://example.org"></label>
      <label>Interval in minutes <input name="interval" type="number" min="1" max="525600" value="1440" required></label>
      <label>Collection <input name="collection" maxlength="80" placeholder="Optional"></label>
      <button class="btn-filled" type="submit">Schedule capture</button>
    </form>
    <div class="workspace-list">${schedules.map((record, index) => `
      <article class="workspace-list-item job-card">
        <div class="job-info"><strong>${escapeHtml(record.url)}</strong>
        <small>${record.enabled ? 'Next capture ' + escapeHtml(new Date(record.nextAt).toLocaleString()) : 'Paused'} · Every ${record.interval} min</small>
        <small>${record.collection ? 'Collection · ' + escapeHtml(record.collection) : ''}</small></div>
        <div class="dialog-actions">
          <button class="btn-tonal" type="button" data-schedule-history="${index}">History</button>
          <button class="btn-tonal" type="button" data-schedule-run="${index}">Run now</button>
          <button class="btn-tonal" type="button" data-schedule-toggle="${index}">${record.enabled ? 'Pause' : 'Resume'}</button>
          <button class="btn-tonal btn-danger" type="button" data-schedule-delete="${index}">Remove</button>
        </div>
      </article>`).join('')}</div>
    <h3>Notifications</h3>
    ${notifications.length ? `<ul class="review-list">${notifications.map((notice) => `
      <li><strong>${escapeHtml(notice.message)}</strong><small>${escapeHtml(new Date(notice.at).toLocaleString())}
      ${notice.url ? ' · ' + escapeHtml(notice.url) : ''}</small>
      ${notice.externalJobId ? `<small>Wayback job · ${escapeHtml(notice.externalJobId)}</small>` : ''}
      ${notice.error ? `<small>${escapeHtml(notice.error)}</small>` : ''}</li>`).join('')}</ul>`
      : '<p class="dialog-note">Changes and failed scheduled captures appear here.</p>'}`;
  const form = panel.querySelector('form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button');
    submit.disabled = true;
    try {
      await apiJson('/api/operations/schedules', jsonPost(Object.fromEntries(new FormData(form))));
      await refresh();
    } catch (err) { showToast(err.message, 'error'); }
    finally { submit.disabled = false; }
  });
  for (const button of panel.querySelectorAll('[data-schedule-run]')) {
    const entry = schedules[Number(button.dataset.scheduleRun)];
    bindOperation(button, () => apiJson(`/api/operations/schedules/${entry.id}/run`, { method: 'POST' }),
      () => openOperations('Jobs'));
  }
  for (const button of panel.querySelectorAll('[data-schedule-toggle]')) {
    const entry = schedules[Number(button.dataset.scheduleToggle)];
    bindOperation(button, () => apiJson(`/api/operations/schedules/${entry.id}`, {
      ...jsonPost({ enabled: !entry.enabled }), method: 'PATCH',
    }), refresh);
  }
  for (const button of panel.querySelectorAll('[data-schedule-delete]')) {
    const entry = schedules[Number(button.dataset.scheduleDelete)];
    bindOperation(button, () => apiJson(`/api/operations/schedules/${entry.id}`, { method: 'DELETE' }), refresh);
  }
  for (const button of panel.querySelectorAll('[data-schedule-history]')) {
    const entry = schedules[Number(button.dataset.scheduleHistory)];
    bindOperation(button, async () => {
      const results = (await apiJson('/api/timeline')).filter((snapshot) => snapshot.url === entry.url);
      showWorkspaceDialog('Scheduled URL history', results.length ? '<div class="workspace-list"></div>' : '<p class="dialog-note">No snapshots for this URL yet.</p>');
      const list = dialogBody.querySelector('.workspace-list');
      for (const snapshot of results) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'workspace-list-item';
        item.textContent = new Date(snapshot.archivedAt).toLocaleString() + (snapshot.change?.changed ? ' · Changed' : '');
        item.addEventListener('click', () => openViewer(snapshot));
        list.append(item);
      }
    });
  }
}

function displayBytes(bytes) {
  let value = bytes;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ' + units[unit];
}

async function renderStorage(panel, refresh) {
  const { usage, s3, replicate } = await apiJson('/api/operations/storage');
  if (!panel.isConnected) return;
  const total = usage.reduce((sum, row) => sum + row.bytes, 0);
  panel.innerHTML = `
    <h3>Archive storage · ${displayBytes(total)}</h3>
    <div class="workspace-list">${usage.map(({ format, bytes }) => `
      <div class="workspace-list-item storage-row"><strong>${escapeHtml(format)}</strong>
      <meter min="0" max="${total || 1}" value="${bytes}">${displayBytes(bytes)}</meter>
      <small>${displayBytes(bytes)}</small></div>`).join('')}</div>
    <h3>Retention</h3>
    <form id="retention-form" class="workspace-form operations-form">
      <label>Older than (days) <input name="days" type="number" min="1" max="36500" value="365" required></label>
      <label>Site <input name="domain" placeholder="All sites"></label>
      <button class="btn-tonal" type="submit">Preview rule</button>
    </form>
    <div id="retention-review" aria-live="polite"></div>
    <h3>S3 backups</h3>
    ${s3 ? `<p class="dialog-note">${replicate ? 'New captures are also replicated to S3.' : 'Create a checkpoint of the local archive.'} Restore is available when the archive is empty.</p>
      <div class="dialog-actions"><button class="btn-filled" type="button" id="storage-backup">Back up to S3</button>
      <button class="btn-tonal" type="button" id="storage-restore">Restore latest checkpoint</button></div>
      <p class="dialog-note" id="storage-status" role="status"></p>` : '<p class="dialog-note">Configure an S3 bucket on the server to enable verified checkpoints.</p>'}`;
  const form = panel.querySelector('form');
  const review = panel.querySelector('#retention-review');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    review.textContent = 'Checking matching snapshots…';
    try {
      const { token, candidates } = await apiJson('/api/operations/retention/preview', jsonPost(Object.fromEntries(new FormData(form))));
      review.innerHTML = candidates.length ? `
        <p>${candidates.length} snapshots match this rule.</p>${previewSnapshots(candidates)}
        <button type="button" class="btn-tonal btn-danger">Delete reviewed snapshots</button>`
        : '<p class="dialog-note">No snapshots match this rule.</p>';
      if (!candidates.length) return;
      bindOperation(review.querySelector('button'), async () => {
        if (!confirm(`Permanently delete these ${candidates.length} snapshots?`)) return;
        await apiJson('/api/operations/retention/apply', jsonPost({ token }));
        showToast('Reviewed snapshots deleted');
        loadTimeline({ skeleton: false });
        await refresh();
      });
    } catch (err) { review.textContent = err.message; }
  });
  for (const action of ['backup', 'restore']) {
    const button = panel.querySelector('#storage-' + action);
    if (!button) continue;
    bindOperation(button, async () => {
      const status = panel.querySelector('#storage-status');
      status.textContent = 'Working…';
      try {
        const result = await apiJson('/api/operations/storage/' + action, { method: 'POST' });
        status.textContent = action === 'backup' ? 'Backup saved.' : `Restored and verified ${result.files} files.`;
        if (action === 'restore') loadTimeline({ skeleton: false });
      } catch (err) { status.textContent = err.message; }
    });
  }
}

async function renderMirrors(panel, refresh) {
  const data = await apiJson('/api/operations/mirrors');
  if (!panel.isConnected) return;
  if (!data.enabled) {
    panel.textContent = 'Configure Wayback API credentials on the server to enable public mirroring.';
    return;
  }
  const collections = [...new Set([...data.collections, ...data.publicCollections])].sort();
  panel.innerHTML = `
    <p>Enable a collection to submit URLs from newly filed snapshots to the public Wayback Machine.</p>
    <div class="workspace-list">${collections.map((collection, index) => `
      <div class="workspace-list-item"><strong>${escapeHtml(collection)}</strong>
        <button type="button" class="btn-tonal" data-mirror-index="${index}">
          ${data.publicCollections.includes(collection) ? 'Disable public mirroring' : 'Enable public mirroring'}
        </button>
      </div>`).join('')}</div>
    ${collections.length ? '' : '<p class="dialog-note">Create a collection before enabling a public mirror.</p>'}`;
  for (const button of panel.querySelectorAll('[data-mirror-index]')) {
    const collection = collections[Number(button.dataset.mirrorIndex)];
    const enabled = !data.publicCollections.includes(collection);
    bindOperation(button, async () => {
      if (enabled && !confirm(`Future URLs filed into “${collection}” may be captured publicly. Enable mirroring?`)) return;
      await apiJson('/api/operations/mirrors', jsonPost({ collection, enabled }));
      await refresh();
    });
  }
}

async function checkFailedAssetButton(entry) {
  try {
    const report = await apiJson('/api/operations/assets?dir=' + encodeURIComponent(entry.dir));
    if (viewerEntry !== entry || !report.length) return;
    snapshotAssets.hidden = false;
    snapshotAssets.textContent = `Assets (${report.length})`;
    snapshotAssets.onclick = () => showFailedAssets(entry, report);
  } catch { /* Legacy snapshots may have no asset report. */ }
}

function showFailedAssets(entry, report) {
  showModal(diffOverlay, diffClose);
  document.getElementById('diff-title').textContent = 'Capture asset report';
  diffBody.innerHTML = `<div class="workspace-dialog-content">
    <p class="dialog-note">Recovered files are saved alongside the original capture.</p>
    <div class="workspace-list">${report.map((asset, index) => `
      <div class="workspace-list-item job-card">
        <div class="job-info"><strong>${escapeHtml(asset.url)}</strong><small>${escapeHtml(asset.type)} · ${escapeHtml(asset.reason)}</small></div>
        ${asset.status === 'recovered' ? `<a class="btn-tonal" download href="${archivePath(entry.dir + '/' + asset.filename)}">Download recovered file</a>`
          : `<button class="btn-tonal" type="button" data-asset-retry="${index}">Retry asset</button>`}
      </div>`).join('')}</div></div>`;
  for (const button of diffBody.querySelectorAll('[data-asset-retry]')) {
    bindOperation(button, async () => {
      const index = Number(button.dataset.assetRetry);
      report[index] = await apiJson('/api/operations/assets/retry', jsonPost({ dir: entry.dir, index }));
      if (button.isConnected && !diffOverlay.hidden) showFailedAssets(entry, report);
    });
  }
}
