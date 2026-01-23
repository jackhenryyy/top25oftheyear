// app.js (debuggable + robust)

console.log("[Top25] app.js loaded");

const els = {
  csvFile: document.getElementById("csvFile"),
  buildBtn: document.getElementById("buildBtn"),
  resetBtn: document.getElementById("resetBtn"),
  backBtn: document.getElementById("backBtn"),
  status: document.getElementById("status"),
  importHeader: document.getElementById("importHeader"),
  importCard: document.getElementById("importCard"),
  showcase: document.getElementById("showcase"),
  grid: document.getElementById("grid"),
  audio: document.getElementById("audio"),
  toast: document.getElementById("toast"),
};

const STORAGE_KEY = "top25_queries_v1";
const TOAST_MS = 1800;

function setStatus(msg) {
  if (!els.status) return;
  els.status.textContent = msg || "";
  console.log("[Top25] status:", msg || "");
}

function showToast(msg) {
  if (!els.toast) return;
  els.toast.textContent = msg || "";
  els.toast.classList.remove("hidden");
  window.clearTimeout(showToast._t);
  showToast._t = window.setTimeout(() => els.toast.classList.add("hidden"), TOAST_MS);
}

function stopAudio() {
  if (!els.audio) return;
  els.audio.pause();
  els.audio.src = "";
}

function playPreview(url) {
  if (!els.audio) return;
  stopAudio();
  els.audio.src = url;
  els.audio.play().catch((e) => {
    console.warn("[Top25] audio.play() blocked:", e);
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

// CSV parser (quoted cells supported)
function parseCSV(text) {
  if (!text) return [];
  // Strip UTF-8 BOM if present
  text = text.replace(/^\uFEFF/, "");

  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      cell += '"';
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (ch === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

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

// Robust header matching for your CSV
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
    console.warn("[Top25] Header row:", headerRaw);
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

// iTunes Search API (no auth)
async function lookupITunes(q) {
  const primaryArtist = (q.artist || "").split(",")[0].trim();
  const term = `${q.track} ${primaryArtist}`.trim();

  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=10`;

  const resp = await fetch(url);
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`iTunes search failed (${resp.status}). ${txt}`);
  }

  const data = await resp.json();
  const results = data.results || [];
  if (!results.length) return null;

  const t = q.track.toLowerCase();
  const a = primaryArtist.toLowerCase();

  const score = (r) => {
    const rt = (r.trackName || "").toLowerCase();
    const ra = (r.artistName || "").toLowerCase();
    let s = 0;
    if (rt === t) s += 7;
    if (ra === a) s += 5;
    if (rt.includes(t)) s += 3;
    if (ra.includes(a)) s += 4;
    if (ra.includes("karaoke") || ra.includes("tribute")) s -= 8;
    return s;
  };

  let best = results[0];
  let bestScore = score(best);
  for (const r of results) {
    const sc = score(r);
    if (sc > bestScore) { best = r; bestScore = sc; }
  }

  const artwork = (best.artworkUrl100 || "").replace("100x100bb.jpg", "600x600bb.jpg");

  return {
    trackName: best.trackName || q.track,
    artistName: best.artistName || q.artist,
    artworkUrl: artwork || best.artworkUrl100 || "",
    previewUrl: best.previewUrl || null,
  };
}

// Luminance for adaptive overlay
async function computeLuminance(imgEl) {
  const w = 32, h = 32;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
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

// Spiral positions in 9x9 centered at (5,5)
function spiralPositions(count) {
  const positions = [];
  let x = 5, y = 5;
  positions.push({ x, y });

  let step = 1;
  while (positions.length < count) {
    for (const [dx, dy] of [[1,0],[0,1],[-1,0],[0,-1]]) {
      const moves = step;
      for (let i = 0; i < moves; i++) {
        if (positions.length >= count) break;
        x += dx; y += dy;
        if (x >= 1 && x <= 9 && y >= 1 && y <= 9) positions.push({ x, y });
      }
      if (dx === 0 && dy === 1) step++;
      if (dx === 0 && dy === -1) step++;
    }
  }

  return positions.slice(0, count);
}

function setMode(mode) {
  if (mode === "showcase") {
    els.importHeader?.classList.add("hidden");
    els.importCard?.classList.add("hidden");
    els.showcase?.classList.remove("hidden");
  } else {
    els.importHeader?.classList.remove("hidden");
    els.importCard?.classList.remove("hidden");
    els.showcase?.classList.add("hidden");
  }
}

function saveShowcase(queries) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(queries));
  const u = new URL(window.location.href);
  u.searchParams.set("showcase", "1");
  history.pushState({}, "", u.toString());
}

function clearShowcase() {
  sessionStorage.removeItem(STORAGE_KEY);
  const u = new URL(window.location.href);
  u.searchParams.delete("showcase");
  history.pushState({}, "", u.toString());
}

function loadShowcase() {
  const u = new URL(window.location.href);
  if (u.searchParams.get("showcase") !== "1") return null;
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function createTile(rank, meta, placement) {
  const tile = document.createElement("button");
  tile.className = "tile";
  tile.type = "button";

  if (rank === 1) {
    tile.style.gridColumn = "4 / span 4";
    tile.style.gridRow = "4 / span 4";
    tile.style.borderRadius = "18px";
  } else {
    tile.style.gridColumn = `${placement.x} / span 1`;
    tile.style.gridRow = `${placement.y} / span 1`;
  }

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

  tile.title = meta?.trackName ? `#${rank} — ${meta.trackName} (${meta.artistName || ""})` : `#${rank}`;

  tile.addEventListener("click", () => {
    if (meta?.previewUrl) {
      playPreview(meta.previewUrl);
      showToast(`#${rank}: ${meta.trackName} — ${meta.artistName}`);
    } else {
      showToast(`#${rank}: No preview available`);
    }
  });

  return tile;
}

async function buildShowcase(queries) {
  setStatus("");
  stopAudio();
  els.grid.innerHTML = "";

  // Reverse order so CSV row 25 becomes rank #1
  const reversed = [...queries].reverse();

  saveShowcase(queries);
  setMode("showcase");

  showToast("Loading previews...");

  // Fetch iTunes metadata in parallel
  const metas = await Promise.all(
    reversed.map(async (q, idx) => {
      try {
        const m = await lookupITunes(q);
        return m;
      } catch (e) {
        console.warn("[Top25] lookup failed idx", idx, q, e);
        return null;
      }
    })
  );

  const positions = spiralPositions(25);

  for (let i = 0; i < reversed.length; i++) {
    const rank = i + 1;
    const meta = metas[i] || {
      trackName: reversed[i].track,
      artistName: reversed[i].artist,
      artworkUrl: "",
      previewUrl: null,
    };
    const placement = positions[i];
    els.grid.appendChild(createTile(rank, meta, placement));
  }

  showToast("Ready. Click any cover to play a 30s preview.");
}

async function handleBuildClick() {
  console.log("[Top25] Build Showcase clicked");

  const file = els.csvFile?.files?.[0];
  if (!file) {
    setStatus("Upload your CSV first.");
    return;
  }

  setStatus("Reading CSV...");
  const text = await readFileAsText(file);

  const queries = extractTop25QueriesFromCSV(text);
  console.log("[Top25] extracted queries:", queries.length, queries[0]);

  if (!queries.length) {
    setStatus("Could not parse Track Name + Artist Name(s) from this CSV. Check the header row.");
    return;
  }

  setStatus("");
  await buildShowcase(queries);
}

function handleResetClick() {
  stopAudio();
  els.csvFile.value = "";
  clearShowcase();
  setMode("import");
  els.grid.innerHTML = "";
  setStatus("");
  els.toast?.classList.add("hidden");
  showToast("Reset.");
}

function handleBackClick() {
  stopAudio();
  setMode("import");
}

function wireEvents() {
  if (!els.buildBtn) throw new Error("Missing #buildBtn in HTML");
  if (!els.csvFile) throw new Error("Missing #csvFile in HTML");
  if (!els.grid) throw new Error("Missing #grid in HTML");

  els.buildBtn.addEventListener("click", () => {
    handleBuildClick().catch(e => setStatus(String(e?.message || e)));
  });
  els.resetBtn?.addEventListener("click", handleResetClick);
  els.backBtn?.addEventListener("click", handleBackClick);

  console.log("[Top25] events wired");
}

(async function init() {
  try {
    wireEvents();
    setStatus("JS loaded. Upload CSV and click Build Showcase.");
    const saved = loadShowcase();
    if (saved?.length) {
      await buildShowcase(saved);
    } else {
      setMode("import");
    }
  } catch (e) {
    console.error("[Top25] init error:", e);
    setStatus(`JS error: ${String(e?.message || e)}`);
  }
})();
