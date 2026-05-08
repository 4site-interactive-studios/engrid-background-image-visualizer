import { loadSettings, saveSettings, loadImageState, saveImageState } from "./storage.js";
import {
  loadFromFile,
  loadFromUrl,
  computeCropFromFocalPoint,
  clampCrop,
  cropToImageData,
  formatBytes,
} from "./imagework.js";
import { fitCanvasToContainer, render, drawActiveSafeZone } from "./overlay.js";
import { encodeJpeg, triggerDownload, suggestFilename } from "./compress.js";

const $ = (id) => document.getElementById(id);
const MIN_RECOMMENDED_LONGEST_SIDE = 1500;
const MAX_RECOMMENDED_LONGEST_SIDE = 2000;
const MIN_RECOMMENDED_HEIGHT = 750;

const PRESETS = [
  { id: "ngs-left", name: "NGS - Left Layout", layout: "left", formWidth: 550, safeZoneWidth: 350 },
  { id: "nwf-left", name: "NWF - Left Layout", layout: "left", formWidth: 800, safeZoneWidth: 200 },
  { id: "oceana-left", name: "Oceana - Left Layout", layout: "left", formWidth: 680, safeZoneWidth: 350 },
  { id: "ran-left", name: "RAN - Left Layout", layout: "left", formWidth: 680, safeZoneWidth: 300 },
  { id: "shatterproof-left", name: "Shatterproof - Left Layout", layout: "left", formWidth: 640, safeZoneWidth: 350 },
  { id: "wwf-left", name: "WWF - Left Layout", layout: "left", formWidth: 1200, safeZoneWidth: 1200 },
];
const LAYOUT_LABEL = { left: "Left", center: "Center", right: "Right" };

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
    els.presetDetailsText.textContent = `${LAYOUT_LABEL[p.layout]} · ${p.formWidth}px form · ${p.safeZoneWidth}px safe zone`;
    els.formSafeZoneFieldset.classList.add("is-preset");
  } else {
    els.presetDetailsText.textContent = "";
    els.formSafeZoneFieldset.classList.remove("is-preset");
  }
}

function applyPreset(id) {
  const p = PRESETS.find((p) => p.id === id);
  state.settings.preset = id;
  if (p) {
    state.settings.layout = p.layout;
    state.settings.formWidth = p.formWidth;
    state.settings.safeZoneWidth = p.safeZoneWidth;
  }
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
  quality: 75,
  scale: 1,
  estimatedBytes: null,
  compressedBitmap: null,
  compareMode: false,
  compareHoverOverlay: false,
  hasManualCrop: false,
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
  presetDetailsText: $("preset-details-text"),
  formSafeZoneFieldset: document.querySelector(".form-safezone-fieldset"),
  safeZoneColor: $("safe-zone-color"),
  resetSafeZoneColor: $("reset-safe-zone-color"),
  infoBtn: $("info-btn"),
  infoModal: $("info-modal"),
  canvasWrap: $("canvas-wrap"),
  uploadBtn: $("upload-btn"),
  fileInput: $("file-input"),
  clearImageRow: $("clear-image-row"),
  clearImage: $("clear-image"),
  canvasClear: $("canvas-clear"),
  imageUrl: $("image-url"),
  metaDims: $("meta-dims"),
  metaSize: $("meta-size"),
  outputMetaLabel: $("output-meta-label"),
  outputMetaDims: $("output-meta-dims"),
  outputMetaSize: $("output-meta-size"),
  error: $("error"),
  canvas: $("preview-canvas"),
  previewSpinner: $("preview-spinner"),
  compareOverlayLabel: $("compare-overlay-label"),
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
  cropOpen: $("crop-open"),
  resizeTo2000: $("resize-to-2000"),
  useIntrinsic: $("use-intrinsic"),
  compareBtn: $("compare-btn"),
  quality: $("quality"),
  qualityOut: $("quality-out"),
  compressionWarning: $("compression-warning"),
  download: $("download"),
  modal: $("crop-modal"),
  modalCanvas: $("modal-canvas"),
  cropSave: $("crop-save"),
  cropSizeReadout: $("crop-size-readout"),
  cropSizeWarning: $("crop-size-warning"),
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
  els.safeZoneColor.value = state.settings.safeZoneColor || "#00FF00";
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
  els.cropFocalSetting.hidden = isCenter;
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
    "0.5,0.5": "center center",
    "0.5,1": "center bottom",
    "1,0": "right top",
    "1,0.5": "right center",
    "1,1": "right bottom",
  };
  const value = `${state.focal.x},${state.focal.y}`;
  const position = posMap[value];
  if (position) {
    els.focalAttributeHint.textContent = `ENgrid attribute: data-background-position="${position}"`;
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
  updateUseIntrinsicVisibility();
  updateOutputMeta();
  els.outputW.value = state.outputW;
  els.outputH.value = state.outputH;
  els.quality.value = state.quality;
  updateQualityDisplay();
  updateCompressionWarning();
  updateUseIntrinsicVisibility();
}

function updateQualityDisplay() {
  const min = Number(els.quality.min) || 0;
  const max = Number(els.quality.max) || 100;
  const pct = ((state.quality - min) / (max - min)) * 100;
  els.qualityOut.value = state.quality;
  els.quality.style.setProperty("--quality-pos", `${pct}%`);
  els.qualityOut.style.setProperty("--quality-pos", `${pct}%`);
}

function syncCompareUi() {
  els.compareBtn.classList.toggle("active", state.compareMode);
  els.compareBtn.textContent = state.compareMode ? "Original" : "Compare";

  const hide = state.compareMode || state.compareHoverOverlay;
  els.canvasClear.hidden = hide || !state.image;
  els.infoBtn.hidden = hide || !state.image;

  if (state.compareMode && state.image) {
    els.compareOverlayLabel.hidden = false;
    els.compareOverlayLabel.textContent = "Original";
  } else if (state.compareHoverOverlay && state.image) {
    els.compareOverlayLabel.hidden = false;
    els.compareOverlayLabel.textContent = "Compressed";
  } else {
    els.compareOverlayLabel.hidden = true;
  }
}

function updateCompressionWarning() {
  if (state.quality < 40) {
    els.compressionWarning.hidden = false;
    els.compressionWarning.textContent = "Quality is very low. Image artifacts may be visible.";
  } else if (state.quality > 80) {
    els.compressionWarning.hidden = false;
    els.compressionWarning.textContent = "Quality is high. File size savings may be limited.";
  } else {
    els.compressionWarning.hidden = true;
    els.compressionWarning.textContent = "";
  }
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
  updateUseIntrinsicVisibility();
  if (!state.image) {
    els.outputMetaLabel.textContent = "Output:";
    els.outputMetaDims.textContent = "";
    els.outputMetaSize.textContent = "";
    return;
  }

  els.outputMetaLabel.textContent = state.hasManualCrop ? "Cropped:" : "Output:";
  els.outputMetaDims.textContent = `${state.outputW} × ${state.outputH}`;
  els.outputMetaSize.textContent = state.estimatedBytes != null
    ? formatBytes(state.estimatedBytes)
    : "Estimating...";
}

function outputIntrinsicDimensions() {
  if (!state.image) return null;
  return {
    w: state.hasManualCrop && state.crop ? Math.round(state.crop.w) : state.image.width,
    h: state.hasManualCrop && state.crop ? Math.round(state.crop.h) : state.image.height,
  };
}

function updateUseIntrinsicVisibility() {
  const intrinsic = outputIntrinsicDimensions();
  const isIntrinsic = intrinsic &&
    state.outputW === intrinsic.w &&
    state.outputH === intrinsic.h;

  els.useIntrinsic.hidden = !intrinsic || isIntrinsic;
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
}

function fullImageCrop() {
  return { x: 0, y: 0, w: state.image.width, h: state.image.height };
}

function updateResizeLink() {
  if (!state.image) {
    els.resizeTo2000.hidden = true;
    return;
  }
  const max = Math.max(state.outputW, state.outputH);
  els.resizeTo2000.hidden = max <= MAX_RECOMMENDED_LONGEST_SIDE;
}

function resizeOutputToMax2000() {
  if (!state.image) return;
  if (state.outputW >= state.outputH) {
    state.outputW = 2000;
    state.outputH = Math.max(1, Math.round(2000 / state.outputAspect));
  } else {
    state.outputH = 2000;
    state.outputW = Math.max(1, Math.round(2000 * state.outputAspect));
  }
  syncOutputAndQualityToInputs();
  rerender();
  persistImageState();
  scheduleEstimate();
  updateResizeLink();
}

function updateRemoveCropVisibility() {
  els.resetCrop.hidden = !state.hasManualCrop;
  els.cropOpen.textContent = state.hasManualCrop ? "Edit crop..." : "Crop";
}

function snapFocalToPreset(focal) {
  const snap = (v) => (v < 0.25 ? 0 : v > 0.75 ? 1 : 0.5);
  return { x: snap(focal.x), y: snap(focal.y) };
}

function highlightFocalPreset() {
  const value = `${state.focal.x},${state.focal.y}`;
  els.focalPreset.value = value;
  els.cropFocalPreset.value = value;
}

function setFocalFromPreset(value) {
  const [x, y] = value.split(",").map(parseFloat);
  state.focal = { x, y };
  highlightFocalPreset();
}

async function applyImage(image) {
  state.image = image;
  els.sourceInfo.hidden = false;
  els.metaDims.textContent = `${image.width} × ${image.height}`;
  els.metaSize.textContent = formatBytes(image.byteLength);

  const saved = loadImageState(image.hash);
  if (saved) {
    state.focal = snapFocalToPreset(saved.focalPoint || { x: 0.5, y: 0.5 });
    state.outputW = saved.outputW || image.width;
    state.outputH = saved.outputH || image.height;
    state.quality = saved.quality ?? 75;
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
    state.quality = 75;
    state.crop = computeCropFromFocalPoint(image, effectiveFocal(), state.outputW, state.outputH);
  }

  state.outputAspect = state.outputW / state.outputH;
  syncOutputAndQualityToInputs();
  highlightFocalPreset();
  updateFocalAttributeHint();
  els.download.disabled = false;
  els.cropOpen.disabled = false;
  els.clearImageRow.hidden = false;
  els.canvasClear.hidden = false;
  els.infoBtn.hidden = false;
  els.compareBtn.hidden = false;
  els.layout.classList.add("has-image");
  updateRemoveCropVisibility();
  updateResizeLink();
  state.estimatedBytes = null;
  rerender();
  scheduleEstimate();
}

function handleClearImage() {
  state.image = null;
  state.focal = { x: 0.5, y: 0.5 };
  state.crop = null;
  state.outputW = 1800;
  state.outputH = 1200;
  state.outputAspect = 1800 / 1200;
  state.quality = 75;
  state.estimatedBytes = null;
  els.sourceInfo.hidden = true;
  els.metaDims.textContent = "";
  els.metaSize.textContent = "";
  els.cropOpen.disabled = true;
  els.download.disabled = true;
  els.clearImageRow.hidden = true;
  els.canvasClear.hidden = true;
  els.infoBtn.hidden = true;
  els.compareBtn.hidden = true;
  state.hasManualCrop = false;
  if (state.compressedBitmap?.close) state.compressedBitmap.close();
  state.compressedBitmap = null;
  state.compareMode = false;
  state.compareHoverOverlay = false;
  updateRemoveCropVisibility();
  updateFocalAttributeHint();
  syncCompareUi();
  els.imageUrl.value = "";
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
  els.safeZoneColor.addEventListener("input", () => {
    state.settings.safeZoneColor = els.safeZoneColor.value;
    persistSettings();
    rerender();
  });
  els.resetSafeZoneColor.addEventListener("click", () => {
    state.settings.safeZoneColor = "#00FF00";
    els.safeZoneColor.value = "#00FF00";
    persistSettings();
    rerender();
  });
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
  els.canvasClear.addEventListener("click", handleClearImage);

  els.imageUrl.addEventListener("input", () => {
    clearTimeout(urlInputTimer);
    const v = els.imageUrl.value.trim();
    if (/^https?:\/\/\S+\.\S+/i.test(v)) {
      urlInputTimer = setTimeout(() => attemptUrlLoad(v), 600);
    }
  });
  els.imageUrl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(urlInputTimer);
      attemptUrlLoad(els.imageUrl.value.trim());
    }
  });

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

    if (inField && target !== els.imageUrl) return;
    const text = e.clipboardData?.getData("text")?.trim();
    if (text && /^https?:\/\//i.test(text)) {
      e.preventDefault();
      clearTimeout(urlInputTimer);
      els.imageUrl.value = text;
      attemptUrlLoad(text);
    }
  });
}

function wireFocalAndCrop() {
  els.focalPreset.addEventListener("change", () => {
    if (!state.image) return;
    setFocalFromPreset(els.focalPreset.value);
    if (!state.hasManualCrop) recomputeCropFromFocal();
    rerender();
    persistImageState();
    scheduleEstimate();
    updateFocalAttributeHint();
  });

  els.cropFocalPreset.addEventListener("change", () => {
    if (!state.image || !modalState.active) return;
    const [x, y] = els.cropFocalPreset.value.split(",").map(parseFloat);
    modalState.focal = { x, y };
    renderModal();
  });

  els.outputW.addEventListener("input", () => {
    state.outputW = clampInt(els.outputW.value, 100, 6000, state.outputW);
    state.outputH = Math.max(1, Math.round(state.outputW / state.outputAspect));
    els.outputH.value = state.outputH;
    updateOutputDimensionLabels();
    updateUseIntrinsicVisibility();
    if (state.image) recomputeCropFromFocal();
    rerender();
    persistImageState();
    scheduleEstimate();
    updateResizeLink();
  });
  els.outputH.addEventListener("input", () => {
    state.outputH = clampInt(els.outputH.value, 100, 6000, state.outputH);
    state.outputW = Math.max(1, Math.round(state.outputH * state.outputAspect));
    els.outputW.value = state.outputW;
    updateOutputDimensionLabels();
    updateUseIntrinsicVisibility();
    if (state.image) recomputeCropFromFocal();
    rerender();
    persistImageState();
    scheduleEstimate();
    updateResizeLink();
  });

  els.resizeTo2000.addEventListener("click", resizeOutputToMax2000);

  els.useIntrinsic.addEventListener("click", () => {
    if (!state.image) return;
    const intrinsic = outputIntrinsicDimensions();
    if (!intrinsic) return;
    state.outputW = intrinsic.w;
    state.outputH = intrinsic.h;
    state.outputAspect = state.outputW / state.outputH;
    syncOutputAndQualityToInputs();
    if (!state.hasManualCrop) recomputeCropFromFocal();
    rerender();
    persistImageState();
    scheduleEstimate();
    updateResizeLink();
  });

  els.resetCrop.addEventListener("click", () => {
    if (!state.image) return;
    if (modalState.active) {
      modalState.removeCrop = true;
      modalState.crop = fullImageCrop();
      renderModal();
      return;
    }

    state.hasManualCrop = false;
    state.crop = fullImageCrop();
    state.outputW = state.crop.w;
    state.outputH = state.crop.h;
    state.outputAspect = state.outputW / state.outputH;
    syncOutputAndQualityToInputs();
    updateRemoveCropVisibility();
    updateResizeLink();
    rerender();
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
    state.quality = clampInt(els.quality.value, 1, 100, 75);
    updateQualityDisplay();
    updateCompressionWarning();
    scheduleEstimate();
    persistImageState();
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
      const bytes = await encodeJpeg(imageData, state.quality);
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
    const bytes = await encodeJpeg(imageData, state.quality);
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

function openCropModal() {
  if (!state.image) return;
  modalState.active = true;
  modalState.crop = { ...state.crop };
  modalState.drag = null;
  modalState.removeCrop = false;
  modalState.focal = { ...state.focal };
  els.cropFocalPreset.value = `${modalState.focal.x},${modalState.focal.y}`;
  els.modal.hidden = false;
  els.modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  requestAnimationFrame(() => {
    sizeModalCanvas();
    renderModal();
    els.cropSave.focus();
  });
}

function closeCropModal() {
  modalState.active = false;
  modalState.drag = null;
  modalState.removeCrop = false;
  modalState.focal = null;
  els.modal.hidden = true;
  els.modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  els.cropOpen.focus();
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

  els.cropSizeReadout.textContent = c
    ? `Crop: ${Math.round(c.w)} × ${Math.round(c.h)} px`
    : "";
  updateCropSizeWarning(c);
}

function updateCropSizeWarning(crop) {
  if (!crop) {
    els.cropSizeWarning.hidden = true;
    els.cropSizeWarning.textContent = "";
    return;
  }

  const outputW = cropModalOutputWidth(crop.w, crop.h);
  const outputH = cropModalOutputHeight(crop.w, crop.h);
  const max = Math.max(outputW, outputH);

  if (max < MIN_RECOMMENDED_LONGEST_SIDE || outputH < MIN_RECOMMENDED_HEIGHT) {
    els.cropSizeWarning.hidden = false;
    els.cropSizeWarning.textContent = `Output is small (${outputW}×${outputH}). Recommended longest side: 1500–2000px; minimum height: 750px.`;
  } else if (max > MAX_RECOMMENDED_LONGEST_SIDE) {
    els.cropSizeWarning.hidden = false;
    els.cropSizeWarning.textContent = `Output is large (${outputW}×${outputH}). Recommended longest side: 1500–2000px.`;
  } else {
    els.cropSizeWarning.hidden = true;
    els.cropSizeWarning.textContent = "";
  }
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

function wireCropModal() {
  els.cropOpen.addEventListener("click", openCropModal);

  els.modal.addEventListener("click", (e) => {
    if (e.target.dataset.close !== undefined) closeCropModal();
  });

  document.addEventListener("keydown", (e) => {
    if (modalState.active && e.key === "Escape") {
      e.preventDefault();
      closeCropModal();
    }
  });

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
    if (modalState.drag) modalState.drag = null;
  });

  els.cropSave.addEventListener("click", () => {
    if (!state.image || !modalState.crop) {
      closeCropModal();
      return;
    }
    const c = modalState.crop;
    if (c.w >= 20 && c.h >= 20) {
      state.crop = { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h) };
      state.outputW = state.crop.w;
      state.outputH = state.crop.h;
      state.outputAspect = state.outputW / state.outputH;
      if (Math.max(state.outputW, state.outputH) > 2000) {
        const ratio = 2000 / Math.max(state.outputW, state.outputH);
        state.outputW = Math.max(1, Math.round(state.outputW * ratio));
        state.outputH = Math.max(1, Math.round(state.outputH * ratio));
        state.outputAspect = state.outputW / state.outputH;
      }
      state.hasManualCrop = !modalState.removeCrop;
      if (modalState.focal) {
        state.focal = { ...modalState.focal };
      }
      syncOutputAndQualityToInputs();
      highlightFocalPreset();
      updateFocalAttributeHint();
      updateRemoveCropVisibility();
      updateResizeLink();
      rerender();
      persistImageState();
      scheduleEstimate();
    }
    closeCropModal();
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
