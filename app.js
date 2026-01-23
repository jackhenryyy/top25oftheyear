console.log("[Top25] app.js loaded");

const $ = (id) => document.getElementById(id);

const els = {
  csvFile: $("csvFile"),
  buildBtn: $("buildBtn"),
  resetBtn: $("resetBtn"),
  backBtn: $("backBtn"),
  copyLinkBtn: $("copyLinkBtn"),
  downloadArtBtn: $("downloadArtBtn"),
  status: $("status"),
  importHeader: $("importHeader"),
  importCard: $("importCard"),
  showcase: $("showcase"),
  stage: $("stage"),
  audio: $("audio"),
  toast: $("toast"),

  fixModal: $("fixModal"),
  closeFixBtn: $("closeFixBtn"),
  fixTitle: $("fixTitle"),
  fixQuery: $("fixQuery"),
  fixSearchBtn: $("fixSearchBtn"),
  fixHint: $("fixHint"),
  fixResults: $("fixResults"),
};

const STORAGE_KEY = "top25_queries_v5";
const TOAST_MS = 1600;

let queriesSession = null;
let tracks = [];     // rank order (1..25)
let bubbles = [];
let rafId = null;

let currentPlaying = { rank: null, tile: null };

let cursor = { x: 0, y: 0, active: false };
let fixingRank = null;

// ---------- UI ----------
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

// ---------- NEW: Batch download album art ----------
function sanitizeFileName(name) {
  return String(name || "")
    .replace(/[\/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function blobToDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function fetchAsBlob(url) {
  const resp = await fetch(url, { mode: "cors" });
  if (!resp.ok) throw new Error(`Failed fetch (${resp.status})`);
  return await resp.blob();
}

async function downloadAlbumArtZip() {
  if (!window.JSZip) {
    showToast("JSZip failed to load. Refresh and try again.");
    return;
  }
  if (!tracks?.length) {
    showToast("No tracks loaded yet.");
    return;
  }

  // Only those with artwork
  const items = tracks
    .map((t, i) => ({ rank: i + 1, ...t }))
    .filter(t => t.artworkUrl);

  if (!items.length) {
    showToast("No artwork URLs found.");
    return;
  }

  els.downloadArtBtn.disabled = true;
  els.downloadArtBtn.textContent = "Downloading…";
  showToast("Downloading album art…");

  const zip = new JSZip();

  // Fetch sequentially to avoid hammering / being blocked
  let ok = 0;
  for (let i = 0; i < items.length; i++) {
    const t = items[i];
    try {
      const blob = await fetchAsBlob(t.artworkUrl);
      const ext = (blob.type && blob.type.includes("png")) ? "png" : "jpg";

      const fileBase =
        `${String(t.rank).padStart(2, "0")}` +
        ` - ${sanitizeFileName(t.artistName || "Unknown Artist")}` +
        ` - ${sanitizeFileName(t.trackName || "Unknown Track")}`;

      zip.file(`${fileBase}.${ext}`, blob);
      ok++;
      setStatus(`Album art: ${ok}/${items.length}`);
    } catch (e) {
      console.warn("[Top25] art download failed:", t.rank, t.artworkUrl, e);
    }
  }

  setStatus("");
  showToast(`Zipping ${ok}/${items.length} images…`);

  const zipBlob = await zip.generateAsync({ type: "blob" });
  blobToDownload(zipBlob, "top-25-album-art.zip");

  els.downloadArtBtn.disabled = false;
  els.downloadArtBtn.textContent = "Download Album Art (ZIP)";
  showToast("ZIP downloaded.");
}

// ---------- CSV ----------
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

  const headerRaw = rows[0].map(h => String(h || ""));
  const header = headerRaw.map(h => h.replace(/\uFEFF/g,"").trim().toLowerCase());

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

// ---------- iTunes lookup ----------
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

async function itunesSearch(term, limit = 15) {
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
  let results = await itunesSearch(term1, 15);

  if (!results.length || scoreResult(q, results[0]) < 18) {
    const more = await itunesSearch(`${q.track} ${primaryArtist}`, 15);
    results = results.concat(more);
  }

  if (q.album) {
    const more = await itunesSearch(`${q.track} ${q.album}`, 15);
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

// ---------- Share link v2: base36 IDs ----------
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

// ---------- Floating physics ----------
function rankToSizePx(rank) {
  const max = 340;
  const min = 110;
  const t = (rank - 1) / 24;
  const eased = Math.pow(t, 0.82);
  return Math.round(max - (max - min) * eased);
}

function createBubble(rank, meta) {
  const el = document.createElement("div");
  el.className = `bubble rank-${rank}`;
  el.dataset.rank = String(rank);

  const img = document.createElement("img");
  img.src = meta.artworkUrl || "";
  img.alt = meta.trackName || `#${rank}`;
  img.crossOrigin = "anonymous";

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const span = document.createElement("span");
  span.textContent = String(rank);
  overlay.appendChild(span);

  el.appendChild(img);
  el.appendChild(overlay);

  el.addEventListener("click", (evt) => {
    if (evt.shiftKey) {
      openFixModal(rank);
      return;
    }
    const b = bubbles.find(x => x.rank === rank);
    if (!b?.meta?.previewUrl) {
      showToast(`#${rank}: missing preview. Shift+Click to paste iTunes link.`);
      return;
    }
    togglePlay(rank, b.meta.previewUrl, el);
  });

  el.addEventListener("contextmenu", (evt) => {
    evt.preventDefault();
    openFixModal(rank);
  });

  return el;
}

function layoutInitialBubbles() {
  const rect = els.stage.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;

  for (let i = 0; i < bubbles.length; i++) {
    const b = bubbles[i];
    b.x = b.r + Math.random() * (W - 2*b.r);
    b.y = b.r + Math.random() * (H - 2*b.r);
    b.vx = (Math.random() - 0.5) * 0.4;
    b.vy = (Math.random() - 0.5) * 0.4;
  }
}

function attachCursorEvents() {
  els.stage.addEventListener("mousemove", (e) => {
    const rect = els.stage.getBoundingClientRect();
    cursor.x = e.clientX - rect.left;
    cursor.y = e.clientY - rect.top;
    cursor.active = true;
  });
  els.stage.addEventListener("mouseleave", () => {
    cursor.active = false;
  });
}

function stepPhysics() {
  const rect = els.stage.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;

  // slower + smoother + less jumpy
  const damping = 0.996;
  const wander = 0.006;
  const cursorForce = 0.05;
  const range = 220;
  const bubbleRepel = 0.35;
  const centerPull = 0.00025;

  for (const b of bubbles) {
    b.vx += (Math.random() - 0.5) * wander;
    b.vy += (Math.random() - 0.5) * wander;

    b.vx += (W/2 - b.x) * centerPull;
    b.vy += (H/2 - b.y) * centerPull;

    if (cursor.active) {
      const dx = b.x - cursor.x;
      const dy = b.y - cursor.y;
      const dist = Math.sqrt(dx*dx + dy*dy) || 1;
      if (dist < range) {
        const k = (1 - dist / range) * cursorForce;
        b.vx += (dx / dist) * k;
        b.vy += (dy / dist) * k;
      }
    }

    b.vx *= damping;
    b.vy *= damping;

    const maxSpeed = 1.1;
    const sp = Math.sqrt(b.vx*b.vx + b.vy*b.vy) || 0;
    if (sp > maxSpeed) {
      b.vx = (b.vx / sp) * maxSpeed;
      b.vy = (b.vy / sp) * maxSpeed;
    }
  }

  for (let i = 0; i < bubbles.length; i++) {
    for (let j = i + 1; j < bubbles.length; j++) {
      const a = bubbles[i];
      const c = bubbles[j];
      const dx = c.x - a.x;
      const dy = c.y - a.y;
      const dist = Math.sqrt(dx*dx + dy*dy) || 1;

      const minDist = (a.r + c.r) * 0.90;
      if (dist < minDist) {
        const overlap = (minDist - dist) / minDist;
        const push = overlap * bubbleRepel * 2.0;
        const ux = dx / dist;
        const uy = dy / dist;
        a.vx -= ux * push;
        a.vy -= uy * push;
        c.vx += ux * push;
        c.vy += uy * push;
      }
    }
  }

  for (const b of bubbles) {
    b.x += b.vx;
    b.y += b.vy;

    const pad = b.r + 10;
    if (b.x < pad) { b.x = pad; b.vx *= -0.5; }
    if (b.x > W - pad) { b.x = W - pad; b.vx *= -0.5; }
    if (b.y < pad) { b.y = pad; b.vy *= -0.5; }
    if (b.y > H - pad) { b.y = H - pad; b.vy *= -0.5; }

    b.el.style.transform = `translate(${(b.x - b.r).toFixed(1)}px, ${(b.y - b.r).toFixed(1)}px)`;
  }

  rafId = requestAnimationFrame(stepPhysics);
}

function startPhysics() {
  stopPhysics();
  rafId = requestAnimationFrame(stepPhysics);
}
function stopPhysics() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

// ---------- Fix modal ----------
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
    const replaced = {
      trackId: r.trackId || id,
      trackName: r.trackName || tracks[rank - 1].trackName,
      artistName: r.artistName || tracks[rank - 1].artistName,
      albumName: r.collectionName || tracks[rank - 1].albumName,
      artworkUrl: artwork || tracks[rank - 1].artworkUrl,
      previewUrl: r.previewUrl || null,
      trackViewUrl: r.trackViewUrl || null,
      score: 999,
      raw: r,
    };

    tracks[rank - 1] = replaced;

    const b = bubbles.find(x => x.rank === rank);
    if (b) {
      b.meta = replaced;
      const img = b.el.querySelector("img");
      img.src = replaced.artworkUrl || "";
    }

    closeFixModal();
    showToast(`Fixed #${rank}`);
  } catch (e) {
    els.fixHint.textContent = "Lookup failed. Try again.";
  }
}

// ---------- Build ----------
async function buildFromTracksOnly(trackMetas) {
  stopAudio();
  stopPhysics();
  els.stage.innerHTML = "";

  tracks = trackMetas.slice(0,25);

  bubbles = [];
  for (let i = 0; i < tracks.length; i++) {
    const rank = i + 1;
    const meta = tracks[i];

    const size = rankToSizePx(rank);
    const el = createBubble(rank, meta);
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;

    els.stage.appendChild(el);
    bubbles.push({ rank, meta, el, x:0, y:0, vx:0, vy:0, r: size/2 });
  }

  attachCursorEvents();
  layoutInitialBubbles();
  startPhysics();

  const missing = tracks.filter(t => !t.previewUrl).length;
  if (missing) showToast(`Loaded with ${missing} missing previews. Shift+Click a tile to fix.`);
  else showToast("Ready.");
}

async function buildShowcase(queries) {
  stopAudio();
  stopPhysics();
  els.stage.innerHTML = "";

  const reversed = [...queries].reverse();
  queriesSession = queries;

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
          score: 0,
          raw: null,
        };
      } catch {
        return {
          trackId: null,
          trackName: q.track,
          artistName: q.artist,
          albumName: q.album,
          artworkUrl: "",
          previewUrl: null,
          score: 0,
          raw: null,
        };
      }
    })
  );

  await buildFromTracksOnly(resolved);
}

async function handleBuildClick() {
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
}

function handleReset() {
  stopAudio();
  stopPhysics();
  els.csvFile.value = "";
  clearSession();
  window.location.hash = "";
  setMode("import");
  els.stage.innerHTML = "";
  setStatus("");
  els.toast.classList.add("hidden");
}

function handleBack() {
  stopAudio();
  setMode("import");
}

// ---------- Events / init ----------
function wireEvents() {
  els.buildBtn.addEventListener("click", () => {
    handleBuildClick().catch(e => setStatus(String(e?.message || e)));
  });
  els.resetBtn.addEventListener("click", handleReset);
  els.backBtn.addEventListener("click", handleBack);

  els.copyLinkBtn.addEventListener("click", async () => {
    try {
      await copyShareLinkFromCurrentTracks();
    } catch {
      showToast("Copy failed (clipboard blocked).");
    }
  });

  els.downloadArtBtn.addEventListener("click", async () => {
    try {
      await downloadAlbumArtZip();
    } catch {
      showToast("Album art download failed.");
    }
  });

  els.audio.addEventListener("ended", () => stopAudio());

  els.closeFixBtn.addEventListener("click", closeFixModal);
  els.fixModal.addEventListener("click", (e) => {
    if (e.target === els.fixModal) closeFixModal();
  });

  els.fixSearchBtn.textContent = "Apply";
  els.fixSearchBtn.addEventListener("click", () => applyFixFromPaste());

  els.fixQuery.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyFixFromPaste();
    if (e.key === "Escape") closeFixModal();
  });

  window.addEventListener("resize", () => {
    if (!bubbles.length) return;
    layoutInitialBubbles();
  });
}

(async function init() {
  wireEvents();

  const idsFromHash = decodeIdsFromHash();
  if (idsFromHash?.length) {
    setMode("showcase");
    setStatus("");
    showToast("Loading from share link…");

    const res = await itunesLookupByIds(idsFromHash);
    const byId = new Map(res.map(r => [r.trackId, r]));

    const metas = idsFromHash.map((id) => {
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
        score: 999,
        raw: r || null,
      };
    });

    await buildFromTracksOnly(metas);
    showToast("Loaded from share link.");
    return;
  }

  const saved = loadSession();
  if (saved?.length) {
    setStatus("");
    await buildShowcase(saved);
    return;
  }

  setMode("import");
  setStatus("Upload CSV and click Build Showcase.");
})();
