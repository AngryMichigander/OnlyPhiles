(() => {
  "use strict";

  const CRIME_LABELS = {
    csam: "CSAM",
    assault: "Sexual Assault",
    trafficking: "Trafficking",
    solicitation: "Solicitation",
    "statutory-rape": "Statutory Rape",
    grooming: "Grooming",
    enablement: "Enablement",
  };

  const LEVEL_LABELS = {
    federal: "Federal",
    state: "State",
    local: "Local",
    "party-official": "Party Official",
    adjacent: "Adjacent",
  };

  const US_STATES = [
    "AL","AK","AZ","AR","CA","CO","CT","DC","DE","FL","GA","HI","ID","IL","IN",
    "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH",
    "NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT",
    "VT","VA","WA","WV","WI","WY",
  ];

  let filters = {
    status: "all",
    levels: [],
    state: "all",
    crimeTypes: [],
    inOffice: "all",
    search: "",
    sort: "name",
  };

  let currentPage = 1;
  let totalPages = 1;
  let totalResults = 0;
  let fetchController = null;

  // DOM refs
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  async function init() {
    // Load stats
    fetchStats();

    buildFilterUI();
    loadFiltersFromURL();
    fetchAndRender();
    window.addEventListener("popstate", () => {
      loadFiltersFromURL();
      fetchAndRender();
    });
  }

  async function fetchStats() {
    try {
      const resp = await fetch("/api/stats");
      if (!resp.ok) throw new Error("Failed to load stats");
      const stats = await resp.json();
      $("#stat-total").textContent = stats.total;
      $("#stat-convicted").textContent = stats.convicted;
      $("#stat-charged").textContent = stats.charged;
      $("#stat-alleged").textContent = stats.alleged;
    } catch {
      // Stats will show dashes on error
    }
  }

  function buildAPIParams() {
    const params = new URLSearchParams();

    if (filters.search) params.set("q", filters.search);
    if (filters.status !== "all") params.set("status", filters.status);
    if (filters.levels.length) params.set("level", filters.levels.join(","));
    if (filters.state !== "all") params.set("state", filters.state);
    if (filters.crimeTypes.length) params.set("crimeType", filters.crimeTypes.join(","));
    if (filters.inOffice === "yes") params.set("stillInOffice", "true");
    else if (filters.inOffice === "no") params.set("stillInOffice", "false");

    // Map frontend sort values to API sort values
    const sortMap = { name: "name", status: "status", year: "offense_year", state: "state" };
    params.set("sort", sortMap[filters.sort] || "name");
    if (filters.sort === "year") params.set("order", "desc");

    params.set("page", String(currentPage));
    params.set("limit", "50");

    return params;
  }

  async function fetchAndRender() {
    if (fetchController) fetchController.abort();
    fetchController = new AbortController();

    const grid = $("#cards-grid");
    grid.innerHTML = `<div class="loading-spinner" style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--text-dim)">Loading...</div>`;

    try {
      const params = buildAPIParams();
      const resp = await fetch(`/api/people?${params}`, { signal: fetchController.signal });
      if (!resp.ok) throw new Error("Failed to load data");
      const data = await resp.json();

      totalResults = data.total;
      totalPages = data.pages;
      currentPage = data.page;

      renderResults(data.results, data.total);
      renderPagination();
    } catch (err) {
      if (err.name === "AbortError") return;
      grid.innerHTML = `<div class="no-results" style="grid-column:1/-1"><h3>Error loading data</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  function renderResults(results, total) {
    $("#results-count").textContent = `Showing ${results.length} of ${total}`;

    const grid = $("#cards-grid");
    if (results.length === 0) {
      grid.innerHTML = `
        <div class="no-results" style="grid-column: 1/-1">
          <h3>No results found</h3>
          <p>Try adjusting your filters.</p>
        </div>`;
      return;
    }

    grid.innerHTML = results.map(renderCard).join("");
  }

  function renderPagination() {
    let paginationEl = $("#pagination");
    if (!paginationEl) {
      paginationEl = document.createElement("div");
      paginationEl.id = "pagination";
      paginationEl.className = "pagination";
      $("#cards-grid").after(paginationEl);
    }

    if (totalPages <= 1) {
      paginationEl.innerHTML = "";
      return;
    }

    paginationEl.innerHTML = `
      <button class="pagination-btn" id="page-prev" ${currentPage <= 1 ? "disabled" : ""}>← Prev</button>
      <span class="pagination-info">Page ${currentPage} of ${totalPages}</span>
      <button class="pagination-btn" id="page-next" ${currentPage >= totalPages ? "disabled" : ""}>Next →</button>
    `;

    $("#page-prev").addEventListener("click", () => {
      if (currentPage > 1) {
        currentPage--;
        saveFiltersToURL();
        fetchAndRender();
      }
    });

    $("#page-next").addEventListener("click", () => {
      if (currentPage < totalPages) {
        currentPage++;
        saveFiltersToURL();
        fetchAndRender();
      }
    });
  }

  function buildFilterUI() {
    // State dropdown
    const stateSelect = $("#filter-state");
    US_STATES.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      stateSelect.appendChild(opt);
    });

    // Crime type checkboxes
    const crimeGroup = $("#filter-crime-types");
    Object.entries(CRIME_LABELS).forEach(([val, label]) => {
      const lbl = document.createElement("label");
      lbl.innerHTML = `<input type="checkbox" value="${val}" data-filter="crime"> ${label}`;
      crimeGroup.appendChild(lbl);
    });

    // Event: status tabs
    $$("[data-status-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setActiveTab("[data-status-tab]", btn.dataset.statusTab);
        filters.status = btn.dataset.statusTab;
        currentPage = 1;
        applyAndRender();
      });
    });

    // Event: level checkboxes
    $$("[data-filter='level']").forEach((cb) => {
      cb.addEventListener("change", () => {
        filters.levels = $$("[data-filter='level']:checked").map((c) => c.value);
        currentPage = 1;
        applyAndRender();
      });
    });

    // Event: state
    stateSelect.addEventListener("change", () => {
      filters.state = stateSelect.value;
      currentPage = 1;
      applyAndRender();
    });

    // Event: crime types
    crimeGroup.addEventListener("change", () => {
      filters.crimeTypes = $$("[data-filter='crime']:checked").map((c) => c.value);
      currentPage = 1;
      applyAndRender();
    });

    // Event: in office
    $$("[data-office-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setActiveTab("[data-office-tab]", btn.dataset.officeTab);
        filters.inOffice = btn.dataset.officeTab;
        currentPage = 1;
        applyAndRender();
      });
    });

    // Event: search
    let searchTimeout;
    $("#filter-search").addEventListener("input", (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        filters.search = e.target.value.trim();
        currentPage = 1;
        applyAndRender();
      }, 300);
    });

    // Event: sort
    $("#filter-sort").addEventListener("change", (e) => {
      filters.sort = e.target.value;
      currentPage = 1;
      applyAndRender();
    });

    // Mobile toggle
    $(".mobile-filter-toggle").addEventListener("click", () => {
      $(".filters").classList.toggle("open");
    });

    // Clickable card filters (delegated)
    document.addEventListener("click", (e) => {
      const el = e.target.closest(".clickable-filter");
      if (!el) return;

      if (el.dataset.filterStatus) {
        filters.status = el.dataset.filterStatus;
        setActiveTab("[data-status-tab]", el.dataset.filterStatus);
      }
      if (el.dataset.filterState) {
        filters.state = el.dataset.filterState;
        const sel = $("#filter-state");
        if (sel) sel.value = el.dataset.filterState;
      }
      if (el.dataset.filterCrime) {
        if (!filters.crimeTypes.includes(el.dataset.filterCrime)) {
          filters.crimeTypes.push(el.dataset.filterCrime);
          const cb = $(`[data-filter='crime'][value="${el.dataset.filterCrime}"]`);
          if (cb) cb.checked = true;
        }
      }
      if (el.dataset.filterLevel) {
        if (!filters.levels.includes(el.dataset.filterLevel)) {
          filters.levels.push(el.dataset.filterLevel);
          const cb = $(`[data-filter='level'][value="${el.dataset.filterLevel}"]`);
          if (cb) cb.checked = true;
        }
      }
      currentPage = 1;
      applyAndRender();
    });
  }

  function setActiveTab(selector, value) {
    $$(selector).forEach((btn) => {
      const dataKey = Object.keys(btn.dataset).find((k) => k.endsWith("Tab"));
      const isActive = dataKey && btn.dataset[dataKey] === value;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    });
  }

  function applyAndRender() {
    saveFiltersToURL();
    fetchAndRender();
  }

  function renderCardOffice(person) {
    const parts = [];
    if (person.office) parts.push(escapeHtml(person.office));
    if (person.state) {
      parts.push(`<span class="clickable-filter card-state" data-filter-state="${escapeAttr(person.state)}" title="Filter by ${escapeAttr(person.state)}">${escapeHtml(person.state)}</span>`);
    }
    if (person.level && person.level !== "adjacent") {
      parts.push(`<span class="clickable-filter" data-filter-level="${escapeAttr(person.level)}" title="Filter by ${escapeAttr(LEVEL_LABELS[person.level] || person.level)}">${escapeHtml(LEVEL_LABELS[person.level] || person.level)}</span>`);
    }
    return parts.join(" &middot; ");
  }

  function renderCardYears(person) {
    const years = [];
    if (person.eventDate) {
      const d = new Date(person.eventDate + 'T00:00:00');
      const label = person.status === 'convicted' ? 'Sentenced' : person.status === 'charged' ? 'Charged' : 'Reported';
      years.push(`<span>${label}: ${d.toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'})}</span>`);
    } else if (person.offenseYear) {
      years.push(`<span>Offense: ${person.offenseYear}</span>`);
    }
    if (person.convictionYear && !person.eventDate) {
      years.push(`<span>Convicted: ${person.convictionYear}</span>`);
    }
    return years.join("");
  }

  function renderCard(person) {
    const statusBadge = `<span class="badge badge-${escapeAttr(person.status)} clickable-filter" data-filter-status="${escapeAttr(person.status)}" title="Filter by ${escapeAttr(person.status)}">${escapeHtml(person.status)}</span>`;
    const officeBadge = person.stillInOffice === true
      ? `<span class="badge badge-in-office">Still in Office</span>`
      : "";

    const tags = (person.crimeTypes || [])
      .map((ct) => `<span class="tag clickable-filter" data-filter-crime="${escapeAttr(ct)}" title="Filter by ${escapeAttr(CRIME_LABELS[ct] || ct)}">${escapeHtml(CRIME_LABELS[ct] || ct)}</span>`)
      .join("");

    const sources = (person.sources || [])
      .filter((url) => isSafeUrl(url))
      .map((url, i) => `<a href="${escapeAttr(url)}" target="_blank" rel="noopener">[${i + 1}]</a>`)
      .join("");

    return `
      <article class="card">
        <div class="card-header">
          <h2 class="card-name">${escapeHtml(person.name)}</h2>
          <span>${statusBadge}${officeBadge}</span>
        </div>
        <div class="card-office">${renderCardOffice(person)}</div>
        <div class="card-tags">${tags}</div>
        <div class="card-summary">${escapeHtml(person.summary || "")}</div>
        <div class="card-footer">
          <div class="card-years">${renderCardYears(person)}</div>
          <div class="card-sources">Sources: ${sources}</div>
        </div>
      </article>`;
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/`/g, "&#96;");
  }

  function isSafeUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  // URL param sync
  function saveFiltersToURL() {
    const params = new URLSearchParams();
    if (filters.status !== "all") params.set("status", filters.status);
    if (filters.levels.length) params.set("levels", filters.levels.join(","));
    if (filters.state !== "all") params.set("state", filters.state);
    if (filters.crimeTypes.length) params.set("crimes", filters.crimeTypes.join(","));
    if (filters.inOffice !== "all") params.set("office", filters.inOffice);
    if (filters.search) params.set("q", filters.search);
    if (filters.sort !== "name") params.set("sort", filters.sort);
    if (currentPage > 1) params.set("page", String(currentPage));

    const qs = params.toString();
    const url = qs ? `?${qs}` : window.location.pathname;
    history.replaceState(null, "", url);
  }

  function loadFiltersFromURL() {
    const params = new URLSearchParams(window.location.search);

    filters.status = params.get("status") || "all";
    filters.levels = params.get("levels") ? params.get("levels").split(",") : [];
    filters.state = params.get("state") || "all";
    filters.crimeTypes = params.get("crimes") ? params.get("crimes").split(",") : [];
    filters.inOffice = params.get("office") || "all";
    filters.search = params.get("q") || "";
    filters.sort = params.get("sort") || "name";
    currentPage = parseInt(params.get("page") || "1", 10);

    // Sync UI
    setActiveTab("[data-status-tab]", filters.status);

    $$("[data-filter='level']").forEach((cb) => {
      cb.checked = filters.levels.includes(cb.value);
    });

    const stateSelect = $("#filter-state");
    if (stateSelect) stateSelect.value = filters.state;

    $$("[data-filter='crime']").forEach((cb) => {
      cb.checked = filters.crimeTypes.includes(cb.value);
    });

    setActiveTab("[data-office-tab]", filters.inOffice);

    const searchInput = $("#filter-search");
    if (searchInput) searchInput.value = filters.search;

    const sortSelect = $("#filter-sort");
    if (sortSelect) sortSelect.value = filters.sort;
  }

  document.addEventListener("DOMContentLoaded", init);
})();
