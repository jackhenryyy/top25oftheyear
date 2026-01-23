console.log("[Top25] app.js loaded");

// ---- Safe getters (required vs optional) ----
function req(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[Top25] Missing required element id="${id}"`);
  return el;
}
function opt(id) {
  return document.getElementById(id);
}

// ---- Required elements (these MUST exist in index.html) ----
const els = {
  csvFile: req("csvFile"),
  buildBtn: req("buildBtn"),
  resetBtn: req("resetBtn"),
  backBtn: req("backBtn"),
  copyLinkBtn: req("copyLinkBtn"),
  status: req("status"),

  importHeader: req("importHeader"),
  importCard: req("importCard"),
  showcase: req("showcase"),

  grid: req("grid"),
  toast: req("toast"),
  audio: req("audio"),

  // Optional “fix” UI (won’t break if missing)
  fixModal: opt("fixModal"),
  closeFixBtn: opt("closeFixBtn"),
  fixTitle: opt("fixTitle"),
  fixQuery: opt("fixQuery"),
  fixApplyBtn: opt("fixApplyBtn"),
  fixHint: opt("fixHint"),

  songNameDisplay: req("songNameDisplay"), // Display song name while playing
};

// ---- Global state ----
let tracks = []; // Top 25 songs (1..25)
let albums = []; // Top 10 albums
let fixingRank = null;

let currentPlaying = { rank: null, tile: null };

// ---- Session ----
const SESSION_KEY = "top25_queries_v8";
const TOAST_MS = 1500;

// ---- Session helpers ----
function saveSession(queries) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(queries));
}

function setStatus(msg) {
  els.status.textContent = msg || "";
  console.log("[Top25] status:", msg || "");
}
function showToast(msg) {
  els.toast.textContent = msg || "";
  els.toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.add("hidden"), TOAST_MS);
}
function setMode(mode) {
  if (mode === "showcase") {
    els.importHeader.classList.add("hidden");
    els.importCard.classList.add("hidden");
    els.showcase.classList.remove("hidden");
  } else {
    els.importHeader.classList.remove("hidden");
    els.importCard.classList.remove("hidden");
    els.showcase.classList.add("hidden");
  }
}

// ---- Audio ----
function stopAudio() {
  els.audio.pause();
  els.audio.src = "";
  if (currentPlaying.tile) currentPlaying.tile.classList.remove("playing");
  currentPlaying = { rank: null, tile: null };
  els.songNameDisplay.textContent = ""; // Hide song name when stopped
}
function togglePlay(rank, previewUrl, tile, trackName) {
  if (currentPlaying.rank === rank) {
    stopAudio();
    showToast(`Stopped #${rank}`);
    return;
  }
  stopAudio();
  currentPlaying = { rank, tile };
  tile.classList.add("playing");
  els.audio.src = previewUrl;
  els.audio.play().catch(() => {});
  showToast(`Playing #${rank}`);
  els.songNameDisplay.textContent = trackName; // Show song name
}

// ---- CSV parsing ----
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("Failed to read file."));
    r.readAsText(file);
  });
}

function parseCSV(text) {
  if (!text) return [];
  text = text.replace(/^\uFEFF/, "");

  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"') { cell += '"'; i++; continue; }
    if (ch === '"') { inQuotes = !inQuotes; continue; }

    if (ch === "," && !inQuotes) { row.push(cell); cell = ""; continue; }

    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some(c => String(c).trim() !== "")) rows.push(row);
      row = [];
      continue;
    }

    cell += ch;
  }

  row.push(cell);
  if (row.some(c => String(c).trim() !== "")) rows.push(row);
  return rows;
}

function extractTop25QueriesFromCSV(csvText) {
  const rows = parseCSV(csvText);
  if (!rows.length) return [];

  const header = rows[0].map(h => String(h || "").replace(/\uFEFF/g,"").trim().toLowerCase());
  const findCol = (pred) => header.findIndex(pred);

  const trackIdx = findCol(h => h === "track name" || h.includes("track name"));
  const artistIdx = findCol(h =>
    h === "artist name(s)" || h === "artist name" || (h.includes("artist") && h.includes("name"))
  );
  const albumIdx = findCol(h => h === "album name" || h.includes("album name"));

  if (trackIdx === -1 || artistIdx === -1) return [];

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r] || [];
    const track = String(cells[trackIdx] || "").trim();
    const artist = String(cells[artistIdx] || "").trim();
    const album = albumIdx !== -1 ? String(cells[albumIdx] || "").trim() : "";
    if (track && artist) out.push({ track, artist, album });
  }
  return out.slice(0, 25);
}

// ---- iTunes search function ----
async function itunesSearch(term, limit = 15) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=${limit}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`iTunes search failed (${resp.status})`);
  const data = await resp.json();
  return data.results || [];
}

function score(q, r) {
  const qt = norm(q.track);
  const qa = norm((q.artist || "").split(",")[0]);
  const qalb = norm(q.album);

  const rt = norm(r.trackName);
  const ra = norm(r.artistName);
  const ralb = norm(r.collectionName);

  let s = 0;
  if (rt === qt) s += 20;
  if (rt.includes(qt)) s += 10;
  if (ra.includes(qa)) s += 14;

  if (qalb) {
    if (ralb === qalb) s += 18;
    if (ralb.includes(qalb) || qalb.includes(ralb)) s += 10;
  }

  const c = norm(r.collectionName);
  if (c.includes("dj mix")) s -= 40;
  if (c.includes("mix")) s -= 10;

  const ct = String(r.collectionType || "").toLowerCase();
  if (ct === "album") s += 10;

  return s;
}

async function lookupBest(q) {
  const artist = (q.artist || "").split(",")[0].trim();
  const term = q.album ? `${q.track} ${artist} ${q.album}` : `${q.track} ${artist}`;
  const results = await itunesSearch(term, 18);
  if (!results.length) return null;

  let best = results[0];
  let bestS = score(q, best);
  for (const r of results) {
    const sc = score(q, r);
    if (sc > bestS) { best = r; bestS = sc; }
  }

  const artwork = (best.artworkUrl100 || "").replace("100x100bb.jpg", "600x600bb.jpg");

  return {
    trackId: best.trackId || null,
    trackName: best.trackName || q.track,
    artistName: best.artistName || q.artist,
    albumName: best.collectionName || q.album,
    artworkUrl: artwork || best.artworkUrl100 || "",
    previewUrl: best.previewUrl || null,
    trackViewUrl: best.trackViewUrl || null,
  };
}

// ---- Diamond rows with “merge last single into bottom row” ----
function buildDiamondRows(total = 25) {
  const above = [];
  const below = [];

  let rank = 2;
  let size = 2;
  let placeAbove = true;

  while (rank <= total) {
    const remaining = total - rank + 1;
    const take = Math.min(size, remaining);

    const row = [];
    for (let i = 0; i < take; i++) row.push(rank++);

    if (placeAbove) above.push(row);
    else below.push(row);

    placeAbove = !placeAbove;
    if (placeAbove) size += 1;
  }

  // merge final [single] into last bottom row
  if (below.length >= 2) {
    const last = below[below.length - 1];
    const prev = below[below.length - 2];
    if (last.length === 1) {
      prev.push(last[0]);
      below.pop();
    }
  }

  return [...above.reverse(), [1], ...below];
}

// ---- Row scaling: gentle drop near center ----
function rowScale(dist) {
  const curve = [1.0, 0.92, 0.84, 0.76, 0.70, 0.64, 0.60];
  return curve[Math.min(dist, curve.length - 1)];
}

// ---- Render ----
function createTile(rank, meta) {
  const tile = document.createElement("div");
  tile.className = "tile" + (rank === 1 ? " hero" : "");
  tile.dataset.rank = String(rank);

  const img = document.createElement("img");
  img.src = meta.artworkUrl || "";
  img.alt = `${meta.trackName || ""} ${meta.artistName || ""}`.trim() || `#${rank}`;

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const span = document.createElement("span");
  span.textContent = String(rank);
  overlay.appendChild(span);

  tile.appendChild(img);
  tile.appendChild(overlay);

  tile.addEventListener("click", () => {
    if (!meta.previewUrl) {
      showToast(`#${rank}: no preview`);
      return;
    }
    togglePlay(rank, meta.previewUrl, tile, meta.trackName);
  });

  return tile;
}

function renderPyramid() {
  stopAudio();
  els.grid.innerHTML = "";

  const rows = buildDiamondRows(25);
  const centerIdx = rows.findIndex(r => r.length === 1 && r[0] === 1);

  rows.forEach((rowRanks, idx) => {
    const rowEl = document.createElement("div");
    rowEl.className = "pyrRow";

    const dist = Math.abs(idx - centerIdx);
    const scale = rowScale(dist);
    rowEl.style.transform = `scale(${scale})`;
    rowEl.style.transformOrigin = "center center";

    rowRanks.forEach(r => rowEl.appendChild(createTile(r, tracks[r - 1] || {})));
    els.grid.appendChild(rowEl);
  });
}

// ---- Share link (leave button functional even if you don’t use it) ----
async function copyShareLink() {
  const base = `${window.location.origin}${window.location.pathname}`;
  await navigator.clipboard.writeText(base);
  showToast("Copied base link (share encoding can be added back next).");
}

// ---- Build ----
async function buildShowcase(queries) {
  const reversed = [...queries].reverse();

  saveSession(queries);
  setMode("showcase");
  showToast("Loading…");

  const resolved = await Promise.all(
    reversed.map(async (q) => {
      try {
        return (await lookupBest(q)) || {};
      } catch {
        return {};
      }
    })
  );

  tracks = resolved.slice(0, 25);
  renderPyramid();
  showToast("Ready.");
}

async function handleBuildClick() {
  try {
    const file = els.csvFile.files?.[0];
    if (!file) { setStatus("Upload your CSV first."); return; }

    setStatus("Reading CSV…");
    const text = await readFileAsText(file);

    const queries = extractTop25QueriesFromCSV(text);
    if (!queries.length) { setStatus("Could not parse CSV columns."); return; }

    setStatus("");
    await buildShowcase(queries);
  } catch (e) {
    console.error(e);
    setStatus(e?.message || String(e));
  }
}

function handleReset() {
  stopAudio();
  els.csvFile.value = "";
  clearSession();
  setMode("import");
  els.grid.innerHTML = "";
  setStatus("");
}

function handleBack() {
  stopAudio();
  setMode("import");
}

// ---- Wire ----
function wire() {
  els.buildBtn.addEventListener("click", handleBuildClick);
  els.resetBtn.addEventListener("click", handleReset);
  els.backBtn.addEventListener("click", handleBack);
  els.copyLinkBtn.addEventListener("click", copyShareLink);
  els.audio.addEventListener("ended", stopAudio);
}

(function init() {
  try {
    wire();
    setMode("import");
    setStatus("Upload CSV and click Build Showcase.");
  } catch (e) {
    console.error(e);
    setStatus(e?.message || String(e));
  }
})();
