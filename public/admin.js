let currentId = null;
let currentPage = 1;
let totalPages = 1;

const $ = id => document.getElementById(id);

async function apiFetch(path, method = 'GET', body = null) {
  const opts = { method, credentials: 'include' };
  if (body !== null) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

const apiGet = (path) => apiFetch(path);
const apiPatch = (path, body) => apiFetch(path, 'PATCH', body);
const apiPut = (path, body) => apiFetch(path, 'PUT', body);

async function search(page = 1) {
  const q = $('admin-search').value.trim();
  const list = $('admin-results');
  collapseEditPanel();
  list.innerHTML = '<li class="no-results">Loading…</li>';
  try {
    const params = new URLSearchParams({ limit: '50', page: String(page) });
    if (q) params.set('q', q);
    const data = await apiGet(`/api/admin/people?${params}`);
    currentPage = data.page;
    totalPages = data.pages;
    updatePagination();
    if (!data.results.length) {
      list.innerHTML = `<li class="no-results">${q ? 'No results.' : 'No entries in database.'}</li>`;
      return;
    }
    list.innerHTML = data.results.map(p => `
      <li data-id="${p.id}">
        <span>${escHtml(p.name)}</span>
        <span class="meta">${escHtml(p.state || '')} · ${escHtml(p.status)}</span>
      </li>`).join('');
  } catch(e) {
    const li = document.createElement('li');
    li.className = 'no-results';
    li.textContent = `Error: ${e.message}`;
    list.innerHTML = '';
    list.appendChild(li);
    totalPages = 1;
    updatePagination();
  }
}

function updatePagination() {
  const pag = $('pagination');
  if (totalPages <= 1) {
    pag.style.display = 'none';
    return;
  }
  pag.style.display = 'flex';
  $('page-info').textContent = `Page ${currentPage} of ${totalPages}`;
  $('prev-btn').disabled = currentPage <= 1;
  $('next-btn').disabled = currentPage >= totalPages;
}

async function loadPerson(id, li) {
  // If clicking the same row, collapse it
  if (currentId === id) {
    collapseEditPanel();
    return;
  }

  // Remove any existing inline edit panel
  collapseEditPanel();

  currentId = id;
  li.classList.add('active');

  // Create and insert edit panel after the clicked li
  const panel = $('edit-panel');
  panel.classList.add('visible');
  li.after(panel);

  $('save-btn').disabled = true;
  $('save-status').textContent = 'Loading…';
  $('save-status').className = 'save-status';
  $('edit-title').textContent = 'Loading…';

  try {
    const p = await apiGet(`/api/admin/people/${id}`);
    $('edit-title').textContent = p.name;
    $('f-name').value = p.name || '';
    $('f-state').value = p.state || '';
    $('f-status').value = p.status || 'alleged';
    $('f-level').value = p.level || 'adjacent';
    $('f-office').value = p.office || '';
    $('f-event-date').value = p.eventDate || '';
    $('f-conviction-year').value = p.convictionYear || '';
    $('f-summary').value = p.summary || '';
    renderSources(p.sources || []);
    $('save-status').textContent = '';
    $('save-btn').disabled = false;
  } catch(e) {
    $('save-status').textContent = 'Error loading: ' + e.message;
    $('save-status').className = 'save-status err';
    $('edit-title').textContent = 'Load Failed';
  }
}

function collapseEditPanel() {
  currentId = null;
  const panel = $('edit-panel');
  panel.classList.remove('visible');
  // Move panel back to its parking spot
  $('edit-panel-parking').appendChild(panel);
  // Remove active class from all rows
  document.querySelectorAll('#admin-results li.active').forEach(el => el.classList.remove('active'));
}

function renderSources(sources) {
  const list = $('sources-list');
  list.innerHTML = sources.map((url, i) => `
    <div class="source-item">
      <input type="url" value="${escHtml(url)}" data-idx="${i}">
      <button class="remove-source-btn">Remove</button>
    </div>`).join('');
}

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Event delegation for dynamic elements
$('admin-results').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) loadPerson(li.dataset.id, li);
});

$('edit-panel').addEventListener('click', (e) => {
  // Handle remove source button
  const removeBtn = e.target.closest('.remove-source-btn');
  if (removeBtn) {
    removeBtn.closest('.source-item').remove();
    return;
  }
  // Handle add source button
  if (e.target.closest('#add-source-btn')) {
    const div = document.createElement('div');
    div.className = 'source-item';
    div.innerHTML = `<input type="url" placeholder="https://…"><button class="remove-source-btn">Remove</button>`;
    $('sources-list').appendChild(div);
    div.querySelector('input').focus();
  }
});

$('save-btn').addEventListener('click', async () => {
  if (!currentId) return;
  const btn = $('save-btn');
  const status = $('save-status');
  btn.disabled = true;
  status.textContent = 'Saving…';
  status.className = 'save-status';

  const newName = $('f-name').value.trim();

  try {
    // Save person fields
    await apiPatch(`/api/admin/people/${currentId}`, {
      name: newName,
      state: $('f-state').value.trim(),
      status: $('f-status').value,
      level: $('f-level').value,
      office: $('f-office').value.trim(),
      event_date: $('f-event-date').value.trim() || null,
      conviction_year: $('f-conviction-year').value ? parseInt($('f-conviction-year').value) : null,
      summary: $('f-summary').value.trim(),
    });
  } catch(e) {
    status.textContent = 'Error saving fields: ' + e.message;
    status.className = 'save-status err';
    btn.disabled = false;
    return;
  }

  // Update UI after fields saved successfully
  const activeLi = document.querySelector(`#admin-results li[data-id="${CSS.escape(currentId)}"]`);
  if (activeLi) activeLi.querySelector('span').textContent = newName;
  $('edit-title').textContent = newName;

  try {
    // Save sources
    const sourceInputs = $('sources-list').querySelectorAll('input[type="url"]');
    const sources = [...sourceInputs].map(i => i.value.trim()).filter(Boolean);
    await apiPut(`/api/admin/people/${currentId}/sources`, { sources });

    status.textContent = '✓ Saved!';
    status.className = 'save-status ok';
  } catch(e) {
    status.textContent = 'Fields saved, but sources failed: ' + e.message;
    status.className = 'save-status err';
  } finally {
    btn.disabled = false;
  }
});

$('admin-search').addEventListener('keydown', e => {
  if (e.key === 'Enter') search(1);
});
$('admin-search-btn').addEventListener('click', () => search(1));
$('prev-btn').addEventListener('click', () => { if (currentPage > 1) search(currentPage - 1); });
$('next-btn').addEventListener('click', () => { if (currentPage < totalPages) search(currentPage + 1); });

// Load all entries on page load
search();
