const KEY = "engrid-bg-viz";
const MAX_IMAGES = 50;

const DEFAULT_SAFE_ZONE_COLOR = "#00FF00";

const DEFAULTS = {
  settings: {
    formWidth: 550,
    layout: "left",
    safeZoneWidth: 350,
    safeZoneColor: DEFAULT_SAFE_ZONE_COLOR,
  },
  images: {},
};

export { DEFAULT_SAFE_ZONE_COLOR };

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    return {
      settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) },
      images: parsed.images || {},
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function write(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (err) {
    if (err && err.name === "QuotaExceededError") {
      pruneAndRetry(data);
    } else {
      console.warn("storage write failed", err);
    }
  }
}

function pruneAndRetry(data) {
  const entries = Object.entries(data.images);
  entries.sort((a, b) => (a[1].touchedAt || 0) - (b[1].touchedAt || 0));
  const keep = entries.slice(Math.floor(entries.length / 2));
  data.images = Object.fromEntries(keep);
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (err) {
    console.warn("storage write failed after prune", err);
  }
}

export function loadSettings() {
  return read().settings;
}

export function saveSettings(settings) {
  const data = read();
  data.settings = { ...data.settings, ...settings };
  write(data);
}

export function loadImageState(hash) {
  if (!hash) return null;
  const data = read();
  return data.images[hash] || null;
}

export function saveImageState(hash, state) {
  if (!hash) return;
  const data = read();
  data.images[hash] = { ...state, touchedAt: Date.now() };

  const keys = Object.keys(data.images);
  if (keys.length > MAX_IMAGES) {
    const sorted = Object.entries(data.images).sort(
      (a, b) => (b[1].touchedAt || 0) - (a[1].touchedAt || 0)
    );
    data.images = Object.fromEntries(sorted.slice(0, MAX_IMAGES));
  }

  write(data);
}
