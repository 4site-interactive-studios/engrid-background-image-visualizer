let encodePromise = null;

function loadEncoder() {
  if (!encodePromise) {
    encodePromise = import("https://esm.sh/@jsquash/jpeg@1?bundle").then(
      (mod) => mod.encode
    );
  }
  return encodePromise;
}

export async function encodeJpeg(imageData, quality) {
  const encode = await loadEncoder();
  const buffer = await encode(imageData, { quality });
  return new Uint8Array(buffer);
}

export function triggerDownload(bytes, filename) {
  const blob = new Blob([bytes], { type: "image/jpeg" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function suggestFilename(originalName) {
  const dot = originalName.lastIndexOf(".");
  const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
  return `${stem}-bg.jpg`;
}
