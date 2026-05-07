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
  safeZoneColor: $("safe-zone-color"),
  resetSafeZoneColor: $("reset-safe-zone-color"),
  infoBtn: $("info-btn"),
  infoModal: $("info-modal"),
  canvasWrap: $("canvas-wrap"),
  uploadBtn: $("upload-btn"),
  fileInput: $("file-input"),
  clearImage: $("clear-image"),
  imageUrl: $("image-url"),
  metaDims: $("meta-dims"),
  metaSize: $("meta-size"),
  error: $("error"),
  canvas: $("preview-canvas"),
  previewSpinner: $("preview-spinner"),
  emptyState: $("empty-state"),
  sourceInfo: $("source-info"),
  focalPreset: $("focal-preset"),
  cropFocalPreset: $("crop-focal-preset"),
  outputWLabel: $("output-w-label"),
  outputHLabel: $("output-h-label"),
  outputW: $("output-w"),
  outputH: $("output-h"),
  resetCrop: $("reset-crop"),
  cropOpen: $("crop-open"),
  sizeWarning: $("size-warning"),
  sizeWarningText: $("size-warning-text"),
  resizeTo2000: $("resize-to-2000"),
  useIntrinsic: $("use-intrinsic"),
  autoResize: $("auto-resize"),
  compareBtn: $("compare-btn"),
  quality: $("quality"),
  qualityOut: $("quality-out"),
  compressionWarning: $("compression-warning"),
  sizeEstimate: $("size-estimate"),
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
  els.autoResize.checked = state.settings.autoResizeOnLoad !== false;
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
  els.outputW.value = state.outputW;
  els.outputH.value = state.outputH;
  els.quality.value = state.quality;
  els.qualityOut.value = state.quality;
  updateCompressionWarning();
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

  els.outputWLabel.textContent = isResized ? "Resized Width" : "Intrinsic Width";
  els.outputHLabel.textContent = isResized ? "Resized Height" : "Intrinsic Height";
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
  els.useIntrinsic.hidden = !intrinsic || (
    state.outputW === intrinsic.w &&
    state.outputH === intrinsic.h
  );
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

function updateSizeWarning() {
  els.sizeWarning.hidden = true;
  els.sizeWarningText.textContent = "";
  els.resizeTo2000.hidden = true;

  if (!state.image) {
    return;
  }
  const max = Math.max(state.outputW, state.outputH);

  if (max < MIN_RECOMMENDED_LONGEST_SIDE || state.outputH < MIN_RECOMMENDED_HEIGHT) {
    els.sizeWarning.hidden = false;
    els.sizeWarningText.textContent = `Output is small (${state.outputW}×${state.outputH}). Recommended longest side: 1500–2000px; minimum height: 750px.`;
  } else if (max > MAX_RECOMMENDED_LONGEST_SIDE) {
    els.sizeWarning.hidden = false;
    els.sizeWarningText.textContent = `Output is large (${state.outputW}×${state.outputH}). Recommended longest side: 1500–2000px.`;
    els.resizeTo2000.hidden = false;
  }
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
  updateSizeWarning();
}

function updateRemoveCropVisibility() {
  els.resetCrop.hidden = !state.hasManualCrop;
  els.cropOpen.textContent = state.hasManualCrop ? "Edit crop..." : "Crop image...";
}

function snapFocalToPreset(focal) {
  const snap = (v) => (v < 0.25 ? 0 : v > 0.75 ? 1 : 0.5);
  return { x: snap(focal.x), y: snap(focal.y) };
}

function highlightFocalPreset() {
  const focal = effectiveFocal();
  const value = `${focal.x},${focal.y}`;
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
    state.crop = saved.cropFrame
      ? clampCrop(saved.cropFrame, image)
      : computeCropFromFocalPoint(image, effectiveFocal(), state.outputW, state.outputH);
  } else {
    state.hasManualCrop = false;
    state.focal = { x: 0.5, y: 0.5 };
    if (state.settings.autoResizeOnLoad && Math.max(image.width, image.height) > 2000) {
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
  els.download.disabled = false;
  els.cropOpen.disabled = false;
  els.clearImage.hidden = false;
  els.infoBtn.hidden = false;
  els.compareBtn.hidden = false;
  els.layout.classList.add("has-image");
  updateRemoveCropVisibility();
  updateSizeWarning();
  state.estimatedBytes = null;
  els.sizeEstimate.textContent = "";
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
  els.clearImage.hidden = true;
  els.infoBtn.hidden = true;
  els.compareBtn.hidden = true;
  state.hasManualCrop = false;
  if (state.compressedBitmap?.close) state.compressedBitmap.close();
    state.compressedBitmap = null;
    state.compareMode = false;
    state.compareHoverOverlay = false;
    setPreviewLoading(false);
    updateRemoveCropVisibility();
    els.imageUrl.value = "";
  els.sizeEstimate.textContent = "";
  els.layout.classList.remove("has-image");
  els.sizeWarning.hidden = true;
  lastTriedUrl = null;
  clearError();
  syncOutputAndQualityToInputs();
  highlightFocalPreset();
  rerender();
}

async function handleFile(file) {
  clearError();
  try {
    const image = await loadFromFile(file);
    await applyImage(image);
  } catch (err) {
    showError(err.message || String(err));
  }
}

async function handleUrl(url) {
  clearError();
  if (!url) return;
  try {
    const image = await loadFromUrl(url);
    await applyImage(image);
  } catch (err) {
    showError(err.message || String(err));
  }
}

function wireSettingsInputs() {
  els.formWidth.addEventListener("input", () => {
    state.settings.formWidth = clampInt(els.formWidth.value, 100, 2000, 550);
    persistSettings();
    applyLayoutFromSettings();
    rerender();
  });
  els.formLayout.addEventListener("change", () => {
    state.settings.layout = els.formLayout.value;
    persistSettings();
    applyLayoutFromSettings();
    if (state.image && !state.hasManualCrop) recomputeCropFromFocal();
    rerender();
  });
  els.safeZoneWidth.addEventListener("input", () => {
    state.settings.safeZoneWidth = clampInt(els.safeZoneWidth.value, 50, 1000, 350);
    persistSettings();
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

let urlInputTimer = null;
let lastTriedUrl = null;
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
  });

  els.cropFocalPreset.addEventListener("change", () => {
    if (!state.image) return;
    setFocalFromPreset(els.cropFocalPreset.value);
    renderModal();
    rerender();
    persistImageState();
    scheduleEstimate();
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
    updateSizeWarning();
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
    updateSizeWarning();
  });

  els.resizeTo2000.addEventListener("click", resizeOutputToMax2000);

  els.useIntrinsic.addEventListener("click", () => {
    if (!state.image) return;
    state.outputW = state.hasManualCrop && state.crop
      ? Math.round(state.crop.w)
      : state.image.width;
    state.outputH = state.hasManualCrop && state.crop
      ? Math.round(state.crop.h)
      : state.image.height;
    state.outputAspect = state.outputW / state.outputH;
    syncOutputAndQualityToInputs();
    if (!state.hasManualCrop) recomputeCropFromFocal();
    rerender();
    persistImageState();
    scheduleEstimate();
    updateSizeWarning();
  });

  els.autoResize.addEventListener("change", () => {
    state.settings.autoResizeOnLoad = els.autoResize.checked;
    persistSettings();
  });

  els.resetCrop.addEventListener("click", () => {
    if (!state.image) return;
    if (modalState.active) {
      modalState.removeCrop = true;
      modalState.crop = computeCropFromFocalPoint(
        state.image,
        effectiveFocal(),
        state.outputW,
        state.outputH
      );
      renderModal();
      return;
    }

    state.hasManualCrop = false;
    state.crop = computeCropFromFocalPoint(
      state.image,
      effectiveFocal(),
      state.outputW,
      state.outputH
    );
    updateRemoveCropVisibility();
    updateSizeWarning();
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
    els.qualityOut.value = state.quality;
    updateCompressionWarning();
    scheduleEstimate();
    persistImageState();
  });

  const updateCompareButton = () => {
    els.compareBtn.classList.toggle("active", state.compareMode);
    els.compareBtn.textContent = state.compareMode ? "Showing original" : "Hold to compare original";
  };
  const setCompareHoverOverlay = (active) => {
    if (state.compareHoverOverlay === active) return;
    state.compareHoverOverlay = active;
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
    updateCompareButton();
    rerender();
  };
  const endComparePress = () => {
    if (!state.compareMode) return;
    state.compareMode = false;
    updateCompareButton();
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
  setPreviewLoading(true);
  if (state.compressedBitmap?.close) state.compressedBitmap.close();
  state.compressedBitmap = null;
  if (state.compareMode) {
    state.compareMode = false;
    els.compareBtn.classList.remove("active");
    els.compareBtn.textContent = "Hold to compare original";
  }
  state.compareHoverOverlay = false;
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
  els.sizeEstimate.textContent = `Estimating @ Q${state.quality}…`;
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
    els.sizeEstimate.textContent = `Estimate failed: ${err.message || err}`;
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
    els.sizeEstimate.textContent = "";
    return;
  }
  const orig = formatBytes(state.image.byteLength);
  const out = state.estimatedBytes != null ? formatBytes(state.estimatedBytes) : "—";
  els.sizeEstimate.textContent = `Original: ${orig} → Optimized: ${out}`;
}

function openCropModal() {
  if (!state.image) return;
  modalState.active = true;
  modalState.crop = { ...state.crop };
  modalState.drag = null;
  modalState.removeCrop = false;
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
    effectiveFocal().x,
    safeZoneSettings.safeZoneColor || "#00FF00",
    warmZoneBandWidth,
    safeZoneSettings.safeZoneFillAlpha,
    safeZoneSettings.safeZoneWarmColor
  );
  ctx.restore();
}

function cropModalOutputWidth(cropW, cropH) {
  if (!state.settings.autoResizeOnLoad) return cropW;
  const max = Math.max(cropW, cropH);
  if (max <= 2000) return cropW;
  return Math.max(1, Math.round(cropW * (2000 / max)));
}

function cropModalOutputHeight(cropW, cropH) {
  if (!state.settings.autoResizeOnLoad) return cropH;
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
      if (modalState.removeCrop) {
        state.hasManualCrop = false;
      } else {
        state.outputW = state.crop.w;
        state.outputH = state.crop.h;
        state.outputAspect = state.outputW / state.outputH;
        if (state.settings.autoResizeOnLoad && Math.max(state.outputW, state.outputH) > 2000) {
          const ratio = 2000 / Math.max(state.outputW, state.outputH);
          state.outputW = Math.max(1, Math.round(state.outputW * ratio));
          state.outputH = Math.max(1, Math.round(state.outputH * ratio));
          state.outputAspect = state.outputW / state.outputH;
        }
        state.hasManualCrop = true;
      }
      syncOutputAndQualityToInputs();
      highlightFocalPreset();
      updateRemoveCropVisibility();
      updateSizeWarning();
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
  syncOutputAndQualityToInputs();
  highlightFocalPreset();
  wireSettingsInputs();
  wireImageInput();
  wireFocalAndCrop();
  wireCompression();
  wireCropModal();
  wireInfoModal();

  const ro = new ResizeObserver(() => rerender());
  ro.observe(els.canvas.parentElement);

  rerender();
}

init();
