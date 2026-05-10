import { loadSettings, saveSettings, loadImageState, saveImageState } from "./storage.js?v=30";
import {
  loadFromFile,
  loadFromUrl,
  computeCropFromFocalPoint,
  clampCrop,
  cropToImageData,
  formatBytes,
} from "./imagework.js?v=30";
import { fitCanvasToContainer, render, drawActiveSafeZone } from "./overlay.js?v=30";
import { triggerDownload, suggestFilename } from "./compress.js?v=30";
import { encodeJpegInWorker } from "./encode-client.js?v=1";

const $ = (id) => document.getElementById(id);
const MAX_RECOMMENDED_LONGEST_SIDE = 2000;

const PRESETS = [
  { id: "ngs-left", name: "NGS - Left Layout", layout: "left", formWidth: 550, safeZoneWidth: 350 },
  { id: "nwf-left", name: "NWF - Left Layout", layout: "left", formWidth: 800, safeZoneWidth: 200 },
  { id: "oceana-left", name: "Oceana - Left Layout", layout: "left", formWidth: 680, safeZoneWidth: 350 },
  { id: "ran-left", name: "RAN - Left Layout", layout: "left", formWidth: 680, safeZoneWidth: 300 },
  { id: "shatterproof-left", name: "Shatterproof - Left Layout", layout: "left", formWidth: 640, safeZoneWidth: 350 },
  { id: "wwf-center", name: "WWF - Center Layout", layout: "center", formWidth: 1200, safeZoneWidth: 1200 },
];

function matchingPresetId() {
  const s = state.settings;
  for (const p of PRESETS) {
    if (p.layout === s.layout && p.formWidth === s.formWidth && p.safeZoneWidth === s.safeZoneWidth) {
      return p.id;
    }
  }
  return null;
}

function syncPresetUI() {
  if (state.settings.preset == null) {
    state.settings.preset = matchingPresetId() || "custom";
  }
  const id = state.settings.preset;
  els.preset.value = id;
  const p = PRESETS.find((p) => p.id === id);
  if (p) {
    els.formSafeZoneFieldset.classList.add("is-preset");
  } else {
    els.formSafeZoneFieldset.classList.remove("is-preset");
  }
}

const SAFE_ZONE_COLORS = ["#FF0000", "#FF7F00", "#FFFF00", "#00FF00", "#0000FF", "#4B0082"];
const DEFAULT_SAFE_ZONE_COLOR = "#00FF00";

function cycleSafeZoneColor() {
  const current = (state.settings.safeZoneColor || DEFAULT_SAFE_ZONE_COLOR).toUpperCase();
  const i = SAFE_ZONE_COLORS.indexOf(current);
  const next = SAFE_ZONE_COLORS[(i + 1) % SAFE_ZONE_COLORS.length];
  state.settings.safeZoneColor = next;
  persistSettings();
  applySafeZoneColorVar();
  rerender();
  renderModal();
}

function resetSafeZoneColor() {
  if ((state.settings.safeZoneColor || "").toUpperCase() === DEFAULT_SAFE_ZONE_COLOR) return;
  state.settings.safeZoneColor = DEFAULT_SAFE_ZONE_COLOR;
  persistSettings();
  applySafeZoneColorVar();
  rerender();
  renderModal();
}

function applySafeZoneColorVar() {
  document.documentElement.style.setProperty(
    "--zone-color",
    state.settings.safeZoneColor || "#00ff00"
  );
}

function applyPreset(id) {
  const p = PRESETS.find((p) => p.id === id);
  state.settings.preset = id;
  if (p) {
    state.settings.layout = p.layout;
    state.settings.formWidth = p.formWidth;
    state.settings.safeZoneWidth = p.safeZoneWidth;
  }
  resetSafeZoneColor();
  persistSettings();
  syncSettingsToInputs();
  applyLayoutFromSettings();
  syncPresetUI();
  rerender();
}

function markPresetCustomIfChanged() {
  const matching = matchingPresetId();
  state.settings.preset = matching || "custom";
}

const state = {
  settings: loadSettings(),
  image: null,
  focal: { x: 0.5, y: 0.5 },
  crop: null,
  outputW: 1800,
  outputH: 1200,
  outputAspect: 1800 / 1200,
  quality: 55,
  scale: 1,
  estimatedBytes: null,
  compressedBitmap: null,
  compareMode: false,
  compareHoverOverlay: false,
  hasManualCrop: false,
  maxResolution: 2000,
};

const els = {
  layout: document.querySelector(".layout"),
  safeZoneSetting: document.querySelector(".safe-zone-setting"),
  focalPointSetting: document.querySelector(".focal-point-setting"),
  cropFocalSetting: document.querySelector(".crop-focal-setting"),
  formWidth: $("form-width"),
  formLayout: $("form-layout"),
  safeZoneWidth: $("safe-zone-width"),
  preset: $("preset"),
  presetDetails: $("preset-details"),
  formSafeZoneFieldset: document.querySelector(".form-safezone-fieldset"),
  safeZoneColor: $("safe-zone-color"),
  infoBtn: $("info-btn"),
  infoModal: $("info-modal"),
  canvasWrap: $("canvas-wrap"),
  uploadBtn: $("upload-btn"),
  fileInput: $("file-input"),
  clearImageRow: $("clear-image-row"),
  clearImage: $("clear-image"),
  metaDims: $("meta-dims"),
  metaSize: $("meta-size"),
  outputMetaLabel: $("output-meta-label"),
  outputMetaDims: $("output-meta-dims"),
  outputMetaSize: $("output-meta-size"),
  outputMetaCompare: $("output-meta-compare"),
  error: $("error"),
  canvas: $("preview-canvas"),
  previewSpinner: $("preview-spinner"),
  emptyState: $("empty-state"),
  sourceInfo: $("source-info"),
  focalPreset: $("focal-preset"),
  cropFocalPreset: $("crop-focal-preset"),
  focalAttributeHint: $("focal-attribute-hint"),
  outputWLabel: $("output-w-label"),
  outputHLabel: $("output-h-label"),
  outputW: $("output-w"),
  outputH: $("output-h"),
  resetCrop: $("reset-crop"),
  maxResolution: $("max-resolution"),
  qualityVal: $("quality-val"),
  maxResolutionVal: $("max-resolution-val"),
  compareBtn: $("compare-btn"),
  quality: $("quality"),
  compressionWarning: $("compression-warning"),
  download: $("download"),
  modal: $("crop-inline"),
  modalCanvas: $("modal-canvas"),
  cropSizeWarning: $("crop-size-warning"),
  cropSizeWarningText: $("crop-size-warning-text"),
  cropFixBtn: $("crop-fix-btn"),
  resetCropRow: $("reset-crop-row"),
};

const modalState = {
  active: false,
  scale: 1,
  crop: null,
  drag: null,
  removeCrop: false,
  focal: null,
};

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function showError(msg) {
  els.error.textContent = msg;
  els.error.hidden = false;
}
function clearError() {
  els.error.textContent = "";
  els.error.hidden = true;
}

function setPreviewLoading(active) {
  els.previewSpinner.hidden = !active;
  els.previewSpinner.setAttribute("aria-hidden", active ? "false" : "true");
}

function persistSettings() {
  saveSettings(state.settings);
}

function persistImageState() {
  if (!state.image) return;
  saveImageState(state.image.hash, {
    filename: state.image.filename,
    focalPoint: state.focal,
    cropFrame: state.crop,
    outputW: state.outputW,
    outputH: state.outputH,
    quality: state.quality,
    hasManualCrop: state.hasManualCrop,
  });
}

function syncSettingsToInputs() {
  els.formWidth.value = state.settings.formWidth;
  els.formLayout.value = state.settings.layout;
  els.safeZoneWidth.value = state.settings.safeZoneWidth;
  updateCenterModeControls();
}

function applyLayoutFromSettings() {
  document.documentElement.style.setProperty("--form-width", `${state.settings.formWidth}px`);
  els.layout.classList.remove("form-pos-left", "form-pos-center", "form-pos-right");
  els.layout.classList.add(`form-pos-${state.settings.layout}`);
  updateCenterModeControls();
  highlightFocalPreset();
}

function isCenterFormPosition() {
  return state.settings.layout === "center";
}

function updateCenterModeControls() {
  const isCenter = isCenterFormPosition();
  els.safeZoneSetting.hidden = isCenter;
  els.focalPointSetting.hidden = isCenter;
  if (els.cropFocalSetting) els.cropFocalSetting.hidden = isCenter;
  updateFocalAttributeHint();
}

function updateFocalAttributeHint() {
  if (!state.image) {
    els.focalAttributeHint.hidden = true;
    return;
  }
  const posMap = {
    "0,0": "left top",
    "0,0.5": "left center",
    "0,1": "left bottom",
    "0.5,0": "center top",
    "0.5,1": "center bottom",
    "1,0": "right top",
    "1,0.5": "right center",
    "1,1": "right bottom",
  };
  const value = `${state.focal.x},${state.focal.y}`;
  const position = posMap[value];
  if (position) {
    const attr = `data-background-position="${position}"`;
    els.focalAttributeHint.dataset.attr = attr;
    els.focalAttributeHint.innerHTML = `ENgrid attribute: <code>${attr}</code>`;
    els.focalAttributeHint.hidden = false;
  } else {
    els.focalAttributeHint.hidden = true;
  }
}

function effectiveFocal() {
  return isCenterFormPosition() ? { x: 0.5, y: 0.5 } : state.focal;
}

function effectiveSafeZoneSettings() {
  if (!isCenterFormPosition()) return state.settings;
  return {
    ...state.settings,
    safeZoneWidth: state.settings.formWidth,
    safeZoneColor: "#FF0000",
    safeZoneWarmColor: state.settings.safeZoneColor || "#00FF00",
  };
}

function effectiveCropSafeZoneSettings() {
  if (!isCenterFormPosition()) return effectiveSafeZoneSettings();
  return {
    ...state.settings,
    safeZoneWidth: state.settings.formWidth,
    safeZoneColor: "#FF0000",
    safeZoneWarmColor: state.settings.safeZoneColor || "#00FF00",
  };
}

function syncOutputAndQualityToInputs() {
  updateOutputDimensionLabels();
  updateOutputMeta();
  els.outputW.value = state.outputW;
  els.outputH.value = state.outputH;
  els.quality.value = state.quality;
  updateQualityDisplay();
  updateMaxResolutionDisplay();
  updateCompressionWarning();
}

const QUALITY_PRESETS = [
  { value: 40, label: "Smaller file" },
  { value: 55, label: "Balanced" },
  { value: 70, label: "Higher quality" },
  { value: 100, label: "Maximum quality" },
];

const MAX_RES_PRESETS = [
  { value: 1000, label: "1,000px" },
  { value: 2000, label: "2,000px" },
  { value: 4000, label: "4,000px" },
  { value: 0, label: "No limit" },
];

function nearestPresetIndex(presets, value) {
  let bestIdx = 0;
  let bestDiff = Math.abs(presets[0].value - value);
  for (let i = 1; i < presets.length; i++) {
    const d = Math.abs(presets[i].value - value);
    if (d < bestDiff) { bestIdx = i; bestDiff = d; }
  }
  return bestIdx;
}

function snapQualityToPreset(q) {
  return QUALITY_PRESETS[nearestPresetIndex(QUALITY_PRESETS, q)].value;
}

function updateQualityDisplay() {
  const idx = nearestPresetIndex(QUALITY_PRESETS, state.quality);
  els.quality.value = String(idx);
  if (els.qualityVal) els.qualityVal.textContent = QUALITY_PRESETS[idx].label;
}

function updateMaxResolutionDisplay() {
  const idx = state.maxResolution === 0
    ? MAX_RES_PRESETS.findIndex(p => p.value === 0)
    : nearestPresetIndex(MAX_RES_PRESETS.filter(p => p.value > 0), state.maxResolution);
  els.maxResolution.value = String(idx);
  if (els.maxResolutionVal) els.maxResolutionVal.textContent = MAX_RES_PRESETS[idx].label;
}

function syncCompareUi() {
  els.compareBtn.classList.toggle("active", state.compareMode);
  els.compareBtn.textContent = state.compareMode ? "Original" : "Compare";

  const hide = state.compareMode || state.compareHoverOverlay;
  els.infoBtn.hidden = hide || !state.image;
}

function updateCompressionWarning() {
  els.compressionWarning.hidden = true;
  els.compressionWarning.textContent = "";
}

function updateOutputDimensionLabels() {
  if (!state.image) {
    els.outputWLabel.textContent = "Width (px)";
    els.outputHLabel.textContent = "Height (px)";
    return;
  }

  const intrinsicW = state.hasManualCrop && state.crop
    ? Math.round(state.crop.w)
    : state.image.width;
  const intrinsicH = state.hasManualCrop && state.crop
    ? Math.round(state.crop.h)
    : state.image.height;
  const isResized = state.outputW !== intrinsicW || state.outputH !== intrinsicH;

  els.outputWLabel.textContent = isResized
    ? "Resized Width"
    : state.hasManualCrop ? "Cropped Width" : "Intrinsic Width";
  els.outputHLabel.textContent = isResized
    ? "Resized Height"
    : state.hasManualCrop ? "Cropped Height" : "Intrinsic Height";
}

function updateOutputMeta() {
  if (!state.image) {
    els.outputMetaLabel.textContent = "Output:";
    els.outputMetaDims.textContent = "";
    els.outputMetaSize.textContent = "";
    els.outputMetaCompare.textContent = "";
    els.outputMetaSize.classList.remove("is-estimating", "is-error");
    return;
  }

  els.outputMetaLabel.textContent = "Output:";
  els.outputMetaDims.textContent = `${state.outputW.toLocaleString("en-US")} × ${state.outputH.toLocaleString("en-US")}`;
  if (state.estimatedBytes != null) {
    els.outputMetaSize.textContent = formatBytes(state.estimatedBytes);
    els.outputMetaSize.classList.remove("is-estimating", "is-error");
    if (state.image.byteLength > 0) {
      const pct = ((state.estimatedBytes - state.image.byteLength) / state.image.byteLength) * 100;
      const rounded = Math.abs(pct).toFixed(0);
      if (rounded === "0") {
        els.outputMetaCompare.textContent = "";
      } else {
        const word = pct >= 0 ? "larger" : "smaller";
        els.outputMetaCompare.textContent = ` (${rounded}% ${word})`;
      }
    } else {
      els.outputMetaCompare.textContent = "";
    }
  } else {
    if (!els.outputMetaSize.textContent || els.outputMetaSize.classList.contains("is-error")) {
      els.outputMetaSize.textContent = "…";
      els.outputMetaSize.classList.remove("is-error");
    }
    els.outputMetaSize.classList.add("is-estimating");
  }
}

function outputIntrinsicDimensions() {
  if (!state.image) return null;
  return {
    w: state.hasManualCrop && state.crop ? Math.round(state.crop.w) : state.image.width,
    h: state.hasManualCrop && state.crop ? Math.round(state.crop.h) : state.image.height,
  };
}

function detailCap() {
  return state.maxResolution > 0 ? state.maxResolution : Infinity;
}

function rerender() {
  if (!state.image) {
    els.emptyState.hidden = false;
    const ctx = els.canvas.getContext("2d");
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    return;
  }
  els.emptyState.hidden = true;
  fitCanvasToContainer(els.canvas, els.canvas.parentElement);

  const useCompressed = state.compressedBitmap && !state.compareMode;
  const renderImage = useCompressed
    ? { bitmap: state.compressedBitmap, width: state.outputW, height: state.outputH }
    : state.image;
  const renderCrop = useCompressed
    ? { x: 0, y: 0, w: state.outputW, h: state.outputH }
    : state.crop;

  render({
    canvas: els.canvas,
    image: renderImage,
    settings: effectiveSafeZoneSettings(),
    focal: effectiveFocal(),
    crop: renderCrop,
    showSafeZone: !state.compareMode && !state.compareHoverOverlay,
  });
}


function recomputeCropFromFocal() {
  if (!state.image) return;
  state.crop = computeCropFromFocalPoint(state.image, effectiveFocal(), state.outputW, state.outputH);
  updateRemoveCropVisibility();
  syncCropUiFromState();
}

function fullImageCrop() {
  return { x: 0, y: 0, w: state.image.width, h: state.image.height };
}

function clampOutputToCap() {
  if (!state.image) return false;
  const intrinsic = outputIntrinsicDimensions();
  if (!intrinsic) return false;
  const cap = detailCap();
  const intrinsicMax = Math.max(intrinsic.w, intrinsic.h);
  const targetMax = Math.min(cap, intrinsicMax);
  const currentMax = Math.max(state.outputW, state.outputH);
  if (Math.abs(currentMax - targetMax) < 1) return false;
  if (targetMax >= intrinsicMax) {
    state.outputW = intrinsic.w;
    state.outputH = intrinsic.h;
  } else {
    const scale = targetMax / currentMax;
    state.outputW = Math.max(1, Math.round(state.outputW * scale));
    state.outputH = Math.max(1, Math.round(state.outputH * scale));
  }
  state.outputAspect = state.outputW / state.outputH;
  return true;
}

function updateRemoveCropVisibility() {
  let show = false;
  if (state.hasManualCrop && state.crop && state.image) {
    const eps = 1;
    const fullCrop =
      Math.abs(state.crop.x) < eps &&
      Math.abs(state.crop.y) < eps &&
      Math.abs(state.crop.w - state.image.width) < eps &&
      Math.abs(state.crop.h - state.image.height) < eps;
    show = !fullCrop;
  }
  els.resetCropRow.classList.toggle("is-visible", show);
}

function snapFocalToPreset(focal) {
  const snap = (v) => (v < 0.25 ? 0 : v > 0.75 ? 1 : 0.5);
  return { x: snap(focal.x), y: snap(focal.y) };
}

function highlightFocalPreset() {
  const value = `${state.focal.x},${state.focal.y}`;
  els.focalPreset.value = value;
  if (els.cropFocalPreset) els.cropFocalPreset.value = value;
}

function setFocalFromPreset(value) {
  const [x, y] = value.split(",").map(parseFloat);
  state.focal = { x, y };
  if (modalState.active) modalState.focal = { x, y };
  highlightFocalPreset();
}

async function applyImage(image) {
  state.image = image;
  resetSafeZoneColor();
  els.sourceInfo.hidden = false;
  els.metaDims.textContent = `${image.width.toLocaleString("en-US")} × ${image.height.toLocaleString("en-US")}`;
  els.metaSize.textContent = formatBytes(image.byteLength);

  const saved = loadImageState(image.hash);
  if (saved) {
    state.focal = snapFocalToPreset(saved.focalPoint || { x: 0.5, y: 0.5 });
    state.outputW = saved.outputW || image.width;
    state.outputH = saved.outputH || image.height;
    state.quality = snapQualityToPreset(saved.quality ?? 55);
    state.hasManualCrop = !!saved.hasManualCrop;
    state.crop = saved.hasManualCrop && saved.cropFrame
      ? clampCrop(saved.cropFrame, image)
      : computeCropFromFocalPoint(image, effectiveFocal(), state.outputW, state.outputH);
  } else {
    state.hasManualCrop = false;
    state.focal = { x: 0.5, y: 0.5 };
    if (Math.max(image.width, image.height) > 2000) {
      const ratio = 2000 / Math.max(image.width, image.height);
      state.outputW = Math.round(image.width * ratio);
      state.outputH = Math.round(image.height * ratio);
    } else {
      state.outputW = image.width;
      state.outputH = image.height;
    }
    state.quality = 55;
    state.crop = computeCropFromFocalPoint(image, effectiveFocal(), state.outputW, state.outputH);
  }

  state.outputAspect = state.outputW / state.outputH;
  state.maxResolution = 2000;
  updateMaxResolutionDisplay();
  clampOutputToCap();
  if (!state.hasManualCrop) {
    state.crop = computeCropFromFocalPoint(image, effectiveFocal(), state.outputW, state.outputH);
  }
  syncOutputAndQualityToInputs();
  highlightFocalPreset();
  updateFocalAttributeHint();
  els.download.disabled = false;
  els.clearImageRow.hidden = false;
  els.infoBtn.hidden = false;
  els.compareBtn.hidden = false;
  els.layout.classList.add("has-image");
  updateRemoveCropVisibility();
  state.estimatedBytes = null;
  rerender();
  scheduleEstimate();
  activateCropUi();
}

function handleClearImage() {
  state.image = null;
  state.focal = { x: 0.5, y: 0.5 };
  state.crop = null;
  state.outputW = 1800;
  state.outputH = 1200;
  state.outputAspect = 1800 / 1200;
  state.quality = 55;
  state.estimatedBytes = null;
  els.sourceInfo.hidden = true;
  els.metaDims.textContent = "";
  els.metaSize.textContent = "";
  els.download.disabled = true;
  deactivateCropUi();
  els.clearImageRow.hidden = true;
  els.infoBtn.hidden = true;
  els.compareBtn.hidden = true;
  state.hasManualCrop = false;
  state.maxResolution = 2000;
  updateMaxResolutionDisplay();
  if (state.compressedBitmap?.close) state.compressedBitmap.close();
  state.compressedBitmap = null;
  state.compareMode = false;
  state.compareHoverOverlay = false;
  updateRemoveCropVisibility();
  updateFocalAttributeHint();
  syncCompareUi();
  els.layout.classList.remove("has-image");
  lastTriedUrl = null;
  clearError();
  syncOutputAndQualityToInputs();
  highlightFocalPreset();
  rerender();
}

async function handleFile(file) {
  clearError();
  const gen = ++loadGeneration;
  try {
    const image = await loadFromFile(file);
    if (gen !== loadGeneration) return;
    await applyImage(image);
  } catch (err) {
    if (gen !== loadGeneration) return;
    showError(err.message || String(err));
  }
}

async function handleUrl(url) {
  clearError();
  if (!url) return;
  const gen = ++loadGeneration;
  try {
    const image = await loadFromUrl(url);
    if (gen !== loadGeneration) return;
    await applyImage(image);
  } catch (err) {
    if (gen !== loadGeneration) return;
    showError(err.message || String(err));
  }
}

function wireSettingsInputs() {
  els.preset.addEventListener("change", () => {
    applyPreset(els.preset.value);
  });
  els.formWidth.addEventListener("input", () => {
    state.settings.formWidth = clampInt(els.formWidth.value, 100, 2000, 550);
    markPresetCustomIfChanged();
    persistSettings();
    applyLayoutFromSettings();
    syncPresetUI();
    rerender();
  });
  els.formLayout.addEventListener("change", () => {
    state.settings.layout = els.formLayout.value;
    markPresetCustomIfChanged();
    persistSettings();
    applyLayoutFromSettings();
    syncPresetUI();
    if (state.image && !state.hasManualCrop) recomputeCropFromFocal();
    rerender();
  });
  els.safeZoneWidth.addEventListener("input", () => {
    state.settings.safeZoneWidth = clampInt(els.safeZoneWidth.value, 50, 2000, 350);
    markPresetCustomIfChanged();
    persistSettings();
    syncPresetUI();
    rerender();
  });
  els.safeZoneColor.addEventListener("click", cycleSafeZoneColor);
}

function wireInfoModal() {
  els.infoBtn.addEventListener("click", () => {
    els.infoModal.hidden = false;
    els.infoModal.setAttribute("aria-hidden", "false");
  });
  els.infoModal.addEventListener("click", (e) => {
    if (e.target.dataset.closeInfo !== undefined) {
      els.infoModal.hidden = true;
      els.infoModal.setAttribute("aria-hidden", "true");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (
      e.key === "Escape" &&
      !e.defaultPrevented &&
      !els.infoModal.hidden
    ) {
      e.preventDefault();
      els.infoModal.hidden = true;
      els.infoModal.setAttribute("aria-hidden", "true");
    }
  });
}

function wireVideoModal() {
  const thumb = document.getElementById("video-thumb");
  const modal = document.getElementById("video-modal");
  const video = document.getElementById("overview-video");
  if (!thumb || !modal || !video) return;

  const open = () => {
    if (!video.src) video.src = "assets/overview.mp4";
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    video.play().catch(() => {});
  };
  const close = () => {
    video.pause();
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  };

  thumb.addEventListener("click", open);
  modal.addEventListener("click", (e) => {
    if (e.target.dataset.closeVideo !== undefined) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented && !modal.hidden) {
      e.preventDefault();
      close();
    }
  });
}

let urlInputTimer = null;
let lastTriedUrl = null;
let loadGeneration = 0;
function attemptUrlLoad(url) {
  if (!url || url === lastTriedUrl) return;
  lastTriedUrl = url;
  handleUrl(url);
}

function wireImageInput() {
  els.uploadBtn.addEventListener("click", () => els.fileInput.click());

  els.fileInput.addEventListener("change", () => {
    const file = els.fileInput.files?.[0];
    if (file) handleFile(file);
    els.fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((ev) =>
    els.canvasWrap.addEventListener(ev, (e) => {
      e.preventDefault();
      els.canvasWrap.classList.add("drag");
    })
  );
  ["dragleave", "dragend", "drop"].forEach((ev) =>
    els.canvasWrap.addEventListener(ev, (e) => {
      e.preventDefault();
      els.canvasWrap.classList.remove("drag");
    })
  );
  els.canvasWrap.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  els.clearImage.addEventListener("click", handleClearImage);

  document.addEventListener("paste", (e) => {
    const target = e.target;
    const inField = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");

    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          handleFile(file);
          return;
        }
      }
    }

    if (inField) return;
    const text = e.clipboardData?.getData("text")?.trim();
    if (text && /^https?:\/\//i.test(text)) {
      e.preventDefault();
      clearTimeout(urlInputTimer);
      attemptUrlLoad(text);
    }
  });
}

function wireFocalAndCrop() {
  els.focalAttributeHint.addEventListener("click", async () => {
    const attr = els.focalAttributeHint.dataset.attr;
    if (!attr) return;
    try {
      await navigator.clipboard.writeText(attr);
      const prev = els.focalAttributeHint.dataset.tooltip || "";
      els.focalAttributeHint.dataset.tooltip = "Copied!";
      els.focalAttributeHint.classList.add("copied");
      setTimeout(() => {
        els.focalAttributeHint.dataset.tooltip = prev;
        els.focalAttributeHint.classList.remove("copied");
      }, 1200);
    } catch (e) {}
  });

  els.focalPreset.addEventListener("change", () => {
    if (!state.image) return;
    setFocalFromPreset(els.focalPreset.value);
    if (!state.hasManualCrop) recomputeCropFromFocal();
    rerender();
    persistImageState();
    scheduleEstimate();
    updateFocalAttributeHint();
  });

  if (els.cropFocalPreset) {
    els.cropFocalPreset.addEventListener("change", () => {
      if (!state.image || !modalState.active) return;
      const [x, y] = els.cropFocalPreset.value.split(",").map(parseFloat);
      modalState.focal = { x, y };
      renderModal();
    });
  }

  els.outputW.addEventListener("input", () => {
    state.outputW = clampInt(els.outputW.value, 100, 6000, state.outputW);
    state.outputH = Math.max(1, Math.round(state.outputW / state.outputAspect));
    els.outputH.value = state.outputH;
    updateOutputDimensionLabels();
      if (state.image) recomputeCropFromFocal();
    rerender();
    persistImageState();
    scheduleEstimate();
  });
  els.outputH.addEventListener("input", () => {
    state.outputH = clampInt(els.outputH.value, 100, 6000, state.outputH);
    state.outputW = Math.max(1, Math.round(state.outputH * state.outputAspect));
    els.outputW.value = state.outputW;
    updateOutputDimensionLabels();
      if (state.image) recomputeCropFromFocal();
    rerender();
    persistImageState();
    scheduleEstimate();
  });

  els.maxResolution.addEventListener("input", () => {
    const idx = clampInt(els.maxResolution.value, 0, MAX_RES_PRESETS.length - 1, 0);
    state.maxResolution = MAX_RES_PRESETS[idx].value;
    updateMaxResolutionDisplay();
    if (!state.image) return;
    if (clampOutputToCap()) {
      syncOutputAndQualityToInputs();
      debouncedSliderEffects(() => {
        if (!state.hasManualCrop) recomputeCropFromFocal();
        rerender();
        persistImageState();
        scheduleEstimate();
      });
    }
  });

  els.resetCrop.addEventListener("click", () => {
    if (!state.image) return;
    state.hasManualCrop = false;
    state.crop = fullImageCrop();
    state.outputW = state.crop.w;
    state.outputH = state.crop.h;
    state.outputAspect = state.outputW / state.outputH;
    clampOutputToCap();
    syncOutputAndQualityToInputs();
    updateRemoveCropVisibility();
    rerender();
    syncCropUiFromState();
    persistImageState();
    scheduleEstimate();
  });
}

function applyDrag(drag, dx, dy, aspect) {
  const { handle, startCrop } = drag;
  let { x, y, w, h } = startCrop;

  if (handle === "move") {
    return { x: x + dx, y: y + dy, w, h };
  }

  const right = x + w;
  const bottom = y + h;

  if (handle.includes("e")) w += dx;
  if (handle.includes("w")) { x += dx; w -= dx; }
  if (handle.includes("s")) h += dy;
  if (handle.includes("n")) { y += dy; h -= dy; }

  if (w / h > aspect) {
    const newW = h * aspect;
    if (handle.includes("w")) x = right - newW;
    w = newW;
  } else {
    const newH = w / aspect;
    if (handle.includes("n")) y = bottom - newH;
    h = newH;
  }

  return { x, y, w, h };
}

function wireCompression() {
  els.quality.addEventListener("input", () => {
    const idx = clampInt(els.quality.value, 0, QUALITY_PRESETS.length - 1, 1);
    state.quality = QUALITY_PRESETS[idx].value;
    updateQualityDisplay();
    updateCompressionWarning();
    debouncedSliderEffects(() => {
      scheduleEstimate();
      persistImageState();
    });
  });

  const setCompareHoverOverlay = (active) => {
    if (state.compareHoverOverlay === active) return;
    state.compareHoverOverlay = active;
    syncCompareUi();
    rerender();
  };
  const startCompareHover = () => {
    if (!state.compressedBitmap) return;
    setCompareHoverOverlay(true);
  };
  const endCompareHover = () => {
    setCompareHoverOverlay(false);
  };
  const startComparePress = (e) => {
    if (!state.compressedBitmap) return;
    e.preventDefault();
    if (state.compareMode) return;
    state.compareMode = true;
    syncCompareUi();
    rerender();
  };
  const endComparePress = () => {
    if (!state.compareMode) return;
    state.compareMode = false;
    syncCompareUi();
    rerender();
  };
  els.compareBtn.addEventListener("pointerenter", startCompareHover);
  els.compareBtn.addEventListener("pointerleave", () => {
    endCompareHover();
    endComparePress();
  });
  els.compareBtn.addEventListener("pointerdown", startComparePress);
  els.compareBtn.addEventListener("pointerup", endComparePress);
  els.compareBtn.addEventListener("pointercancel", endComparePress);

  els.download.addEventListener("click", async () => {
    if (!state.image || !state.crop) return;
    els.download.disabled = true;
    const oldText = els.download.textContent;
    els.download.textContent = "Encoding…";
    try {
      const imageData = cropToImageData(state.image, state.crop, state.outputW, state.outputH);
      const bytes = await encodeJpegInWorker(imageData, state.quality);
      triggerDownload(bytes, suggestFilename(state.image.filename));
      state.estimatedBytes = bytes.byteLength;
      updateSizeEstimate();
    } catch (err) {
      showError(`Encoding failed: ${err.message || err}`);
    } finally {
      els.download.disabled = false;
      els.download.textContent = oldText;
    }
  });
}

let estimateTimer = null;
let estimateInFlight = false;
let estimateGeneration = 0;

let sliderEffectsTimer = null;
function debouncedSliderEffects(fn) {
  clearTimeout(sliderEffectsTimer);
  sliderEffectsTimer = setTimeout(fn, 200);
}
function scheduleEstimate() {
  if (!state.image || !state.crop) {
    setPreviewLoading(false);
    return;
  }
  estimateGeneration++;
  state.estimatedBytes = null;
  updateOutputMeta();
  setPreviewLoading(true);
  if (state.compressedBitmap?.close) state.compressedBitmap.close();
  state.compressedBitmap = null;
  state.compareMode = false;
  state.compareHoverOverlay = false;
  syncCompareUi();
  rerender();
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(runEstimate, 250);
}

async function runEstimate() {
  if (!state.image || !state.crop) {
    setPreviewLoading(false);
    return;
  }
  if (estimateInFlight) return;
  estimateInFlight = true;
  const gen = estimateGeneration;
  try {
    const imageData = cropToImageData(state.image, state.crop, state.outputW, state.outputH);
    const bytes = await encodeJpegInWorker(imageData, state.quality);
    if (gen !== estimateGeneration) return;
    state.estimatedBytes = bytes.byteLength;
    const blob = new Blob([bytes], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(blob);
    if (gen !== estimateGeneration) {
      bitmap.close?.();
      return;
    }
    if (state.compressedBitmap?.close) state.compressedBitmap.close();
    state.compressedBitmap = bitmap;
    rerender();
    updateSizeEstimate();
  } catch (err) {
    els.outputMetaSize.textContent = `Estimate failed: ${err.message || err}`;
    els.outputMetaSize.classList.remove("is-estimating");
    els.outputMetaSize.classList.add("is-error");
  } finally {
    estimateInFlight = false;
    if (gen !== estimateGeneration) {
      clearTimeout(estimateTimer);
      estimateTimer = setTimeout(runEstimate, 0);
    } else {
      setPreviewLoading(false);
    }
  }
}

function updateSizeEstimate() {
  if (!state.image) {
    updateOutputMeta();
    return;
  }
  updateOutputMeta();
}

function activateCropUi() {
  if (!state.image) return;
  modalState.active = true;
  modalState.crop = { ...state.crop };
  modalState.drag = null;
  modalState.removeCrop = false;
  modalState.focal = { ...state.focal };
  els.modal.hidden = false;
  els.modal.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    sizeModalCanvas();
    renderModal();
  });
}

function deactivateCropUi() {
  modalState.active = false;
  modalState.drag = null;
  modalState.removeCrop = false;
  modalState.focal = null;
  els.modal.hidden = true;
  els.modal.setAttribute("aria-hidden", "true");
}

function syncCropUiFromState() {
  if (!modalState.active) return;
  modalState.crop = { ...state.crop };
  modalState.focal = { ...state.focal };
  renderModal();
}

function sizeModalCanvas() {
  if (!state.image) return;
  const wrap = els.modalCanvas.parentElement;
  const maxW = Math.max(320, wrap.clientWidth);
  const maxH = Math.max(240, wrap.clientHeight);
  const aspect = state.image.width / state.image.height;
  let w = maxW;
  let h = w / aspect;
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  els.modalCanvas.width = Math.round(w);
  els.modalCanvas.height = Math.round(h);
  modalState.scale = w / state.image.width;
}

function renderModal() {
  if (!modalState.active || !state.image) return;
  const canvas = els.modalCanvas;
  const ctx = canvas.getContext("2d");
  const c = modalState.crop;
  const s = modalState.scale;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.image.bitmap, 0, 0, canvas.width, canvas.height);

  if (c) {
    const cx = c.x * s;
    const cy = c.y * s;
    const cw = c.w * s;
    const ch = c.h * s;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, canvas.width, cy);
    ctx.fillRect(0, cy + ch, canvas.width, canvas.height - (cy + ch));
    ctx.fillRect(0, cy, cx, ch);
    ctx.fillRect(cx + cw, cy, canvas.width - (cx + cw), ch);
    ctx.restore();

    drawModalCropSafeZone(ctx, { x: cx, y: cy, w: cw, h: ch }, s);

    ctx.save();
    ctx.strokeStyle = "rgba(47, 129, 247, 0.95)";
    ctx.lineWidth = 2;
    ctx.strokeRect(cx + 1, cy + 1, cw - 2, ch - 2);
    const handles = modalHandlePositions(cx, cy, cw, ch);
    ctx.fillStyle = "rgba(47, 129, 247, 0.95)";
    for (const h of handles) {
      ctx.fillRect(h.cx - 5, h.cy - 5, 10, 10);
    }
    ctx.restore();
  }

  updateCropSizeWarning(c);
}

function updateCropSizeWarning(crop) {
  if (!crop) {
    els.cropSizeWarning.hidden = true;
    els.cropSizeWarningText.textContent = "";
    els.cropFixBtn.hidden = true;
    return;
  }

  const outputW = cropModalOutputWidth(crop.w, crop.h);
  const outputH = cropModalOutputHeight(crop.w, crop.h);
  const max = Math.max(outputW, outputH);

  const suggestedMinW = Math.round((1920 - (state.settings.formWidth || 0)) / 100) * 100;
  const suggestedMinH = 1100;

  if (outputW < suggestedMinW || outputH < suggestedMinH) {
    els.cropSizeWarning.hidden = false;
    els.cropSizeWarningText.textContent = `Output is small (${outputW}×${outputH}). Suggested minimum: ${suggestedMinW}×${suggestedMinH}px.`;
    const cap = detailCap();
    const canFix = state.image &&
      Math.min(cap, state.image.width) >= suggestedMinW &&
      Math.min(cap, state.image.height) >= suggestedMinH;
    els.cropFixBtn.hidden = !canFix;
  } else if (max > detailCap()) {
    els.cropSizeWarning.hidden = false;
    els.cropSizeWarningText.textContent = `Output is large (${outputW}×${outputH}). Recommended longest side: 1500–2000px.`;
    els.cropFixBtn.hidden = true;
  } else {
    els.cropSizeWarning.hidden = true;
    els.cropSizeWarningText.textContent = "";
    els.cropFixBtn.hidden = true;
  }
}

function fixCropToMeetMin() {
  if (!state.image || !modalState.active || !modalState.crop) return;
  const fw = state.settings.formWidth || 0;
  const minW = Math.round((1920 - fw) / 100) * 100;
  const minH = 1100;
  const targetW = Math.min(state.image.width, Math.max(modalState.crop.w, minW));
  const targetH = Math.min(state.image.height, Math.max(modalState.crop.h, minH));
  const dw = targetW - modalState.crop.w;
  const dh = targetH - modalState.crop.h;
  let nx = modalState.crop.x - dw / 2;
  let ny = modalState.crop.y - dh / 2;
  if (nx < 0) nx = 0;
  if (ny < 0) ny = 0;
  if (nx + targetW > state.image.width) nx = state.image.width - targetW;
  if (ny + targetH > state.image.height) ny = state.image.height - targetH;
  modalState.crop = { x: nx, y: ny, w: targetW, h: targetH };
  commitModalCrop();
  syncCropUiFromState();
}

function drawModalCropSafeZone(ctx, rect, scale) {
  const safeZoneSettings = effectiveCropSafeZoneSettings();
  const outputW = cropModalOutputWidth(rect.w / scale, rect.h / scale);
  const safeZoneWidth = outputW > 0
    ? safeZoneSettings.safeZoneWidth * (rect.w / outputW)
    : 0;
  const warmZoneBandWidth = outputW > 0
    ? 30 * (rect.w / outputW)
    : 0;

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  ctx.translate(rect.x, rect.y);
  drawActiveSafeZone(
    ctx,
    { width: rect.w, height: rect.h },
    safeZoneWidth,
    modalState.focal ? modalState.focal.x : effectiveFocal().x,
    safeZoneSettings.safeZoneColor || "#00FF00",
    warmZoneBandWidth,
    safeZoneSettings.safeZoneFillAlpha,
    safeZoneSettings.safeZoneWarmColor
  );
  ctx.restore();
}

function cropModalOutputWidth(cropW, cropH) {
  const max = Math.max(cropW, cropH);
  if (max <= 2000) return cropW;
  return Math.max(1, Math.round(cropW * (2000 / max)));
}

function cropModalOutputHeight(cropW, cropH) {
  const max = Math.max(cropW, cropH);
  if (max <= 2000) return cropH;
  return Math.max(1, Math.round(cropH * (2000 / max)));
}

function modalHandlePositions(x, y, w, h) {
  return [
    { name: "nw", cx: x,         cy: y },
    { name: "n",  cx: x + w / 2, cy: y },
    { name: "ne", cx: x + w,     cy: y },
    { name: "e",  cx: x + w,     cy: y + h / 2 },
    { name: "se", cx: x + w,     cy: y + h },
    { name: "s",  cx: x + w / 2, cy: y + h },
    { name: "sw", cx: x,         cy: y + h },
    { name: "w",  cx: x,         cy: y + h / 2 },
  ];
}

function modalHitTest(px, py) {
  const c = modalState.crop;
  if (!c) return null;
  const s = modalState.scale;
  const x = c.x * s, y = c.y * s, w = c.w * s, h = c.h * s;
  for (const h0 of modalHandlePositions(x, y, w, h)) {
    if (Math.abs(px - h0.cx) <= 8 && Math.abs(py - h0.cy) <= 8) return h0.name;
  }
  if (px >= x && px <= x + w && py >= y && py <= y + h) return "move";
  return null;
}

function applyDragFree(drag, dx, dy) {
  const { handle, startCrop } = drag;
  let { x, y, w, h } = startCrop;
  if (handle === "move") return { x: x + dx, y: y + dy, w, h };
  if (handle.includes("e")) w += dx;
  if (handle.includes("w")) { x += dx; w -= dx; }
  if (handle.includes("s")) h += dy;
  if (handle.includes("n")) { y += dy; h -= dy; }
  if (w < 20) { if (handle.includes("w")) x = startCrop.x + startCrop.w - 20; w = 20; }
  if (h < 20) { if (handle.includes("n")) y = startCrop.y + startCrop.h - 20; h = 20; }
  return { x, y, w, h };
}

function modalCanvasCoords(e) {
  const rect = els.modalCanvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (els.modalCanvas.width / rect.width);
  const py = (e.clientY - rect.top) * (els.modalCanvas.height / rect.height);
  return { px, py };
}

function commitModalCrop() {
  if (!state.image || !modalState.crop) return;
  const c = modalState.crop;
  if (c.w < 20 || c.h < 20) {
    syncCropUiFromState();
    return;
  }
  state.crop = { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h) };
  state.outputW = state.crop.w;
  state.outputH = state.crop.h;
  state.outputAspect = state.outputW / state.outputH;
  state.hasManualCrop = !modalState.removeCrop;
  clampOutputToCap();
  if (modalState.focal) {
    state.focal = { ...modalState.focal };
  }
  syncOutputAndQualityToInputs();
  highlightFocalPreset();
  updateFocalAttributeHint();
  updateRemoveCropVisibility();
  rerender();
  persistImageState();
  scheduleEstimate();
}

function wireCropModal() {
  els.cropFixBtn.addEventListener("click", fixCropToMeetMin);

  els.modalCanvas.addEventListener("mousedown", (e) => {
    if (!modalState.active || !state.image) return;
    const { px, py } = modalCanvasCoords(e);
    const handle = modalHitTest(px, py);
    modalState.drag = {
      handle: handle || "new",
      startPx: px,
      startPy: py,
      startCrop: handle ? { ...modalState.crop } : null,
      moved: false,
    };
    modalState.removeCrop = false;
  });

  window.addEventListener("mousemove", (e) => {
    if (!modalState.drag || !modalState.active || !state.image) return;
    const { px, py } = modalCanvasCoords(e);
    const dxPx = px - modalState.drag.startPx;
    const dyPx = py - modalState.drag.startPy;
    if (!modalState.drag.moved && Math.hypot(dxPx, dyPx) < 3) return;
    modalState.drag.moved = true;

    if (modalState.drag.handle === "new") {
      const ix = modalState.drag.startPx / modalState.scale;
      const iy = modalState.drag.startPy / modalState.scale;
      const dxImg = px / modalState.scale - ix;
      const dyImg = py / modalState.scale - iy;
      modalState.crop = clampCrop(
        {
          x: dxImg < 0 ? ix + dxImg : ix,
          y: dyImg < 0 ? iy + dyImg : iy,
          w: Math.abs(dxImg),
          h: Math.abs(dyImg),
        },
        state.image
      );
    } else {
      const dx = dxPx / modalState.scale;
      const dy = dyPx / modalState.scale;
      modalState.crop = clampCrop(
        applyDragFree(modalState.drag, dx, dy),
        state.image
      );
    }
    renderModal();
  });

  window.addEventListener("mouseup", () => {
    if (!modalState.drag) return;
    const moved = modalState.drag.moved;
    modalState.drag = null;
    if (moved) commitModalCrop();
  });

  window.addEventListener("resize", () => {
    if (modalState.active) {
      sizeModalCanvas();
      renderModal();
    }
  });
}

function init() {
  syncSettingsToInputs();
  applyLayoutFromSettings();
  applySafeZoneColorVar();
  syncPresetUI();
  syncOutputAndQualityToInputs();
  highlightFocalPreset();
  wireSettingsInputs();
  wireImageInput();
  wireFocalAndCrop();
  wireCompression();
  wireCropModal();
  wireInfoModal();
  wireVideoModal();

  const ro = new ResizeObserver(() => rerender());
  ro.observe(els.canvas.parentElement);

  rerender();
}

init();
