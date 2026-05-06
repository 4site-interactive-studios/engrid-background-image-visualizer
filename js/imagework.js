export async function hashBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function decodeBytes(bytes, mimeType, filename) {
  const blob = new Blob([bytes], { type: mimeType || "image/jpeg" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImageElement(url);
    return {
      bitmap: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      bytes,
      mimeType: mimeType || blob.type,
      filename: filename || "image",
      byteLength: bytes.byteLength,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImageElement(src, opts = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (opts.crossOrigin) img.crossOrigin = opts.crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode image"));
    img.src = src;
  });
}

export async function loadFromFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await hashBytes(bytes);
  const decoded = await decodeBytes(bytes, file.type, file.name);
  return { ...decoded, hash };
}

export async function loadFromUrl(url) {
  let bytes = null;
  let mimeType = null;
  let fetchErr = null;

  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    mimeType = res.headers.get("content-type") || "";
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    fetchErr = err;
  }

  if (bytes) {
    const hash = await hashBytes(bytes);
    const filename = url.split("/").pop().split("?")[0] || "image";
    const decoded = await decodeBytes(bytes, mimeType, filename);
    return { ...decoded, hash };
  }

  try {
    const img = await loadImageElement(url, { crossOrigin: "anonymous" });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    let blob;
    try {
      blob = await new Promise((res, rej) =>
        canvas.toBlob(
          (b) => (b ? res(b) : rej(new Error("toBlob failed"))),
          "image/jpeg",
          0.95
        )
      );
    } catch {
      throw new Error(
        "This host doesn't allow cross-origin reads. Download the image locally and drop it here."
      );
    }
    const ab = await blob.arrayBuffer();
    const fallbackBytes = new Uint8Array(ab);
    const hash = await hashBytes(fallbackBytes);
    const filename = url.split("/").pop().split("?")[0] || "image";
    return {
      bitmap: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      bytes: fallbackBytes,
      mimeType: blob.type,
      filename,
      byteLength: fallbackBytes.byteLength,
      hash,
    };
  } catch (err) {
    if (fetchErr) {
      throw new Error(
        "Couldn't load this URL. The host may not allow cross-origin requests. Download the image locally and drop it here."
      );
    }
    throw err;
  }
}

export function computeCropFromFocalPoint(image, focal, outputW, outputH) {
  const sourceAspect = image.width / image.height;
  const targetAspect = outputW / outputH;

  let cropW, cropH;
  if (sourceAspect > targetAspect) {
    cropH = image.height;
    cropW = cropH * targetAspect;
  } else {
    cropW = image.width;
    cropH = cropW / targetAspect;
  }

  let cropX = focal.x * image.width - cropW / 2;
  let cropY = focal.y * image.height - cropH / 2;

  cropX = Math.max(0, Math.min(cropX, image.width - cropW));
  cropY = Math.max(0, Math.min(cropY, image.height - cropH));

  return {
    x: Math.round(cropX),
    y: Math.round(cropY),
    w: Math.round(cropW),
    h: Math.round(cropH),
  };
}

export function clampCrop(crop, image) {
  let { x, y, w, h } = crop;
  w = Math.max(20, Math.min(w, image.width));
  h = Math.max(20, Math.min(h, image.height));
  x = Math.max(0, Math.min(x, image.width - w));
  y = Math.max(0, Math.min(y, image.height - h));
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
  };
}

export function cropToImageData(image, crop, outputW, outputH) {
  const canvas = document.createElement("canvas");
  canvas.width = outputW;
  canvas.height = outputH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image.bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, outputW, outputH);
  return ctx.getImageData(0, 0, outputW, outputH);
}

export function formatBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
