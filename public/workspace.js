'use strict';

const historyTools = document.getElementById('history-tools');
const historyQuery = document.getElementById('history-query');
const sortFilter = document.getElementById('sort-filter');
const tagFilter = document.getElementById('tag-filter');
const collectionFilter = document.getElementById('collection-filter');
const dateFrom = document.getElementById('date-from');
const dateThrough = document.getElementById('date-through');
const filterCount = document.getElementById('filter-count');
const selectionToggle = document.getElementById('selection-toggle');
const selectionBar = document.getElementById('selection-bar');
const selectedCount = document.getElementById('selected-count');
const reviewSelection = document.getElementById('review-selection');
const selectVisible = document.getElementById('select-visible');
const batchButton = document.getElementById('batch-btn');
const historyFilters = [domainFilter, formatFilter, tagFilter, collectionFilter, dateFrom, dateThrough];
const historyInputs = [historyQuery, ...historyFilters, sortFilter];
const selectedSnapshots = new Set();

let historyTerm = '';
let historyMatches = null;
let historySearchRequest = 0;
let selectingSnapshots = false;
let batch = null;

async function apiJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => null);
  if (!res.ok || data === null) throw new Error(data?.error || `The request failed (${res.status}).`);
  return data;
}

function jsonPost(body) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function labelOptions(select, label, values) {
  const previous = select.value;
  const sorted = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const options = [new Option(label, ''), ...sorted.map((value) => new Option(value, value))];
  if (previous && !sorted.includes(previous)) options.push(new Option(previous, previous));
  select.replaceChildren(...options);
  select.value = previous;
}

function updateHistoryOptions(entries) {
  labelOptions(domainFilter, 'All sites', entries.map((entry) => entry.domain));
  labelOptions(tagFilter, 'All tags', entries.flatMap((entry) => entry.tags || []));
  labelOptions(collectionFilter, 'All collections', entries.map((entry) => entry.collection));
  timelineControls.hidden = !entries.length;
  historyTools.hidden = !entries.length;
  const available = new Set(entries.map((entry) => entry.dir));
  for (const dir of selectedSnapshots) if (!available.has(dir)) selectedSnapshots.delete(dir);
  if (!entries.length) selectingSnapshots = false;
}

function activeHistoryFilters() {
  const count = historyFilters.filter((field) => field.value).length;
  filterCount.textContent = count ? String(count) : '';
  return count;
}

function filterSnapshotEntries() {
  const domain = domainFilter.value;
  const format = formatFilter.value;
  const tag = tagFilter.value;
  const collection = collectionFilter.value;
  const from = dateFrom.value;
  const through = dateThrough.value;
  const entries = timelineEntries.filter((entry) => {
    if (historyMatches && !historyMatches.has(entry.dir)) return false;
    if (domain && entry.domain !== domain) return false;
    if (format && !(format === 'media' ? entry.media?.length : entry[format])) return false;
    if (tag && !entry.tags?.includes(tag)) return false;
    if (collection && entry.collection !== collection) return false;
    if (from || through) {
      const archived = new Date(entry.archivedAt);
      if (from && archived < new Date(from + 'T00:00:00')) return false;
      if (through && archived > new Date(through + 'T23:59:59.999')) return false;
    }
    return true;
  });
  if (sortFilter.value === 'old') entries.reverse();
  if (sortFilter.value === 'title') {
    entries.sort((a, b) => (a.title || a.url).localeCompare(b.title || b.url));
  }
  return entries;
}

async function refreshHistorySearch(query) {
  const request = ++historySearchRequest;
  if (!query) {
    historyMatches = null;
    return true;
  }
  try {
    const results = await apiJson('/api/search?scope=timeline&q=' + encodeURIComponent(query));
    if (request !== historySearchRequest) return false;
    historyMatches = new Set(results.map((entry) => entry.dir));
    return true;
  } catch (err) {
    if (request === historySearchRequest) showToast(err.message, 'error');
    return false;
  }
}

async function applyHistorySearch() {
  const query = historyQuery.value.trim();
  if (!await refreshHistorySearch(query)) return;
  historyTerm = query;
  renderTimeline();
}

function showHistorySearch(query) {
  historyQuery.value = query;
  applyHistorySearch();
  activity.scrollIntoView({ block: 'start' });
  historyQuery.focus({ preventScroll: true });
}

function resetHistoryFilters() {
  for (const filter of historyFilters) filter.value = '';
  historyQuery.value = '';
  sortFilter.value = 'new';
  applyHistorySearch();
  historyQuery.focus();
}

document.getElementById('history-search').addEventListener('submit', (event) => {
  event.preventDefault();
  applyHistorySearch();
});
historyQuery.addEventListener('input', () => {
  if (!historyQuery.value) applyHistorySearch();
});
for (const field of [...historyFilters, sortFilter]) field.addEventListener('change', renderTimeline);
document.getElementById('reset-filters').addEventListener('click', resetHistoryFilters);

function updateSelectionPanel(visibleCount = filterSnapshotEntries().length) {
  selectionToggle.setAttribute('aria-pressed', String(selectingSnapshots));
  selectionBar.hidden = !selectingSnapshots;
  selectedCount.textContent = `${selectedSnapshots.size} selected`;
  reviewSelection.disabled = !selectedSnapshots.size;
  selectVisible.disabled = !visibleCount;
}

function updateSnapshotSelection(entry, card) {
  if (selectedSnapshots.has(entry.dir)) selectedSnapshots.delete(entry.dir);
  else selectedSnapshots.add(entry.dir);
  card.setAttribute('aria-pressed', String(selectedSnapshots.has(entry.dir)));
  updateSelectionPanel();
}

selectionToggle.addEventListener('click', () => {
  selectingSnapshots = !selectingSnapshots;
  if (!selectingSnapshots) selectedSnapshots.clear();
  renderTimeline();
});
selectVisible.addEventListener('click', () => {
  for (const entry of filterSnapshotEntries()) selectedSnapshots.add(entry.dir);
  renderTimeline();
});

function showWorkspaceDialog(title, content) {
  dialogTitle.textContent = title;
  dialogBack.hidden = true;
  dialogBack.onclick = null;
  dialogBody.innerHTML = content;
  openDialog();
}

function snapshotLabel(entry) {
  return escapeHtml(entry.title || entry.url);
}

function previewSnapshots(entries) {
  return `<ul class="review-list">${entries.map((entry) => `
    <li><strong>${snapshotLabel(entry)}</strong><small>${escapeHtml(entry.domain)} · ${escapeHtml(new Date(entry.archivedAt).toLocaleDateString())}</small></li>
  `).join('')}</ul>`;
}

async function downloadSelection(dirs) {
  const res = await fetch('/api/archives/export', jsonPost({ dirs }));
  if (!res.ok) throw new Error((await res.json()).error || 'Export failed.');
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = res.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] || 'timecapsule-selection.zip';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const organizeActionFields = {
  'add-tag': { label: 'Tag name', placeholder: 'e.g. Research' },
  'remove-tag': { label: 'Manual tag name', placeholder: 'e.g. Research' },
  move: { label: 'Collection name', placeholder: 'Leave blank to unfile' },
};

function showOrganization(entries, initialAction = 'add-tag', initialValue) {
  if (!entries.length) return;
  const single = entries.length === 1 ? entries[0] : null;
  const tags = single?.manualTags || [];
  const suggestions = (single?.aiTags || []).filter((tag) => !tags.includes(tag));
  const tagList = tags.length ? `<p class="dialog-note">Manual tags · ${tags.map(escapeHtml).join(', ')}</p>` : '';
  const suggestionsList = suggestions.length ? `<p class="dialog-note">AI suggestions</p><div class="dialog-actions">${suggestions.map((tag, index) =>
    `<button class="tag-cloud-chip" type="button" data-suggestion="${index}">${escapeHtml(tag)}</button>`
  ).join('')}</div>` : '';
  showWorkspaceDialog('Organize snapshots', `
    <div class="workspace-dialog-content">
      <p>${entries.length} selected snapshot${single ? '' : 's'}</p>
      ${previewSnapshots(entries)}
      ${tagList}
      ${suggestionsList}
      <form id="organize-form" class="workspace-form">
        <label>Action <select id="organize-action">
          <option value="add-tag">Add a tag</option><option value="remove-tag">Remove a tag</option>
          <option value="move">Move to a collection</option><option value="export">Export selected snapshots</option>
        </select></label>
        <label id="organize-value-label"><span>Tag name</span><input id="organize-value" maxlength="80" list="organization-labels" required placeholder="e.g. Research"></label>
        <datalist id="organization-labels"></datalist>
        <div class="dialog-actions"><button class="btn-filled" type="submit">Apply to ${entries.length}</button></div>
        <p id="organize-status" class="dialog-note" role="status"></p>
      </form>
    </div>`);
  const form = document.getElementById('organize-form');
  const action = document.getElementById('organize-action');
  const value = document.getElementById('organize-value');
  const valueLabel = document.getElementById('organize-value-label');
  const labels = document.getElementById('organization-labels');
  const submit = form.querySelector('button');
  const status = document.getElementById('organize-status');
  const dirs = entries.map((entry) => entry.dir);

  function setActionFields() {
    const fields = organizeActionFields[action.value];
    valueLabel.hidden = !fields;
    value.required = action.value === 'add-tag' || action.value === 'remove-tag';
    submit.textContent = fields ? `Apply to ${entries.length}` : 'Download ZIP';
    if (!fields) return;
    valueLabel.querySelector('span').textContent = fields.label;
    value.placeholder = fields.placeholder;
    let values = action.value === 'move'
      ? timelineEntries.map((entry) => entry.collection)
      : entries.flatMap((entry) => entry.manualTags || []);
    if (action.value === 'add-tag') values = timelineEntries.flatMap((entry) => entry.manualTags || []);
    labels.replaceChildren(...[...new Set(values.filter(Boolean))].sort().map((item) => new Option(item, item)));
    value.value = action.value === 'move' ? single?.collection || '' : '';
  }
  action.value = initialAction;
  action.addEventListener('change', setActionFields);
  setActionFields();
  if (initialValue !== undefined) value.value = initialValue;
  dialogBody.querySelectorAll('[data-suggestion]').forEach((button) => {
    button.addEventListener('click', () => {
      action.value = 'add-tag';
      setActionFields();
      value.value = suggestions[Number(button.dataset.suggestion)];
      value.focus();
    });
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    status.textContent = '';
    try {
      if (action.value === 'export') {
        await downloadSelection(dirs);
        showToast('Snapshot export downloaded');
      } else {
        await apiJson('/api/archives/organize', jsonPost({ dirs, action: action.value, value: value.value }));
        await loadTimeline({ skeleton: false });
        showToast('Snapshots updated');
      }
      if (form.isConnected && !dialogOverlay.hidden) closeDialog();
    } catch (err) {
      status.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });
}

reviewSelection.addEventListener('click', () => {
  showOrganization(timelineEntries.filter((entry) => selectedSnapshots.has(entry.dir)));
});
document.getElementById('viewer-organize').addEventListener('click', () => {
  const entry = viewerEntry;
  closeViewer();
  showOrganization([entry]);
});

function showCollections() {
  const collections = new Map();
  for (const entry of timelineEntries) {
    if (!entry.collection) continue;
    if (!collections.has(entry.collection)) collections.set(entry.collection, []);
    collections.get(entry.collection).push(entry);
  }
  const names = [...collections.keys()].sort((a, b) => a.localeCompare(b));
  showWorkspaceDialog('Collections', names.length ? `<div class="workspace-list">${names.map((name, index) => `
    <div class="workspace-list-item">
      <button class="inline-action" type="button" data-collection-index="${index}">${icon('folder')} ${escapeHtml(name)}</button>
      <small>${collections.get(name).length} snapshots</small>
      <button class="btn-tonal" type="button" data-manage-collection="${index}" aria-label="Organize ${escapeHtml(name)}">Organize</button>
    </div>`).join('')}</div>` : '<p class="dialog-empty">Choose Organize on a snapshot or review a selection to create a collection.</p>');
  dialogBody.querySelectorAll('[data-collection-index]').forEach((button) => {
    button.addEventListener('click', () => {
      const name = names[Number(button.dataset.collectionIndex)];
      closeDialog();
      if (activity.hidden) {
        showOrganization(collections.get(name), 'move', name);
        return;
      }
      for (const filter of historyFilters) filter.value = '';
      collectionFilter.value = name;
      document.getElementById('history-filters').open = true;
      showHistorySearch('');
    });
  });
  dialogBody.querySelectorAll('[data-manage-collection]').forEach((button) => {
    button.addEventListener('click', () => {
      const name = names[Number(button.dataset.manageCollection)];
      showOrganization(collections.get(name), 'move', name);
    });
  });
}

document.getElementById('collections-btn').addEventListener('click', showCollections);

const SAVED_SEARCH_KEY = 'timecapsule-saved-searches';

function readSavedSearches() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_SEARCH_KEY)) || [];
  } catch {
    return [];
  }
}

function showSavedSearches() {
  const searches = readSavedSearches();
  showWorkspaceDialog('Saved searches', searches.length ? `
    <div class="workspace-list">${searches.map((search, index) => `
      <div class="workspace-list-item">
        <button class="inline-action" type="button" data-open-search="${index}">${icon('bookmark')} ${escapeHtml(search.name)}</button>
        <button class="btn-tonal" type="button" data-delete-search="${index}" aria-label="Remove ${escapeHtml(search.name)}">Remove</button>
      </div>`).join('')}</div>` : '<p class="dialog-empty">Use Save search in capture history to bookmark a query and its filters.</p>');

  dialogBody.querySelectorAll('[data-open-search]').forEach((button) => {
    button.addEventListener('click', () => {
      if (activity.hidden) {
        showToast('Capture history is disabled on this server.', 'error');
        return;
      }
      const search = searches[Number(button.dataset.openSearch)];
      for (const field of historyInputs) {
        const value = search.fields[field.id] || (field === sortFilter ? 'new' : '');
        if ([domainFilter, tagFilter, collectionFilter].includes(field) && !Array.from(field.options).some((option) => option.value === value)) {
          field.add(new Option(value, value));
        }
        field.value = value;
      }
      document.getElementById('history-filters').open = Boolean(activeHistoryFilters());
      closeDialog();
      showHistorySearch(historyQuery.value);
    });
  });
  dialogBody.querySelectorAll('[data-delete-search]').forEach((button) => {
    button.addEventListener('click', () => {
      searches.splice(Number(button.dataset.deleteSearch), 1);
      localStorage.setItem(SAVED_SEARCH_KEY, JSON.stringify(searches));
      showSavedSearches();
    });
  });
}

document.getElementById('saved-searches-btn').addEventListener('click', showSavedSearches);
document.getElementById('save-search-btn').addEventListener('click', () => {
  showWorkspaceDialog('Save search', `
    <form id="save-search-form" class="workspace-form">
      <label>Name <input maxlength="80" id="saved-search-name" required></label>
      <p class="dialog-note">Your query, filters, and sort order are saved in this browser.</p>
      <button class="btn-filled" type="submit">Save search</button>
    </form>`);
  const nameField = document.getElementById('saved-search-name');
  nameField.value = historyQuery.value.trim();
  nameField.focus();
  document.getElementById('save-search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = nameField.value.trim();
    if (!name) return;
    const fields = Object.fromEntries(historyInputs.map((field) => [field.id, field.value]));
    const searches = readSavedSearches().filter((search) => search.name !== name);
    searches.push({ name, fields });
    localStorage.setItem(SAVED_SEARCH_KEY, JSON.stringify(searches));
    closeDialog();
    showToast('Search saved');
  });
});

const batchStatusLabels = {
  new: 'Ready', existing: 'Already archived', duplicate: 'Duplicate in batch', invalid: 'Invalid URL',
  waiting: 'Waiting', running: 'Capturing', done: 'Captured', reused: 'Snapshot reused',
  failed: 'Failed', stopped: 'Stopped',
};
let batchSource = '';

function extractBookmarkUrls(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return Array.from(template.content.querySelectorAll('a[href]'), (anchor) => anchor.getAttribute('href'))
    .filter((href) => /^https?:\/\//i.test(href.trim()));
}

function showBatchDialog() {
  showWorkspaceDialog('Bulk capture', `
    <div class="workspace-dialog-content">
      <form id="batch-form" class="workspace-form" ${batch ? 'hidden' : ''}>
        <label>Page URLs <textarea id="batch-urls" rows="6" placeholder="One URL per line" required></textarea></label>
        <label>Or load a browser bookmarks file <input id="bookmark-file" type="file" accept=".html,.htm,text/html"></label>
        <p class="dialog-note">Up to 200 URLs per batch. Each capture saves a single page.</p>
        <div class="dialog-actions"><button class="btn-filled" type="submit">Preview URLs</button></div>
        <p id="batch-form-status" class="dialog-note" role="status"></p>
      </form>
      <div id="batch-preview" ${batch ? '' : 'hidden'}>
        <p id="batch-summary" role="status"></p>
        <ul id="batch-list" class="review-list"></ul>
        <div id="batch-settings" class="workspace-form">
          <label class="check-field"><input id="batch-existing" type="checkbox"> Capture already archived URLs again</label>
          <label>Collection <input id="batch-collection" maxlength="80" placeholder="Optional" list="batch-collections"></label>
          <datalist id="batch-collections"></datalist>
        </div>
        <div class="dialog-actions">
          <button id="batch-start" class="btn-filled" type="button">Start capture</button>
          <button id="batch-stop" class="btn-tonal btn-danger" type="button" hidden>Stop batch</button>
          <button id="batch-edit" class="btn-tonal" type="button">Edit URLs</button>
        </div>
      </div>
    </div>`);
  const form = document.getElementById('batch-form');
  const fileInput = document.getElementById('bookmark-file');
  const source = document.getElementById('batch-urls');
  const status = document.getElementById('batch-form-status');
  source.value = batchSource;
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      const urls = extractBookmarkUrls(await file.text());
      if (!urls.length) throw new Error('No web links found in this bookmarks file.');
      source.value = urls.join('\n');
      status.textContent = urls.length > 200 ? `Loaded ${urls.length} links. Trim the list to 200 URLs for this batch.` : `Loaded ${urls.length} links.`;
    } catch (err) {
      status.textContent = err.message;
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const urls = source.value.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
    if (!urls.length || urls.length > 200) {
      status.textContent = 'Enter between 1 and 200 URLs per batch.';
      return;
    }
    const submit = form.querySelector('button');
    submit.disabled = true;
    status.textContent = 'Checking URLs…';
    try {
      const { items } = await apiJson('/api/archive/preview', jsonPost({ urls }));
      if (!form.isConnected) return;
      batchSource = source.value;
      batch = { items, status: 'preview', includeExisting: false, collection: '', stop: false, jobId: null };
      if (!dialogOverlay.hidden) showBatchDialog();
    } catch (err) {
      status.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });
  const existing = document.getElementById('batch-existing');
  const collection = document.getElementById('batch-collection');
  existing.checked = batch?.includeExisting || false;
  collection.value = batch?.collection || '';
  document.getElementById('batch-collections').replaceChildren(
    ...[...new Set(timelineEntries.map((entry) => entry.collection).filter(Boolean))].sort().map((name) => new Option(name, name))
  );
  existing.addEventListener('change', () => {
    batch.includeExisting = existing.checked;
    renderBatchResults();
  });
  collection.addEventListener('input', () => { batch.collection = collection.value; });
  document.getElementById('batch-start').addEventListener('click', runBatch);
  document.getElementById('batch-stop').addEventListener('click', stopBatch);
  document.getElementById('batch-edit').addEventListener('click', () => {
    batch = null;
    showBatchDialog();
    document.getElementById('batch-urls').focus();
  });
  renderBatchResults();
}

batchButton.addEventListener('click', showBatchDialog);

function batchCandidates() {
  return batch.items.filter((entry) => entry.status === 'new' || (entry.status === 'existing' && batch.includeExisting));
}

function renderBatchResults() {
  const list = document.getElementById('batch-list');
  if (!batch || !list) return;
  const preview = batch.status === 'preview';
  const running = batch.status === 'running';
  document.getElementById('batch-settings').hidden = !preview;
  const start = document.getElementById('batch-start');
  start.hidden = !preview;
  const stop = document.getElementById('batch-stop');
  stop.hidden = !running;
  stop.disabled = batch.stop;
  const edit = document.getElementById('batch-edit');
  edit.hidden = running;
  edit.textContent = preview ? 'Edit URLs' : 'Start a new batch';
  const ready = preview ? batchCandidates().length : 0;
  start.disabled = !ready;
  start.textContent = ready === 1 ? 'Capture 1 page' : `Capture ${ready} pages`;
  const completed = batch.items.filter((entry) => ['done', 'reused'].includes(entry.status)).length;
  const errors = batch.items.filter((entry) => entry.status === 'failed' || entry.warning).length;
  document.getElementById('batch-summary').textContent = preview ? `${ready} of ${batch.items.length} ready to capture`
    : `${completed} captured or reused · ${errors} with errors${running ? ' · In progress' : batch.stop ? ' · Stopped' : ' · Complete'}`;
  list.innerHTML = batch.items.map((item) => `
    <li><strong>${escapeHtml(item.url || item.input)}</strong>
    <small>${batchStatusLabels[item.status]}${item.detail ? ` · ${escapeHtml(item.detail)}` : ''}</small></li>`).join('');
}

function waitForBatchCapture(jobId, onProgress) {
  return new Promise((resolve, reject) => {
    const events = new EventSource(`/api/archive/${encodeURIComponent(jobId)}/events`);
    events.addEventListener('progress', ({ data }) => {
      const event = JSON.parse(data);
      if (event.type === 'stage') onProgress(event.label);
      if (event.type === 'queued') onProgress('Queued');
      if (event.type === 'verification') onProgress(event.status === 'opened'
        ? 'Complete verification in the browser window' : 'Verification complete');
    });
    events.addEventListener('done', ({ data }) => {
      events.close();
      resolve(JSON.parse(data));
    });
    events.addEventListener('stopped', () => {
      events.close();
      resolve(null);
    });
    events.addEventListener('error', ({ data }) => {
      events.close();
      reject(new Error(data ? JSON.parse(data).error : 'Lost connection to the capture job.'));
    });
  });
}

async function stopBatch() {
  batch.stop = true;
  renderBatchResults();
  if (!batch.jobId) return;
  try {
    await apiJson(`/api/archive/${encodeURIComponent(batch.jobId)}/stop`, { method: 'POST' });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function runBatch() {
  if (batch?.status !== 'preview') return;
  const queue = batchCandidates();
  if (!queue.length) return;
  const captureNewVersion = batch.includeExisting;
  batch.status = 'running';
  for (const entry of queue) {
    entry.force = captureNewVersion && entry.status === 'existing';
    entry.status = 'waiting';
  }
  batchButton.setAttribute('aria-label', 'Bulk capture in progress');
  for (const entry of queue) {
    if (batch.stop) break;
    entry.status = 'running';
    renderBatchResults();
    try {
      const response = await apiJson('/api/archive', jsonPost({ url: entry.url, depth: 'page', force: entry.force }));
      let result = response;
      if (!response.deduped) {
        batch.jobId = response.jobId;
        const capture = waitForBatchCapture(batch.jobId, (detail) => {
          entry.detail = detail;
          renderBatchResults();
        });
        if (batch.stop) stopBatch();
        result = await capture;
      }
      entry.detail = '';
      entry.status = result ? result.deduped ? 'reused' : 'done' : 'stopped';
      if (batch.collection.trim() && result?.main?.dir) {
        try {
          await apiJson('/api/archives/organize', jsonPost({ dirs: [result.main.dir], action: 'move', value: batch.collection }));
        } catch (err) {
          entry.detail = 'Collection could not be assigned. ' + err.message;
          entry.warning = true;
        }
      }
    } catch (err) {
      entry.status = 'failed';
      entry.detail = err.message;
    } finally {
      batch.jobId = null;
    }
  }
  for (const entry of queue) if (entry.status === 'waiting') entry.status = 'stopped';
  batch.status = 'complete';
  batchButton.removeAttribute('aria-label');
  renderBatchResults();
  loadTimeline({ skeleton: false });
  showToast(batch.stop ? 'Batch stopped' : 'Batch finished');
}

const browserSaveButton = document.getElementById('browser-save-btn');
browserSaveButton.addEventListener('click', () => {
  showWorkspaceDialog('Save from your browser', `
    <div class="workspace-dialog-content">
      <p>Drag this bookmark to your bookmarks bar. Select it while viewing a web page to open TimeCapsule with the URL filled in.</p>
      <a id="capture-bookmark" class="btn-filled">Save to TimeCapsule</a>
      <p class="dialog-note">Review the URL and capture settings before saving.</p>
    </div>`);
  const destination = new URL('./', location.href);
  document.getElementById('capture-bookmark').href =
    `javascript:void(function(){location.assign(${JSON.stringify(destination.href + '?capture=')}+encodeURIComponent(location.href))}())`;
});

const incomingCapture = new URLSearchParams(location.search).get('capture');
if (incomingCapture && /^https?:\/\//i.test(incomingCapture)) {
  input.value = incomingCapture;
  input.dispatchEvent(new Event('input'));
  input.focus();
  const clean = new URL(location.href);
  clean.searchParams.delete('capture');
  history.replaceState(null, '', clean);
}

function openCommandPalette() {
  const commands = [
    { label: 'Archive a URL', icon: 'plus', run: () => input.focus() },
    { label: 'Search your archive', icon: 'search', run: () => searchInput.focus() },
    { label: 'Open Library', icon: 'library', run: () => snapshotsBtn.click() },
    { label: 'Open Collections', icon: 'folder', run: showCollections },
    { label: 'Open saved searches', icon: 'bookmark', run: showSavedSearches },
    { label: 'Bulk capture', icon: 'stack', run: showBatchDialog },
  ];
  showWorkspaceDialog('Quick actions', `
    <div class="workspace-dialog-content">
      <input class="command-input" id="command-input" type="search" placeholder="Type a command or paste a URL" aria-label="Filter quick actions">
      <div class="workspace-list" id="command-list"></div>
    </div>`);
  const query = document.getElementById('command-input');
  const list = document.getElementById('command-list');
  function updateCommands() {
    const text = query.value.trim();
    let options = commands.filter(({ label }) => label.toLowerCase().includes(text.toLowerCase()));
    if (/^https?:\/\//i.test(text)) {
      options = [{ label: 'Use this URL for capture', icon: 'plus', run: () => {
        input.value = text;
        input.dispatchEvent(new Event('input'));
        input.focus();
      } }];
    } else if (text && !options.length) {
      options = [{ label: `Search for “${text}”`, icon: 'search', run: () => {
        searchInput.value = text;
        searchInput.focus();
        queueSearch();
      } }];
    }
    list.replaceChildren(...options.map((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'workspace-list-item';
      button.innerHTML = icon(option.icon) + escapeHtml(option.label);
      button.addEventListener('click', () => {
        closeDialog();
        option.run();
      });
      return button;
    }));
  }
  query.addEventListener('input', updateCommands);
  query.addEventListener('keydown', (event) => {
    const first = list.querySelector('button');
    if (event.key === 'Enter') {
      event.preventDefault();
      first?.click();
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      first?.focus();
    }
  });
  updateCommands();
  query.focus();
}

document.getElementById('command-btn').addEventListener('click', openCommandPalette);
