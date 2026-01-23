const els = {
  csvFile: document.getElementById("csvFile"),
  renderBtn: document.getElementById("renderBtn"),
  clearBtn: document.getElementById("clearBtn"),
  status: document.getElementById("status"),
  importCard: document.getElementById("importCard"),
  importHeader: document.getElementById("importHeader"),
  showcase: document.getElementById("showcase"),
  grid: document.getElementById("grid"),
  audio: document.getElementById("audio"),
};

function setStatus(msg) {
  els.status.textContent = msg || "";
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("Failed to read file."));
    r.readAsText(file);
  });
}

// CSV parser (quoted fields supported)
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
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
      row.push(cell); cell = "";
      if (row.some(c => c.trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  if (row.some(c => c.trim() !== "")) rows.push(row);
  return rows;
}

function extractTop25QueriesFromYourCSV(csvText) {
  const rows = parseCSV(csvText);
  if (!rows.length) return [];

  const header = rows[0].map(h => (h || "").trim().toLowerCase());

  // Your CSV columns
  const trackNameIdx = header.indexOf("track name");
  const artistIdx = header.indexOf("artist name(s)");
  const albumIdx = header.indexOf("album name");

  if (trackNameIdx === -1 || artistIdx === -1) return [];

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const track = (cells[trackNameIdx] || "").trim();
    const artist = (cells[artistIdx] || "").trim();
    const album = albumIdx !== -1 ? (cells[albumIdx] || "").trim() : "";

    if (track && artist) {
      out.push({ track, artist, album });
    }
  }
  return out.slice(0, 25);
}

// iTunes Search API (no auth)
async function lookupITunes({ track, artist }) {
  const term = `${track} ${artist}`;
  const url =
    `https://itunes.apple.com/search?` +
    `term=${encodeURIComponent(term)}&entity=song&limit=5`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error("iTunes search failed");
  const data = await resp.json();
  const results = data.results || [];

  // Heuristic: prefer match where artist contains artist and track contains track
  const t = track.toLowerCase();
  const a = artist.toLowerCase();

  let best = results[0] || null;
  for (const r of results) {
    const rt = (r.trackName || "").toLowerCase();
    const ra = (r.artistName || "").toLowerCase();
    if (rt.includes(t.slice(0, Math.min(10, t.length))) && ra.includes(a.split(",")[0].trim())) {
      best = r;
      break;
    }
  }

  if (!best) return null;

  // Upgrade artwork size (100 -> 600)
  const artwork = (best.artworkUrl100 || "").replace("100x100bb.jpg", "600x600bb.jpg");

  return {
    trackName: best.trackName || track,
    artistName: best.artistName || artist,
    artworkUrl: artwork || best.artworkUrl100 || "",
    previewUrl: best.previewUrl || null,
  };
}

// Compute luminance for hover overlay style
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

// Spiral positions around center in 9x9 (center = 5,5)
function spiralPositions(count) {
  const positions = [];
  let x = 5, y = 5;
  positions.push({ x, y });

  let step = 1;
  while (positions.length < count) {
    // right step, down step, left step+1, up step+1 ...
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

function stopAudio() {
  els.audio.pause();
  els.audio.src = "";
}

function playPreview(url) {
  stopAudio();
  els.audio.src = url;
  els.audio.play().catch(() => {});
}

function enterShowcaseMode(queries) {
  sessionStorage.setItem("top25_queries", JSON.stringify(queries));
  const u = new URL(window.location.href);
  u.searchParams.set("showcase", "1");
  history.pushState({}, "", u.toString());

  els.importCard.classList.add("hidden");
  els.importHeader.classList.add("hidden");
  els.showcase.classList.remove("hidden");
}

function loadSavedShowcaseQueries() {
  const u = new URL(window.location.href);
  if (u.searchParams.get("showcase") !== "1") return null;
  const raw = sessionStorage.getItem("top25_queries");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function createTile(rank, meta, placement) {
  const tile = document.createElement("button");
  tile.className = "tile";
  tile.type = "button";

  // Center tile (#1) spans 4x4, centered at (4,4)
  if (rank === 1) {
    tile.style.gridColumn = "4 / span 4";
    tile.style.gridRow = "4 / span 4";
  } else {
    tile.style.gridColumn = `${placement.x} / span 1`;
    tile.style.gridRow = `${placement.y} / span 1`;
  }

  const img = document.createElement("img");
  img.alt = meta?.trackName ? meta.trackName : `#${rank}`;
  img.src = meta?.artworkUrl || "";

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const num = document.createElement("span");
  num.textContent = String(rank);
  overlay.appendChild(num);

  tile.appendChild(img);
  tile.appendChild(overlay);

  tile.title = meta?.trackName ? `#${rank} — ${meta.trackName}` : `#${rank}`;

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

  tile.addEventListener("click", () => {
    if (meta?.previewUrl) {
      playPreview(meta.previewUrl);
    } else {
      // If no preview exists, do nothing (or you can open Apple Music search)
      setStatus(`No preview available for #${rank}.`);
    }
  });

  return tile;
}

async function buildShowcase(queries) {
  enterShowcaseMode(queries);
  els.grid.innerHTML = "";
  stopAudio();

  // Reverse order: CSV row 25 becomes rank #1
  const reversed = [...queries].reverse();

  setStatus(`Looking up iTunes previews for ${reversed.length} tracks...`);

  const metas = await Promise.all(
    reversed.map(async (q) => {
      try {
        return await lookupITunes(q);
      } catch {
        return null;
      }
    })
  );

  const positions = spiralPositions(25);

  for (let i = 0; i < reversed.length; i++) {
    const rank = i + 1;
    const meta = metas[i] || {
      trackName: `${reversed[i].track}`,
      artistName: `${reversed[i].artist}`,
      artworkUrl: "",
      previewUrl: null,
    };
    const placement = positions[i];
    els.grid.appendChild(createTile(rank, meta, placement));
  }

  setStatus("");
}

async function handleBuild() {
  const file = els.csvFile.files?.[0];
  if (!file) {
    setStatus("Upload your CSV first.");
    return;
  }

  setStatus("Reading CSV...");
  const text = await readFileAsText(file);
  const queries = extractTop25QueriesFromYourCSV(text);

  if (!queries.length) {
    setStatus("Could not parse Track Name + Artist Name(s) from CSV.");
    return;
  }

  await buildShowcase(queries);
}

function clearAll() {
  stopAudio();
  sessionStorage.removeItem("top25_queries");
  const u = new URL(window.location.href);
  u.searchParams.delete("showcase");
  history.pushState({}, "", u.toString());
  location.reload();
}

els.renderBtn.addEventListener("click", () => {
  handleBuild().catch(e => setStatus(String(e?.message || e)));
});
els.clearBtn.addEventListener("click", clearAll);

// Auto-load if in showcase mode
(async function init() {
  const saved = loadSavedShowcaseQueries();
  if (saved?.length) {
    try {
      await buildShowcase(saved);
    } catch (e) {
      setStatus(String(e?.message || e));
    }
  }
})();
