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

  // Top 10 Albums
  albumTiles: Array.from({ length: 10 }, (_, i) => req(`album${i + 1}`))
};

// ---- Global state ----
let tracks = [];
let fixingRank = null;
let currentPlaying = { rank: null, tile: null };

const SESSION_KEY = "top25_queries_v8";
const TOAST_MS = 1500;

// ---- UI helpers ----
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
}
function togglePlay(rank, previewUrl, tile) {
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
}

// ---- iTunes Search ----
function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

async function itunesSearch(term, limit = 1) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&limit=${limit}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`iTunes search failed (${resp.status})`);
  const data = await resp.json();
  return data.results || [];
}

async function lookupBest(q) {
  const artist = (q.artist || "").split(",")[0].trim();
  const term = `${q.track} ${artist} ${q.album}`;
  const results = await itunesSearch(term, 1); // Get the top result only
  if (!results.length) return null;

  const best = results[0];
  const artwork = (best.artworkUrl100 || "").replace("100x100bb.jpg", "600x600bb.jpg");

  return {
    albumName: best.collectionName || q.album,
    artworkUrl: artwork || best.artworkUrl100 || "",
  };
}

// ---- Function to handle album tile clicks ----
async function handleAlbumClick(albumIndex) {
  const albumTile = els.albumTiles[albumIndex];

  // Searching for the album based on the index
  const result = await lookupBest({ track: "Unknown", artist: "Unknown", album: `Album ${albumIndex + 1}` });

  if (result) {
    albumTile.style.backgroundImage = `url(${result.artworkUrl})`;
    albumTile.classList.add("album-loaded");
    showToast(`Found album: ${result.albumName}`);
  } else {
    showToast("Album not found.");
  }
}

// ---- Initialize Event Listeners for Albums ----
els.albumTiles.forEach((tile, index) => {
  tile.addEventListener("click", () => handleAlbumClick(index));
});

// ---- CSV Parsing ----
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

// ---- Showcase Building ----
async function buildShowcase(queries) {
  // Implement the showcase rendering logic here
  setMode("showcase");
  showToast("Loading…");
  const resolved = await Promise.all(
    queries.map(async (q) => {
      try {
        return (await lookupBest(q)) || {};
      } catch {
        return {};
      }
    })
  );
  tracks = resolved.slice(0, 25);
  showToast("Ready.");
}

// ---- Handle Build Button Click ----
async function handleBuildClick() {
  console.log("[Top25] Build clicked");
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
  setMode("import");
  els.grid.innerHTML = "";
  setStatus("");
}

function handleBack() {
  stopAudio();
  setMode("import");
}

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
