console.log("[Top25] app.js loaded");

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);

const els = {
  csvFile: $("csvFile"),
  buildBtn: $("buildBtn"),
  resetBtn: $("resetBtn"),
  backBtn: $("backBtn"),
  copyLinkBtn: $("copyLinkBtn"),
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

const STORAGE_KEY = "top25_queries_v3";
const TOAST_MS = 1800;

// ---------- State ----------
let queriesSession = null;            // original CSV parsed queries (25)
let tracks = [];                      // resolved iTunes metas in rank order (1..25)
let bubbles = [];                     // physics objects
let rafId = null;

let currentPlaying = { rank: null, tile: null };

let cursor = { x: 0, y: 0, active: false };

let fixingRank = null;               // which rank is being manually fixed

// ---------- UI helpers ----------
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

  if (trackIdx === -1 || artistIdx === -1) {
    console.warn("[Top25] header row:", headerRaw);
    return [];
  }

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

// ---------- iTunes matching (album-first) ----------
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
  // strongly penalize mixes/playlists/collections that often show up as "DJ Mix"
  if (n.includes("dj mix")) p -= 30;
  if (n.includes("mix")) p -= 10;
  if (n.includes("radio")) p -= 8;
  if (n.includes("playlist")) p -= 20;
  if (n.includes("karaoke") || n.includes("tribute")) p -= 40;
  return p;
}

function bonusForAlbumCollection(r) {
  // iTunes has collectionType sometimes; if present and "Album", boost
  const ct = String(r.collectionType || "").toLowerCase();
  let b = 0;
  if (ct === "album") b += 10;
  // prefer album tracks with a trackNumber
  if (typeof r.trackNumber === "number") b += 4;
  return b;
}

function bonusAgainstSingles(q, r) {
  // If the query album exists and result collection name matches, boost.
  const qa = norm(q.album);
  if (!qa) return 0;
  const ra = norm(r.collectionName);
  if (!ra) return 0;
  if (ra === qa) return 14;
  if (ra.includes(qa) || qa.includes(ra)) return 9;
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

  // Track match
  if (rTrack === qTrack) s += 14;
  if (rTrack.includes(qTrack)) s += 8;
  if (qTrack.includes(rTrack)) s += 4;

  // Artist match
  if (rArtist === qArtist) s += 14;
  if (rArtist.includes(qArtist)) s += 10;

  // Album match (big)
  if (qAlbum) {
    if (rAlbum === qAlbum) s += 18;
    if (rAlbum.includes(qAlbum) || qAlbum.includes(rAlbum)) s += 12;
  }

  // Prefer album collections, penalize mixes/playlists
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

async function lookupITunesBest(q) {
  const primaryArtist = (q.artist || "").split(",")[0].trim();

  // First pass: track + artist + album
  const term1 = q.album ? `${q.track} ${primaryArtist} ${q.album}` : `${q.track} ${primaryArtist}`;
  let results = await itunesSearch(term1, 15);

  // Second pass: track + artist (more recall)
  if (!results.length || (results.length && scoreResult(q, results[0]) < 18)) {
    const term2 = `${q.track} ${primaryArtist}`;
    const more = await itunesSearch(term2, 15);
    results = results.concat(more);
  }

  // Third pass: track + album (sometimes artist string mismatches)
  if (q.album) {
    const term3 = `${q.track} ${q.album}`;
    const more = await itunesSearch(term3, 15);
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
    trackName: best.trackName || q.track,
    artistName: best.artistName || q.artist,
    albumName: best.collectionName || q.album,
    artworkUrl: artwork || best.artworkUrl100 || "",
    previewUrl: best.previewUrl || null,
    trackViewUrl: best.trackViewUrl || null,
    collectionViewUrl: best.collectionViewUrl || null,
    score: bestScore,
    raw: best,
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
    return compact.slice(0, 25)
      .map(x => ({ track: x.t || "", artist: x.a || "", album: x.al || "" }))
      .filter(x => x.track && x.artist);
  } catch { return null; }
}
async function copyShareLink(queries) {
  const base = `${window.location.origin}${window.location.pathname}`;
  const url = `${base}${encodeListToHash(queries)}`;
  await navigator.clipboard.writeText(url);
  showToast("Share link copied.");
}

// ---------- Floating physics ----------
function rankToSizePx(rank) {
  // rank 1 biggest, rank 25 smallest
  // you asked #1 at least 2x bigger than before; we’ll go chunky:
  // #1 ~ 260px, #25 ~ 110px (responsive-ish)
  const max = 280;
  const min = 110;
  const t = (rank - 1) / 24; // 0..1
  // ease-out so top ranks are notably bigger
  const eased = Math.pow(t, 0.75);
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

  img.addEventListener("load", async () => {
    try {
      const lum = await computeLuminance(img);
      const isLight = lum > 0.55;
      overlay.style.background = isLight ? "rgba(0,0,0,.45)" : "rgba(255,255,255,.18)";
      span.style.color = isLight ? "rgba(255,255,255,.95)" : "rgba(10,10,14,.95)";
      span.style.borderColor = isLight ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.22)";
    } catch {}
  });

  // Click: play/stop
  el.addEventListener("click", (evt) => {
    // Shift+click opens fix
    if (evt.shiftKey) {
      openFixModal(rank);
      return;
    }

    if (!meta.previewUrl) {
      showToast(`#${rank}: no preview found. Shift+Click to fix.`);
      return;
    }
    togglePlay(rank, meta.previewUrl, el);
    showToast(`#${rank}: ${meta.trackName} — ${meta.artistName}`);
  });

  // Right click also opens fix
  el.addEventListener("contextmenu", (evt) => {
    evt.preventDefault();
    openFixModal(rank);
  });

  return el;
}

function layoutInitialBubbles() {
  const rect = els.stage.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;

  // Place in a loose spiral to start, then physics settles it
  const spiralGap = 22;
  for (let i = 0; i < bubbles.length; i++) {
    const b = bubbles[i];
    const angle = i * 0.75;
    const radius = spiralGap * Math.sqrt(i) * 2.2;
    b.x = cx + Math.cos(angle) * radius;
    b.y = cy + Math.sin(angle) * radius;
    b.vx = (Math.random() - 0.5) * 0.8;
    b.vy = (Math.random() - 0.5) * 0.8;
  }
}

function stepPhysics() {
  const rect = els.stage.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;

  // Tunables
  const damping = 0.985;
  const wander = 0.06;              // water drift
  const cursorForce = 0.55;         // how much cursor pushes/pulls
  const bubbleRepel = 0.85;         // collision repulsion
  const centerPull = 0.0025;        // gentle keep-in-bounds

  // cursor in stage coords
  const cx = cursor.x;
  const cy = cursor.y;

  // Update velocities
  for (const b of bubbles) {
    // water wander
    b.vx += (Math.random() - 0.5) * wander;
    b.vy += (Math.random() - 0.5) * wander;

    // gentle pull toward center so they don't all drift to edges
    b.vx += (W/2 - b.x) * centerPull;
    b.vy += (H/2 - b.y) * centerPull;

    // cursor interaction (repel when close)
    if (cursor.active) {
      const dx = b.x - cx;
      const dy = b.y - cy;
      const dist = Math.sqrt(dx*dx + dy*dy) || 1;
      const range = 220; // influence radius
      if (dist < range) {
        const k = (1 - dist / range) * cursorForce;
        b.vx += (dx / dist) * k * 2.2;
        b.vy += (dy / dist) * k * 2.2;
      }
    }

    // damping
    b.vx *= damping;
    b.vy *= damping;
  }

  // Bubble-bubble repulsion to reduce overlap
  for (let i = 0; i < bubbles.length; i++) {
    for (let j = i + 1; j < bubbles.length; j++) {
      const a = bubbles[i];
      const c = bubbles[j];
      const dx = c.x - a.x;
      const dy = c.y - a.y;
      const dist = Math.sqrt(dx*dx + dy*dy) || 1;

      const minDist = (a.r + c.r) * 0.92;
      if (dist < minDist) {
        const overlap = (minDist - dist) / minDist;
        const push = overlap * bubbleRepel * 2.2;
        const ux = dx / dist;
        const uy = dy / dist;
        a.vx -= ux * push;
        a.vy -= uy * push;
        c.vx += ux * push;
        c.vy += uy * push;
      }
    }
  }

  // Integrate + bounds bounce
  for (const b of bubbles) {
    b.x += b.vx;
    b.y += b.vy;

    const pad = b.r + 10;
    if (b.x < pad) { b.x = pad; b.vx *= -0.8; }
    if (b.x > W - pad) { b.x = W - pad; b.vx *= -0.8; }
    if (b.y < pad) { b.y = pad; b.vy *= -0.8; }
    if (b.y > H - pad) { b.y = H - pad; b.vy *= -0.8; }

    // Apply DOM transform
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

// ---------- Manual fix modal ----------
function openFixModal(rank) {
  fixingRank = rank;
  const meta = tracks[rank - 1];
  const q = queriesSession ? queriesSession[25 - rank] : null; // remember: reversed ranking
  const defaultQuery = q ? `${q.track} ${q.artist}` : `${meta.trackName} ${meta.artistName}`;

  els.fixTitle.textContent = `Fix #${rank}`;
  els.fixQuery.value = defaultQuery;
  els.fixHint.textContent = "Tip: include artist + album keywords if needed. Click a result to replace.";
  els.fixResults.innerHTML = "";
  els.fixModal.classList.remove("hidden");
  els.fixModal.setAttribute("aria-hidden", "false");

  // auto-search immediately
  runFixSearch().catch(() => {});
}

function closeFixModal() {
  fixingRank = null;
  els.fixModal.classList.add("hidden");
  els.fixModal.setAttribute("aria-hidden", "true");
}

function renderFixResults(results) {
  els.fixResults.innerHTML = "";
  if (!results.length) {
    els.fixHint.textContent = "No results found. Try a different query (add album name, remove punctuation).";
    return;
  }

  for (const r of results) {
    const card = document.createElement("div");
    card.className = "resultCard";

    const top = document.createElement("div");
    top.className = "resultTop";

    const img = document.createElement("img");
    img.src = (r.artworkUrl100 || "").replace("100x100bb.jpg","200x200bb.jpg");
    img.alt = r.trackName || "result";

    const meta = document.createElement("div");
    meta.className = "resultMeta";

    const t = document.createElement("div");
    t.className = "resultTrack";
    t.textContent = r.trackName || "";

    const a = document.createElement("div");
    a.className = "resultArtist";
    a.textContent = r.artistName || "";

    const al = document.createElement("div");
    al.className = "resultAlbum";
    al.textContent = r.collectionName || "";

    meta.appendChild(t);
    meta.appendChild(a);
    meta.appendChild(al);

    top.appendChild(img);
    top.appendChild(meta);
    card.appendChild(top);

    card.addEventListener("click", () => {
      if (!fixingRank) return;

      const artwork = (r.artworkUrl100 || "").replace("100x100bb.jpg", "600x600bb.jpg");
      const replaced = {
        trackName: r.trackName || tracks[fixingRank - 1].trackName,
        artistName: r.artistName || tracks[fixingRank - 1].artistName,
        albumName: r.collectionName || tracks[fixingRank - 1].albumName,
        artworkUrl: artwork || tracks[fixingRank - 1].artworkUrl,
        previewUrl: r.previewUrl || null,
        trackViewUrl: r.trackViewUrl || null,
        collectionViewUrl: r.collectionViewUrl || null,
        score: 999,
        raw: r,
      };

      applyManualReplacement(fixingRank, replaced);
      closeFixModal();
      showToast(`Replaced #${fixingRank}`);
    });

    els.fixResults.appendChild(card);
  }
}

async function runFixSearch() {
  const q = els.fixQuery.value.trim();
  if (!q) return;
  els.fixHint.textContent = "Searching…";
  els.fixResults.innerHTML = "";

  const results = await itunesSearch(q, 25);

  // sort results to prefer album-like collections even in manual search
  results.sort((a, b) => {
    const pa = penaltyForBadCollection(a.collectionName) + bonusForAlbumCollection(a);
    const pb = penaltyForBadCollection(b.collectionName) + bonusForAlbumCollection(b);
    return pb - pa;
  });

  renderFixResults(results);
}

function applyManualReplacement(rank, newMeta) {
  // update tracks
  tracks[rank - 1] = newMeta;

  // update bubble DOM + physics radius
  const b = bubbles.find(x => x.rank === rank);
  if (!b) return;

  // swap image
  const img = b.el.querySelector("img");
  img.src = newMeta.artworkUrl || "";

  // swap preview binding by updating bubble meta ref
  b.meta = newMeta;
}

// ---------- Build showcase ----------
async function buildShowcase(queries) {
  stopAudio();
  stopPhysics();
  els.stage.innerHTML = "";

  // You wanted rank #1 to be playlist #25 -> reverse
  const reversed = [...queries].reverse();
  queriesSession = queries;

  saveSession(queries);
  setMode("showcase");
  showToast("Loading previews…");

  // Resolve iTunes metas
  tracks = await Promise.all(
    reversed.map(async (q) => {
      try {
        const m = await lookupITunesBest(q);
        return m || {
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

  // Build bubbles
  bubbles = [];
  for (let i = 0; i < tracks.length; i++) {
    const rank = i + 1;
    const meta = tracks[i];

    const size = rankToSizePx(rank);
    const el = createBubble(rank, meta);
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;

    els.stage.appendChild(el);

    bubbles.push({
      rank,
      meta,
      el,
      x: 0, y: 0,
      vx: 0, vy: 0,
      r: size / 2,
    });

    // patch click handler to reference current meta
    el.addEventListener("click", (evt) => {
      if (evt.shiftKey) return; // already handled earlier
      const b = bubbles.find(bb => bb.rank === rank);
      if (!b?.meta?.previewUrl) return;
      togglePlay(rank, b.meta.previewUrl, el);
    });
  }

  attachCursorEvents();
  layoutInitialBubbles();
  startPhysics();

  // Warn if any missing previews so you know which to fix
  const missing = tracks
    .map((t, idx) => ({ rank: idx + 1, ok: !!t.previewUrl, score: t.score }))
    .filter(x => !x.ok);

  if (missing.length) {
    showToast(`Loaded with ${missing.length} missing previews. Shift+Click to fix.`);
  } else {
    showToast("Ready. Click to play/stop.");
  }
}

// ---------- Events ----------
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

function wireEvents() {
  els.buildBtn.addEventListener("click", () => {
    handleBuildClick().catch(e => setStatus(String(e?.message || e)));
  });
  els.resetBtn.addEventListener("click", handleReset);
  els.backBtn.addEventListener("click", handleBack);

  els.copyLinkBtn.addEventListener("click", async () => {
    const q = queriesSession || loadSession();
    if (!q?.length) { showToast("Build a showcase first."); return; }
    try { await copyShareLink(q); }
    catch { showToast("Copy failed (browser blocked clipboard)."); }
  });

  els.audio.addEventListener("ended", () => stopAudio());

  // Modal
  els.closeFixBtn.addEventListener("click", closeFixModal);
  els.fixModal.addEventListener("click", (e) => {
    if (e.target === els.fixModal) closeFixModal();
  });
  els.fixSearchBtn.addEventListener("click", () => runFixSearch().catch(() => {}));
  els.fixQuery.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runFixSearch().catch(() => {});
    if (e.key === "Escape") closeFixModal();
  });

  window.addEventListener("resize", () => {
    if (!bubbles.length) return;
    layoutInitialBubbles();
  });
}

// ---------- Init ----------
(async function init() {
  wireEvents();

  // Load from share link first
  const fromHash = decodeListFromHash();
  if (fromHash?.length) {
    setStatus("");
    await buildShowcase(fromHash);
    showToast("Loaded from share link.");
    return;
  }

  // Otherwise restore session
  const saved = loadSession();
  if (saved?.length) {
    setStatus("");
    await buildShowcase(saved);
    return;
  }

  setMode("import");
  setStatus("Upload CSV and click Build Showcase.");
})();
