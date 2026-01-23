console.log("[Top25] app.js loaded");

const els = {
  csvFile: document.getElementById("csvFile"),
  buildBtn: document.getElementById("buildBtn"),
  resetBtn: document.getElementById("resetBtn"),
  backBtn: document.getElementById("backBtn"),
  copyLinkBtn: document.getElementById("copyLinkBtn"),
  status: document.getElementById("status"),
  importHeader: document.getElementById("importHeader"),
  importCard: document.getElementById("importCard"),
  showcase: document.getElementById("showcase"),
  grid: document.getElementById("grid"),
  audio: document.getElementById("audio"),
  toast: document.getElementById("toast"),
};

const STORAGE_KEY = "top25_queries_v2";
const TOAST_MS = 1800;

let currentPlaying = { rank: null, previewUrl: null, tileEl: null };

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

function stopAudio() {
  els.audio.pause();
  els.audio.src = "";
  currentPlaying = { rank: null, previewUrl: null, tileEl: null };
}

function togglePlay(rank, previewUrl, tileEl) {
  // If clicking the same track again, stop.
  if (currentPlaying.rank === rank) {
    stopAudio();
    showToast(`Stopped #${rank}`);
    tileEl?.classList.remove("is-playing");
    return;
  }

  // Start new
  if (currentPlaying.tileEl) currentPlaying.tileEl.classList.remove("is-playing");
  currentPlaying = { rank, previewUrl, tileEl };

  els.audio.pause();
  els.audio.src = previewUrl;
  els.audio.play().then(() => {
    tileEl?.classList.add("is-playing");
  }).catch((e) => {
    console.warn("[Top25] audio.play blocked:", e);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("Failed to read file."));
    r.readAsText(file);
  });
}

// ---------- CSV ----------
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

  const headerRaw = rows[0].map(h => String(h || ""));
  const header = headerRaw.map(h =>
    h.replace(/\uFEFF/g, "").trim().toLowerCase()
  );

  const findCol = (pred) => header.findIndex(pred);

  const trackNameIdx = findCol(h => h === "track name" || h.includes("track name"));
  const artistIdx = findCol(h =>
    h === "artist name(s)" ||
    h === "artist name" ||
    (h.includes("artist") && h.includes("name"))
  );
  const albumIdx = findCol(h => h === "album name" || h.includes("album name"));

  if (trackNameIdx === -1 || artistIdx === -1) {
    console.warn("[Top25] header row:", headerRaw);
    return [];
  }

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r] || [];
    const track = String(cells[trackNameIdx] || "").trim();
    const artist = String(cells[artistIdx] || "").trim();
    const album = albumIdx !== -1 ? String(cells[albumIdx] || "").trim() : "";
    if (track && artist) out.push({ track, artist, album });
  }

  return out.slice(0, 25);
}

// ---------- iTunes matching ----------
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\(\)\[\]\{\}]/g, " ")
    .replace(/feat\.|ft\./g, "feat")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesLoose(hay, needle) {
  const h = norm(hay);
  const n = norm(needle);
  if (!h || !n) return false;
  return h.includes(n);
}

async function itunesSearch(term, limit = 12) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=${limit}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`iTunes search failed (${resp.status})`);
  const data = await resp.json();
  return (data.results || []);
}

function scoreResult(q, r) {
  const qTrack = norm(q.track);
  const qArtist = norm((q.artist || "").split(",")[0].trim());
  const qAlbum = norm(q.album);

  const rTrack = norm(r.trackName);
  const rArtist = norm(r.artistName);
  const rAlbum = norm(r.collectionName);

  let s = 0;

  // track match
  if (rTrack === qTrack) s += 10;
  if (rTrack.includes(qTrack)) s += 6;
  if (qTrack.includes(rTrack)) s += 4;

  // artist match
  if (rArtist === qArtist) s += 10;
  if (rArtist.includes(qArtist)) s += 7;

  // album tie-breaker (huge for fixing wrong versions)
  if (qAlbum) {
    if (rAlbum === qAlbum) s += 10;
    if (rAlbum.includes(qAlbum) || qAlbum.includes(rAlbum)) s += 6;
  }

  // penalize karaoke/tribute
  if (rArtist.includes("karaoke") || rArtist.includes("tribute")) s -= 15;

  return s;
}

async function lookupITunesBest(q) {
  const primaryArtist = (q.artist || "").split(",")[0].trim();

  // First pass: include album if we have it
  const term1 = q.album
    ? `${q.track} ${primaryArtist} ${q.album}`
    : `${q.track} ${primaryArtist}`;

  let results = await itunesSearch(term1, 12);

  // If first pass yields weak results, try a simpler term without album
  if (!results.length) {
    const term2 = `${q.track} ${primaryArtist}`;
    results = await itunesSearch(term2, 12);
  }

  if (!results.length) return null;

  // pick best by score
  let best = results[0];
  let bestScore = scoreResult(q, best);

  for (const r of results) {
    const sc = scoreResult(q, r);
    if (sc > bestScore) { best = r; bestScore = sc; }
  }

  // If score is still low, attempt a third pass: track+album (sometimes artist strings differ)
  if (bestScore < 14 && q.album) {
    const term3 = `${q.track} ${q.album}`;
    const more = await itunesSearch(term3, 12);
    for (const r of more) {
      const sc = scoreResult(q, r);
      if (sc > bestScore) { best = r; bestScore = sc; }
    }
  }

  const artwork = (best.artworkUrl100 || "").replace("100x100bb.jpg", "600x600bb.jpg");

  return {
    trackName: best.trackName || q.track,
    artistName: best.artistName || q.artist,
    albumName: best.collectionName || q.album,
    artworkUrl: artwork || best.artworkUrl100 || "",
    previewUrl: best.previewUrl || null,
    score: bestScore,
  };
}

// ---------- Overlay contrast ----------
async function computeLuminance(imgEl) {
  const w = 32, h = 32;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(imgEl, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 10) continue;
    r += data[i]; g += data[i + 1]; b += data[i + 2];
    n++;
  }
  if (!n) return 0.5;
  r /= n; g /= n; b /= n;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// ---------- Share link ----------
function encodeListToHash(queries) {
  // Keep small: only fields needed to reproduce list
  const compact = queries.map(q => ({ t: q.track, a: q.artist, al: q.album || "" }));
  const json = JSON.stringify(compact);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return `#list=${b64}`;
}

function decodeListFromHash() {
  const hash = window.location.hash || "";
  if (!hash.startsWith("#list=")) return null;

  const b64 = hash.slice("#list=".length);
  try {
    const json = decodeURIComponent(escape(atob(b64)));
    const compact = JSON.parse(json);
    if (!Array.isArray(compact)) return null;
    return compact.slice(0, 25).map(x => ({
      track: x.t || "",
      artist: x.a || "",
      album: x.al || "",
    })).filter(x => x.track && x.artist);
  } catch (e) {
    console.warn("[Top25] failed to decode hash list", e);
    return null;
  }
}

async function copyShareLink(queries) {
  const base = `${window.location.origin}${window.location.pathname}`;
  const url = `${base}${encodeListToHash(queries)}`;
  await navigator.clipboard.writeText(url);
  showToast("Share link copied.");
}

// ---------- UI ----------
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

function saveSession(queries) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(queries));
}

function loadSession() {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function clearSession() {
  sessionStorage.removeItem(STORAGE_KEY);
}

// Create tile
function createTile(rank, meta) {
  const tile = document.createElement("button");
  tile.className = `tile rank-${rank}`;
  tile.type = "button";

  const img = document.createElement("img");
  img.alt = meta?.trackName ? meta.trackName : `#${rank}`;
  img.src = meta?.artworkUrl || "";
  img.crossOrigin = "anonymous";

  const overlay = document.createElement("div");
  overlay.className = "overlay";

  const num = document.createElement("span");
  num.textContent = String(rank);
  overlay.appendChild(num);

  tile.appendChild(img);
  tile.appendChild(overlay);

  img.addEventListener("load", async () => {
    try {
      const lum = await computeLuminance(img);
      const isLight = lum > 0.55;
      overlay.style.background = isLight ? "rgba(0,0,0,.45)" : "rgba(255,255,255,.18)";
      num.style.color = isLight ? "rgba(255,255,255,.95)" : "rgba(10,10,14,.95)";
      num.style.borderColor = isLight ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.22)";
    } catch {
      overlay.style.background = "rgba(0,0,0,.55)";
      num.style.color = "rgba(255,255,255,.95)";
    }
  });

  // Click toggles play/stop
  tile.addEventListener("click", () => {
    if (!meta?.previewUrl) {
      showToast(`#${rank}: No preview found (different version / no iTunes preview)`);
      return;
    }
    togglePlay(rank, meta.previewUrl, tile);
    showToast(`#${rank}: ${meta.trackName} — ${meta.artistName}`);
  });

  return tile;
}

async function buildShowcase(queries) {
  stopAudio();
  els.grid.innerHTML = "";

  // Reverse order: playlist row 25 becomes Showcase #1
  const reversed = [...queries].reverse();

  // Persist and switch mode
  saveSession(queries);
  setMode("showcase");

  showToast("Loading previews...");

  // Fetch iTunes metadata (parallel)
  const metas = await Promise.all(
    reversed.map(async (q, idx) => {
      try {
        const m = await lookupITunesBest(q);
        if (!m || !m.previewUrl) {
          console.warn("[Top25] preview missing", idx + 1, q, m);
        }
        return m || {
          trackName: q.track,
          artistName: q.artist,
          albumName: q.album,
          artworkUrl: "",
          previewUrl: null,
          score: 0,
        };
      } catch (e) {
        console.warn("[Top25] lookup failed", idx + 1, q, e);
        return {
          trackName: q.track,
          artistName: q.artist,
          albumName: q.album,
          artworkUrl: "",
          previewUrl: null,
          score: 0,
        };
      }
    })
  );

  // Render as a full-width dense grid
  for (let i = 0; i < metas.length; i++) {
    const rank = i + 1;
    const tile = createTile(rank, metas[i]);
    els.grid.appendChild(tile);
  }

  showToast("Ready. Click any cover to play. Click again to stop.");
}

async function handleBuildClick() {
  const file = els.csvFile.files?.[0];
  if (!file) {
    setStatus("Upload your CSV first.");
    return;
  }

  setStatus("Reading CSV...");
  const text = await readFileAsText(file);
  const queries = extractTop25QueriesFromCSV(text);

  if (!queries.length) {
    setStatus("Could not parse Track Name + Artist Name(s) from this CSV.");
    return;
  }

  setStatus("");
  await buildShowcase(queries);
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

// ---------- Wiring ----------
function wireEvents() {
  els.buildBtn.addEventListener("click", () => {
    handleBuildClick().catch(e => setStatus(String(e?.message || e)));
  });
  els.resetBtn.addEventListener("click", handleReset);
  els.backBtn.addEventListener("click", handleBack);

  els.copyLinkBtn.addEventListener("click", async () => {
    const queries = loadSession();
    if (!queries?.length) {
      showToast("Build a showcase first.");
      return;
    }
    try {
      await copyShareLink(queries);
    } catch {
      showToast("Copy failed. Your browser may block clipboard access.");
    }
  });

  // When audio ends, clear playing state
  els.audio.addEventListener("ended", () => {
    if (currentPlaying.tileEl) currentPlaying.tileEl.classList.remove("is-playing");
    currentPlaying = { rank: null, previewUrl: null, tileEl: null };
  });
}

(async function init() {
  wireEvents();

  // Priority: share link in hash
  const fromHash = decodeListFromHash();
  if (fromHash?.length) {
    setStatus("");
    await buildShowcase(fromHash);
    showToast("Loaded from share link.");
    return;
  }

  // Otherwise: session restore
  const saved = loadSession();
  if (saved?.length) {
    setStatus("");
    await buildShowcase(saved);
    return;
  }

  setMode("import");
  setStatus("Upload CSV and click Build Showcase.");
})();
