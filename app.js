const els = {
  csvFile: document.getElementById("csvFile"),
  csvText: document.getElementById("csvText"),
  renderBtn: document.getElementById("renderBtn"),
  clearBtn: document.getElementById("clearBtn"),
  status: document.getElementById("status"),
  grid: document.getElementById("grid"),
  playerWrap: document.getElementById("playerWrap"),
  player: document.getElementById("player"),
  closePlayerBtn: document.getElementById("closePlayerBtn"),
  playerTitle: document.getElementById("playerTitle"),
  playerSub: document.getElementById("playerSub"),
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

/**
 * Minimal CSV parser:
 * - Handles quoted cells
 * - Splits on commas/newlines
 * - Returns array of rows (array of cells)
 */
function parseCSV(text) {
  // Strip UTF-8 BOM if present
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      cell += '"'; // escaped quote
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
      if (ch === "\r" && next === "\n") i++; // consume CRLF
      row.push(cell);
      cell = "";

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

function parseTrackIdFromSpotifyUriOrUrl(value) {
  const s = (value || "").trim();
  if (!s) return null;

  // spotify:track:<id>
  const uri = s.match(/^spotify:track:([a-zA-Z0-9]+)$/);
  if (uri) return uri[1];

  // https://open.spotify.com/track/<id>
  try {
    const u = new URL(s);
    if (u.hostname.includes("spotify.com")) {
      const parts = u.pathname.split("/").filter(Boolean);
      const idx = parts.indexOf("track");
      if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
    }
  } catch {
    // not a URL
  }

  return null;
}

function extractTop25TrackIdsFromYourCSV(csvText) {
  const rows = parseCSV(csvText);
  if (!rows.length) return [];

  const header = rows[0].map(h => (h || "").trim().toLowerCase());

  // Your CSV uses "Track URI"
  const trackUriIdx = header.indexOf("track uri");
  if (trackUriIdx === -1) {
    // fallback: try common variants
    const fallbackIdx =
      header.indexOf("track_uri") !== -1 ? header.indexOf("track_uri")
      : header.indexOf("uri") !== -1 ? header.indexOf("uri")
      : -1;

    if (fallbackIdx === -1) return [];
    return extractByIndex(rows, fallbackIdx);
  }

  return extractByIndex(rows, trackUriIdx);

  function extractByIndex(allRows, idx) {
    const ids = [];
    for (let r = 1; r < allRows.length; r++) {
      const cells = allRows[r];
      const id = parseTrackIdFromSpotifyUriOrUrl(cells[idx]);
      if (id) ids.push(id);
    }
    // Dedup preserve order
    const seen = new Set();
    const unique = [];
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(id);
      }
    }
    return unique.slice(0, 25);
  }
}

function trackUrl(trackId) {
  return `https://open.spotify.com/track/${trackId}`;
}

function embedUrl(trackId) {
  return `https://open.spotify.com/embed/track/${trackId}`;
}

// Public oEmbed (no login/dev app). Pulls artwork thumbnail + title/author.
async function fetchOEmbed(trackId) {
  const cacheKey = `oembed_${trackId}`;
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) return JSON.parse(cached);

  const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl(trackId))}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`oEmbed failed for ${trackId} (${resp.status})`);
  const data = await resp.json();

  const out = {
    title: data.title || "",
    author: data.author_name || "",
    thumbnail: data.thumbnail_url || "",
  };

  sessionStorage.setItem(cacheKey, JSON.stringify(out));
  return out;
}

function placeholderSvg(label) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="#0e0e14"/>
          <stop offset="1" stop-color="#1a1a2a"/>
        </linearGradient>
      </defs>
      <rect width="600" height="600" fill="url(#g)"/>
      <circle cx="300" cy="300" r="170" fill="none" stroke="#1db954" stroke-width="16" opacity="0.25"/>
      <text x="300" y="315" text-anchor="middle" font-family="Arial" font-size="44" fill="#b6b6c2" opacity="0.6">${label}</text>
    </svg>
  `)}`;
}

function makeTile(n, trackId, meta) {
  const tile = document.createElement("button");
  tile.className = "tile";
  tile.type = "button";

  const img = document.createElement("img");
  img.alt = meta?.title ? meta.title : `Track ${n}`;
  img.src = meta?.thumbnail || placeholderSvg("SPOTIFY");

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const num = document.createElement("span");
  num.textContent = String(n);
  overlay.appendChild(num);

  tile.appendChild(img);
  tile.appendChild(overlay);

  tile.title = meta?.title ? `#${n} — ${meta.title}` : `#${n}`;

  tile.addEventListener("click", () => {
    els.player.src = embedUrl(trackId);
    els.playerWrap.classList.remove("hidden");
    els.playerTitle.textContent = meta?.title ? `Now Playing: #${n} — ${meta.title}` : `Now Playing: #${n}`;
    els.playerSub.textContent = meta?.author ? meta.author : "Spotify embed player";
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  });

  return tile;
}

async function getCSVText() {
  const file = els.csvFile.files?.[0] || null;
  if (file) return await readFileAsText(file);
  return els.csvText.value || "";
}

async function render() {
  setStatus("");
  els.grid.innerHTML = "";
  els.playerWrap.classList.add("hidden");
  els.player.src = "";

  const csvText = await getCSVText();
  if (!csvText.trim()) {
    setStatus("Upload your CSV (like 25_of_25.csv) or paste its contents first.");
    return;
  }

  const ids = extractTop25TrackIdsFromYourCSV(csvText);
  if (!ids.length) {
    setStatus("I couldn’t find the “Track URI” column. Make sure your CSV has a header named Track URI.");
    return;
  }

  setStatus(`Found ${ids.length} track IDs. Fetching album art...`);

  // Fetch oEmbed in parallel (25 requests is fine)
  const metas = await Promise.allSettled(ids.map(id => fetchOEmbed(id)));

  ids.forEach((id, idx) => {
    const n = idx + 1;
    const res = metas[idx];
    const meta = res.status === "fulfilled" ? res.value : { title: "", author: "", thumbnail: "" };
    els.grid.appendChild(makeTile(n, id, meta));
  });

  setStatus(`Rendered ${ids.length} tracks. Hover to see rank; click to play in the embed player.`);
}

function clearAll() {
  els.csvFile.value = "";
  els.csvText.value = "";
  els.grid.innerHTML = "";
  els.playerWrap.classList.add("hidden");
  els.player.src = "";
  setStatus("");
}

els.renderBtn.addEventListener("click", () => {
  render().catch(e => setStatus(String(e?.message || e)));
});
els.clearBtn.addEventListener("click", clearAll);
els.closePlayerBtn.addEventListener("click", () => {
  els.playerWrap.classList.add("hidden");
  els.player.src = "";
});

