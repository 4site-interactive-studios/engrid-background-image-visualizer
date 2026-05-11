# Background Image Helper

A single-page tool for prepping background images for [ENgrid](https://github.com/4site-interactive-studios/engrid) form layouts. Drop an image in, pick a preset for the campaign, and the app visualizes how the form will sit on top of it across viewports — then exports an optimized JPEG ready for upload.

## What it does

- Loads an image via **drop, click, or paste** (JPEG / PNG / WebP).
- Overlays a **safe zone** — the vertical column the form sits over — sized to a campaign preset or a custom width.
- Marks a **focal section indicator** (dashed circle) showing where the focal point lands inside the safe zone.
- Draws **warm zone bands** (five 30 px steps) on either side of the safe zone, previewing how the image holds up as the form's edge moves at different viewport widths.
- Auto-picks a high-contrast outline color for the safe zone, or lets you cycle through six fixed colors manually.
- Re-crops to the chosen focal point (Left/Center/Right × Top/Center/Bottom) with arrow-key nudging.
- Exports as JPEG with selectable max resolution and quality, encoded off the main thread in a Web Worker.
- Side-by-side **Compare** view of source vs. output.

## Presets

| Preset | Form position | Form width | Safe zone |
|---|---|---|---|
| NGS - Left | Left | 550 | 350 |
| NWF - Left | Left | 800 | 200 |
| Oceana - Left | Left | 680 | 350 |
| RAN - Left | Left | 680 | 300 |
| Shatterproof - Left | Left | 640 | 350 |
| WWF - Center | Center | 1200 | 1200 |
| Custom | any | any | any |

Custom mode unlocks the form-width and safe-zone inputs.

## Running locally

It's a static site. Any HTTP server works. The repo ships a `.claude/launch.json` configured for:

```
python3 -m http.server 8765
```

Then visit http://localhost:8765/.

Opening `index.html` directly via `file://` will fail — the app uses ES modules and a Web Worker, both of which require an `http(s)://` origin.

## Auto color

When the safe-zone color is set to **Auto**, the app re-picks the outline color whenever the image, crop, focal point, or safe-zone width changes:

1. Sample the area covered by the safe zone (only — no warm-margin padding).
2. Downscale to 8×8 and average the RGB.
3. Convert to HSL:
   - If the sample is near grayscale (`s < 0.15`), pick a vivid red at an opposite lightness.
   - Otherwise rotate the hue 180° (complementary), force saturation ≥ 0.75, and flip lightness.
4. If the picked color still isn't far enough from the sample (RGB distance < 150), push lightness to an extreme.
5. Debounced 150 ms so rapid changes coalesce.

To watch this in action: append `?debug=true` to the URL. Each recompute logs a line like:

```
[auto-color] safe zone color: #D47125 → overlay color: #124E7D
  { branch: "complementary", distanceFallback: false, avgHsl: {...}, pickedHsl: {...}, unchanged: false }
```

`unchanged: true` means the picker ran but produced the same color it already had.

## File layout

```
index.html              # entry — single page, no router
css/styles.css          # all styling
js/
  app.js                # UI wiring, state, settings persistence, auto-color
  imagework.js          # decode, crop math, source-image setup
  overlay.js            # canvas rendering — safe zone, warm bands, focal circle
  compress.js           # download trigger, filename suggestion
  encode-client.js      # main-thread side of JPEG encoding
  encode-worker.js      # Web Worker — actual JPEG encode
  storage.js            # localStorage persistence (settings + last image)
assets/                 # logo, favicons, overview video
.claude/launch.json     # dev-server config
```

Each module import in `app.js` carries a `?v=N` cache buster; bump the relevant one when changing a module so users don't get a stale copy. The `<script>` tag in `index.html` has its own version for `app.js`.

## Persistence

Settings (preset, form width, safe zone, focal point, color mode) and the last loaded image are stored in `localStorage`, so refreshing the page restores the session. Use **Clear image** to drop the cached image.

## Keyboard

- Click the preview to focus it, then **arrow keys** nudge the crop one preview-pixel at a time.
- Hold **Shift** to nudge by 10 pixels.
- **Paste** an image (or an `http(s)://` image URL) from anywhere on the page.

## Browser support

Requires a modern browser: ES modules, Web Workers, `createImageBitmap`, `OffscreenCanvas` (used in the encode worker), and Clipboard / DataTransfer APIs. Tested on current Chrome and Safari.
