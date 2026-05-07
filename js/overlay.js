const COLORS = {
  formFill: "rgba(31, 38, 47, 0.97)",
  formMaxStroke: "rgba(248, 81, 73, 0.95)",
  formMinStroke: "rgba(210, 153, 34, 0.95)",
  crop: "rgba(47, 129, 247, 0.95)",
  cropFill: "rgba(47, 129, 247, 0.08)",
  focal: "#ffffff",
  focalStroke: "#000000",
};

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const v = h.length === 3
    ? h.split("").map((c) => c + c).join("")
    : h;
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const HANDLE_SIZE = 10;

export function fitCanvasToContainer(canvas, container) {
  const w = Math.max(1, container.clientWidth);
  const h = Math.max(1, container.clientHeight);
  canvas.width = Math.round(w);
  canvas.height = Math.round(h);
}

export function render({ canvas, image, settings, focal, crop }) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const displayCrop = crop || { x: 0, y: 0, w: image.width, h: image.height };
  const canvasAspect = canvas.width / canvas.height;
  const cropAspect = displayCrop.w / displayCrop.h;
  const fx = focal ? focal.x : 0.5;
  const fy = focal ? focal.y : 0.5;

  let srcX, srcY, srcW, srcH;
  if (canvasAspect > cropAspect) {
    srcW = displayCrop.w;
    srcH = displayCrop.w / canvasAspect;
    srcX = displayCrop.x;
    srcY = displayCrop.y + (displayCrop.h - srcH) * fy;
  } else {
    srcH = displayCrop.h;
    srcW = displayCrop.h * canvasAspect;
    srcX = displayCrop.x + (displayCrop.w - srcW) * fx;
    srcY = displayCrop.y;
  }

  ctx.drawImage(
    image.bitmap,
    srcX, srcY, srcW, srcH,
    0, 0, canvas.width, canvas.height
  );

  drawActiveSafeZone(
    ctx,
    canvas,
    settings.safeZoneWidth,
    focal ? focal.x : 0.5,
    settings.safeZoneColor || "#00FF00"
  );
}

export function drawActiveSafeZone(ctx, canvas, columnWidthPx, focalX, color) {
  const colW = Math.round(Math.min(columnWidthPx, canvas.width));
  if (colW <= 0) return;

  let x;
  if (focalX <= 0.25) x = 0;
  else if (focalX >= 0.75) x = canvas.width - colW;
  else x = Math.round((canvas.width - colW) / 2);

  ctx.save();
  ctx.fillStyle = rgba(color, 0.18);
  ctx.fillRect(x, 0, colW, canvas.height);

  ctx.strokeStyle = rgba(color, 0.85);
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x + 0.5, 0);
  ctx.lineTo(x + 0.5, canvas.height);
  ctx.moveTo(x + colW - 0.5, 0);
  ctx.lineTo(x + colW - 0.5, canvas.height);
  ctx.stroke();
  ctx.restore();
}

function formRectAt(widthPx, layout, canvasWidth, scale) {
  const w = Math.min(canvasWidth, Math.round(widthPx * scale));
  let x;
  if (layout === "left") x = 0;
  else if (layout === "right") x = canvasWidth - w;
  else x = Math.round((canvasWidth - w) / 2);
  return { x, w };
}

function drawFormRect(ctx, canvas, settings, scale) {
  const rect = formRectAt(settings.formWidth, settings.layout, canvas.width, scale);
  ctx.save();
  ctx.fillStyle = COLORS.formFill;
  ctx.fillRect(rect.x, 0, rect.w, canvas.height);
  ctx.strokeStyle = COLORS.formMaxStroke;
  ctx.lineWidth = 2;
  ctx.strokeRect(rect.x + 1, 1, rect.w - 2, canvas.height - 2);
  ctx.restore();
}

function drawCropFrame(ctx, crop, scale) {
  if (!crop) return;
  const x = crop.x * scale;
  const y = crop.y * scale;
  const w = crop.w * scale;
  const h = crop.h * scale;

  ctx.save();
  ctx.fillStyle = COLORS.cropFill;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = COLORS.crop;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);

  ctx.fillStyle = COLORS.crop;
  const handles = handlePositions(x, y, w, h);
  for (const h0 of handles) {
    ctx.fillRect(h0.cx - HANDLE_SIZE / 2, h0.cy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
  }
  ctx.restore();
}

function handlePositions(x, y, w, h) {
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

export function hitTestCropHandle(crop, scale, px, py) {
  if (!crop) return null;
  const x = crop.x * scale;
  const y = crop.y * scale;
  const w = crop.w * scale;
  const h = crop.h * scale;
  const handles = handlePositions(x, y, w, h);
  for (const h0 of handles) {
    if (
      px >= h0.cx - HANDLE_SIZE &&
      px <= h0.cx + HANDLE_SIZE &&
      py >= h0.cy - HANDLE_SIZE &&
      py <= h0.cy + HANDLE_SIZE
    ) {
      return h0.name;
    }
  }
  if (px >= x && px <= x + w && py >= y && py <= y + h) return "move";
  return null;
}

function drawFocalMarker(ctx, focal, canvas) {
  if (!focal) return;
  const cx = focal.x * canvas.width;
  const cy = focal.y * canvas.height;

  ctx.save();
  ctx.strokeStyle = COLORS.focalStroke;
  ctx.lineWidth = 3;
  drawCross(ctx, cx, cy, 10);
  ctx.strokeStyle = COLORS.focal;
  ctx.lineWidth = 1.5;
  drawCross(ctx, cx, cy, 10);

  ctx.fillStyle = COLORS.focal;
  ctx.strokeStyle = COLORS.focalStroke;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawCross(ctx, cx, cy, size) {
  ctx.beginPath();
  ctx.moveTo(cx - size, cy);
  ctx.lineTo(cx + size, cy);
  ctx.moveTo(cx, cy - size);
  ctx.lineTo(cx, cy + size);
  ctx.stroke();
}
