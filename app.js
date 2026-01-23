console.log("[Top25] app.js loaded");

function mustGet(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[Top25] Missing element id="${id}". Check index.html.`);
  return el;
}

const els = {
  csvFile: mustGet("csvFile"),
  buildBtn: mustGet("buildBtn"),
  resetBtn: mustGet("resetBtn"),
  backBtn: mustGet("backBtn"),
  copyLinkBtn: mustGet("copyLinkBtn"),
  status: mustGet("status"),

  importHeader: mustGet("importHeader"),
  importCard: mustGet("importCard"),
  showcase: mustGet("showcase"),

  grid: mustGet("grid"),
  toast: mustGet("toast"),
  audio: mustGet("audio"),

  fixModal: mustGet("fixModal"),
  closeFixBtn: mustGet("closeFixBtn"),
  fixTitle: mustGet("fixTitle"),
  fixQuery: mustGet("fixQuery"),
  fixApplyBtn: mustGet("fixApplyBtn"),
  fixHint: mustGet("fixHint"),
};

const SESSION_KEY = "top25_queries_v7";
const TOAST_MS = 1600;

let tracks = []; // length 25, index = rank-1
let fixingRank = null;

let currentPlaying = { rank: null, tile: null };

// ---------------- UI helpers ----------------
function setStatus(msg) {
  els.status.textContent = msg || "";
  console.log("[Top25] status:", msg || "");
}

function showToast(msg) {
  els.toast.textContent = msg || "";
  els.toast.classList.remove("hidden");
  window.clearTimeout(showToast._t);
  showToast._t = window.setTimeout(() => els.toast.classList.add("hidden"), TOAST_MS);
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

// ---------------- session ----------------
function saveSession(queries) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(queries));
}
function loadSession() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

// ---------------- CSV parse ----------------
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

  const col = (pred) => header.findIndex(pred);

  const trackIdx = col(h => h === "track name" || h.includes("track name"));
  const artistIdx = col(h =>
    h === "artist name(s)" || h === "artist name" || (h.includes("artist") && h.includes("name"))
  );
  const albumIdx = col(h => h === "album name" || h.includes("album name"));

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

// ---------------- iTunes matching ----------------
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\(\)\[\]\{\}]/g, " ")
    .replace(/feat\.|ft\./g, "feat")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function penaltyForBadCollection(name) {
  const n = norm(name);
  let p = 0;
  if (n.includes("dj mix")) p -= 40;
  if (n.includes("mix")) p -= 12;
  if (n.includes("playlist")) p -= 30;
  if (n.includes("karaoke") || n.includes("tribute")) p -= 50;
  return p;
}

function bonusForAlbumCollection(r) {
  const ct = String(r.collectionType || "").toLowerCase();
  let b = 0;
  if (ct === "album") b += 10;
  if (typeof r.trackNumber === "number") b += 3;
  return b;
}

function bonusAgainstSingles(q, r) {
  const qa = norm(q.album);
  if (!qa) return 0;
  const ra = norm(r.collectionName);
  if (!ra) return 0;
  if (ra === qa) return 16;
  if (ra.includes(qa) || qa.includes(ra)) return 10;
  return 0;
}

function scoreResult(q, r) {
  const qTrack = norm(q.track);
  const qArtist = norm((q.artist || "").split(",")[0].trim());
  const qAlbum = norm(q.album);

  const rTrack = norm(r.trackName);
  const rArtist = norm(r.artistName);
  const rAlbum = norm(r.collectionName);

  let s = 0;
  if (rTrack === qTrack) s += 14;
  if (rTrack.includes(qTrack)) s += 8;
  if (rArtist === qArtist) s += 14;
  if (rArtist.includes(qArtist)) s += 10;

  if (qAlbum) {
    if (rAlbum === qAlbum) s += 18;
    if (rAlbum.includes(qAlbum) || qAlbum.includes(rAlbum)) s += 12;
  }

  s += bonusForAlbumCollection(r);
  s += bonusAgainstSingles(q, r);
  s += penaltyForBadCollection(r.collectionName);

  return s;
}

async function itunesSearch(term, limit = 18) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=${limit}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`iTunes search failed (${resp.status})`);
  const data = await resp.json();
  return (data.results || []);
}

async function itunesLookupByIds(ids) {
  if (!ids.length) return [];
  const url = `https://itunes.apple.com/lookup?id=${ids.join(",")}&entity=song`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`iTunes lookup failed (${resp.status})`);
  const data = await resp.json();
  return (data.results || []).filter(r => r.wrapperType === "track");
}

async function lookupITunesBest(q) {
  const primaryArtist = (q.artist || "").split(",")[0].trim();

  const term1 = q.album ? `${q.track} ${primaryArtist} ${q.album}` : `${q.track} ${primaryArtist}`;
  let results = await itunesSearch(term1, 18);

  if (!results.length || scoreResult(q, results[0]) < 18) {
    const more = await itunesSearch(`${q.track} ${primaryArtist}`, 18);
    results = results.concat(more);
  }

  if (q.album) {
    const more = await itunesSearch(`${q.track} ${q.album}`, 18);
    results = results.concat(more);
  }

  if (!results.length) return null;

  let best = results[0];
  let bestScore = scoreResult(q, best);
  for (const r of results) {
    const sc = scoreResult(q, r);
    if (sc > bestScore) { best = r; bestScore = sc; }
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
    score: bestScore,
    raw: best,
  };
}

// ---------------- Share links (base36 IDs) ----------------
function toBase36(n){ return Number(n).toString(36); }
function fromBase36(s){ return parseInt(s, 36); }

function encodeIdsToHash(trackIds) {
  return `#ids=${trackIds.map(toBase36).join(".")}`;
}
function decodeIdsFromHash() {
  const hash = window.location.hash || "";
  if (!hash.startsWith("#ids=")) return null;
  const payload = hash.slice("#ids=".length).trim();
  if (!payload) return null;
  const parts = payload.split(".").filter(Boolean);
  const ids = parts.map(fromBase36).filter(n => Number.isFinite(n) && n > 0);
  return ids.length ? ids.slice(0,25) : null;
}

async function copyShareLinkFromCurrentTracks() {
  const ids = tracks.map(t => t.trackId).filter(Boolean);
  if (ids.length !== 25) {
    showToast("Some tracks are missing IDs. Fix them first, then share.");
    return;
  }
  const base = `${window.location.origin}${window.location.pathname}`;
  const url = `${base}${encodeIdsToHash(ids)}`;
  await navigator.clipboard.writeText(url);
  showToast("Share link copied.");
}

// ---------------- Pyramid rows builder ----------------
function buildDiamondRows(total = 25) {
  // Center row: [1]
  // Above: [2,3], Below: [4,5], Above: [6,7,8], Below: [9,10,11] ...
  // Merge a final single leftover into the last bottom row.

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

  // If the last bottom row is [single], merge into previous bottom row
  if (below.length >= 2) {
    const last = below[below.length - 1];
    const prev = below[below.length - 2];
    if (last.length === 1) {
      prev.push(last[0]); // now becomes 5
      below.pop();
    }
  }

  return [...above.reverse(), [1], ...below];
}

// Row-based scaling: bigger near the center, smaller as rows move away.
// Also: "rows with two need to be closer in size to #1" => use gentle drop for first 2 rows.
function rowScale(rowIndexFromCenter) {
  // rowIndexFromCenter: 0 = center row, 1 = immediate neighbor, 2 = next, ...
  // Gentle drop early, then more drop later.
  const curve = [1.00, 0.92, 0.84, 0.76, 0.70, 0.64, 0.60, 0.56, 0.52];
  const idx = Math.min(rowIndexFromCenter, curve.length - 1);
  return curve[idx];
}

function createTile(rank, meta) {
  const tile = document.createElement("div");
  tile.className = "tile" + (rank === 1 ? " hero" : "");
  tile.dataset.rank = String(rank);

  const img = document.createElement("img");
  img.src = meta.artworkUrl || "";
  img.alt = meta.trackName ? `${meta.trackName} — ${meta.artistName}` : `#${rank}`;

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const span = document.createElement("span");
  span.textContent = String(rank);
  overlay.appendChild(span);

  tile.appendChild(img);
  tile.appendChild(overlay);

  tile.addEventListener("click", (evt) => {
    if (evt.shiftKey) { openFixModal(rank); return; }
    if (!meta.previewUrl) {
      showToast(`#${rank}: missing preview. Shift+Click to fix.`);
      return;
    }
    togglePlay(rank, meta.previewUrl, tile);
  });

  tile.addEventListener("contextmenu", (evt) => {
    evt.preventDefault();
    openFixModal(rank);
  });

  return tile;
}

function renderPyramid() {
  stopAudio();
  els.grid.innerHTML = "";

  const rows = buildDiamondRows(25);

  // find center row index (the row that equals [1])
  const centerIdx = rows.findIndex(r => r.length === 1 && r[0] === 1);
  const maxDist = Math.max(centerIdx, rows.length - 1 - centerIdx);

  rows.forEach((rowRanks, idx) => {
    const rowEl = document.createElement("div");
    rowEl.className = "pyrRow";

    // scale based on distance from center
    const dist = Math.abs(idx - centerIdx);
    const scale = rowScale(dist);

    rowEl.style.setProperty("--rowScale", String(scale));
    // Apply scaling to row via transform so items shrink together and stay centered
    rowEl.style.transform = `scale(${scale})`;
    rowEl.style.transformOrigin = "center center";

    for (const r of rowRanks) {
      const meta = tracks[r - 1];
      rowEl.appendChild(createTile(r, meta));
    }

    els.grid.appendChild(rowEl);
  });
}

// ---------------- Fix modal ----------------
function extractTrackId(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);

  const m1 = s.match(/[?&]i=(\d+)/);
  if (m1) return Number(m1[1]);

  const m2 = s.match(/\/id(\d+)/);
  if (m2) return Number(m2[1]);

  return null;
}

function openFixModal(rank) {
  fixingRank = rank;
  els.fixTitle.textContent = `Fix #${rank} (paste iTunes track link or ID)`;
  els.fixHint.textContent = "Paste an iTunes track URL (with ?i=123...) or a numeric trackId, then click Apply.";
  els.fixQuery.value = "";
  els.fixModal.classList.remove("hidden");
  els.fixModal.setAttribute("aria-hidden", "false");
  els.fixQuery.focus();
}

function closeFixModal() {
  fixingRank = null;
  els.fixModal.classList.add("hidden");
  els.fixModal.setAttribute("aria-hidden", "true");
}

async function applyFixFromPaste() {
  const rank = fixingRank;
  if (!rank) return;

  const id = extractTrackId(els.fixQuery.value);
  if (!id) {
    els.fixHint.textContent = "Could not detect a trackId. Paste an iTunes track link that includes ?i=#### or a numeric ID.";
    return;
  }

  els.fixHint.textContent = "Looking up…";
  try {
    const res = await itunesLookupByIds([id]);
    const r = res[0];
    if (!r) {
      els.fixHint.textContent = "Lookup returned nothing. Double-check the ID/link.";
      return;
    }

    const artwork = (r.artworkUrl100 || "").replace("100x100bb.jpg", "600x600bb.jpg");

    tracks[rank - 1] = {
      trackId: r.trackId || id,
      trackName: r.trackName || tracks[rank - 1]?.trackName || `#${rank}`,
      artistName: r.artistName || tracks[rank - 1]?.artistName || "",
      albumName: r.collectionName || tracks[rank - 1]?.albumName || "",
      artworkUrl: artwork || tracks[rank - 1]?.artworkUrl || "",
      previewUrl: r.previewUrl || null,
      trackViewUrl: r.trackViewUrl || null,
      raw: r,
    };

    renderPyramid();
    closeFixModal();
    showToast(`Fixed #${rank}`);
  } catch (e) {
    els.fixHint.textContent = "Lookup failed. Try again.";
  }
}

// ---------------- Build ----------------
async function buildShowcase(queries) {
  stopAudio();
  els.grid.innerHTML = "";

  // Keep this if you want #1 = last in playlist
  const reversed = [...queries].reverse();

  saveSession(queries);
  setMode("showcase");
  showToast("Loading…");

  const resolved = await Promise.all(
    reversed.map(async (q) => {
      try {
        const m = await lookupITunesBest(q);
        return m || {
          trackId: null,
          trackName: q.track,
          artistName: q.artist,
          albumName: q.album,
          artworkUrl: "",
          previewUrl: null,
          trackViewUrl: null,
        };
      } catch {
        return {
          trackId: null,
          trackName: q.track,
          artistName: q.artist,
          albumName: q.album,
          artworkUrl: "",
          previewUrl: null,
          trackViewUrl: null,
        };
      }
    })
  );

  tracks = resolved.slice(0, 25);
  renderPyramid();

  const missing = tracks.filter(t => !t.previewUrl).length;
  if (missing) showToast(`Loaded with ${missing} missing previews. Shift+Click to fix.`);
  else showToast("Ready.");
}

async function handleBuildClick() {
  try {
    const file = els.csvFile.files?.[0];
    if (!file) { setStatus("Upload your CSV first."); return; }

    setStatus("Reading CSV…");
    const text = await readFileAsText(file);
    const queries = extractTop25QueriesFromCSV(text);

    if (!queries.length) {
      setStatus("Could not parse Track Name + Artist Name(s) from this CSV.");
      return;
    }

    setStatus("");
    await buildShowcase(queries);
  } catch (e) {
    console.error(e);
    setStatus(String(e?.message || e));
  }
}

function handleReset() {
  stopAudio();
  els.csvFile.value = "";
  clearSession();
  window.location.hash = "";
  setMode("import");
  els.grid.innerHTML = "";
  setStatus("");
  els.toast.classList.add("hidden");
}

function handleBack() {
  stopAudio();
  setMode("import");
}

// ---------------- Events / init ----------------
function wireEvents() {
  // Prevent double-binding bugs
  els.buildBtn.onclick = null;
  els.resetBtn.onclick = null;
  els.backBtn.onclick = null;
  els.copyLinkBtn.onclick = null;

  els.buildBtn.addEventListener("click", () => handleBuildClick());
  els.resetBtn.addEventListener("click", handleReset);
  els.backBtn.addEventListener("click", handleBack);

  els.copyLinkBtn.addEventListener("click", async () => {
    try { await copyShareLinkFromCurrentTracks(); }
    catch { showToast("Copy failed (clipboard blocked)."); }
  });

  els.audio.addEventListener("ended", () => stopAudio());

  els.closeFixBtn.addEventListener("click", closeFixModal);
  els.fixModal.addEventListener("click", (e) => {
    if (e.target === els.fixModal) closeFixModal();
  });

  els.fixApplyBtn.addEventListener("click", () => applyFixFromPaste());
  els.fixQuery.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyFixFromPaste();
    if (e.key === "Escape") closeFixModal();
  });
}

(async function init() {
  wireEvents();

  // load from share link if present
  const idsFromHash = decodeIdsFromHash();
  if (idsFromHash?.length) {
    setMode("showcase");
    setStatus("");
    showToast("Loading from share link…");

    const res = await itunesLookupByIds(idsFromHash);
    const byId = new Map(res.map(r => [r.trackId, r]));

    tracks = idsFromHash.map((id) => {
      const r = byId.get(id);
      const artwork = r ? (r.artworkUrl100 || "").replace("100x100bb.jpg", "600x600bb.jpg") : "";
      return {
        trackId: id,
        trackName: r?.trackName || `Track ${id}`,
        artistName: r?.artistName || "",
        albumName: r?.collectionName || "",
        artworkUrl: artwork || r?.artworkUrl100 || "",
        previewUrl: r?.previewUrl || null,
        trackViewUrl: r?.trackViewUrl || null,
        raw: r || null,
      };
    }).slice(0, 25);

    renderPyramid();
    showToast("Loaded from share link.");
    return;
  }

  // resume from session
  const saved = loadSession();
  if (saved?.length) {
    setStatus("");
    await buildShowcase(saved);
    return;
  }

  setMode("import");
  setStatus("Upload CSV and click Build Showcase.");
})();
