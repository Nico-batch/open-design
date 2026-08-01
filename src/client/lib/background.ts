import * as fabric from "fabric";
import { isLogoObject } from "./logo";

// Fabric only serializes the properties it knows about, so our own markers have to be
// registered explicitly. Without this they were silently dropped on save: after a reload
// the background could no longer be found, so "replace the background" added a *second*
// image on top of the old one (and the Cover/Contain buttons stopped working on restored
// designs).
fabric.FabricImage.customProperties = ["_isBgImage", "_bgFit"];

/**
 * Largest bitmap we let reach the filter pipeline, per side.
 *
 * Fabric renders filters into a WebGL canvas of exactly `textureSize` px each way and
 * sets the viewport to the source's dimensions; the driver clamps that to the drawing
 * buffer, so **everything past 4096 px comes back fully transparent** — silently, with no
 * error. On a 5184×3456 camera photo (an ordinary size for what comes out of Twenty) that
 * wipes out the right 21% of the picture the moment blur or darkening is switched on.
 *
 * Derived from the config rather than hardcoded so the two can't drift apart. When the GPU
 * can't do 4096 at all, Fabric falls back to its Canvas2D backend, which has no such limit.
 */
const MAX_SOURCE_EDGE = fabric.config.textureSize;

/**
 * Fabric serializes an image by calling `getSrc()`, which inlines the whole bitmap as a
 * base64 data URL whenever the backing element is a canvas — and downscaling an oversized
 * source (below) makes it exactly that. Without this, saving a design would write several
 * megabytes of base64 into `canvas_json` instead of a one-line URL. `_srcUrl` is only set
 * on images whose element we replaced, so everything else keeps Fabric's own behaviour.
 */
const fabricGetSrc = fabric.FabricImage.prototype.getSrc;
fabric.FabricImage.prototype.getSrc = function (this: fabric.FabricImage, filtered?: boolean) {
  const url = (this as any)._srcUrl;
  return typeof url === "string" && url ? url : fabricGetSrc.call(this, filtered);
};

/**
 * Shrinks an image whose bitmap is too big for the filter pipeline, keeping its position
 * and its size *on the page* exactly as they were (the scale is converted, not reset).
 *
 * Costs nothing visually: the page is at most 1920 px and exports at 2×, so a 5000 px
 * source was already being downsampled at render time — it only ever bought memory use and
 * a slower blur. Returns whether it did anything.
 */
export function downscaleOversizedSource(img: fabric.FabricImage): boolean {
  // `_originalElement`, deliberately, and not `getElement()`: the latter returns the
  // *filtered* bitmap once effects are on, which on a reload is already the truncated one —
  // shrinking that would bake the missing strip in permanently instead of curing it.
  const el = (img as any)._originalElement as CanvasImageSource & {
    width: number;
    height: number;
    naturalWidth?: number;
  };
  if (!el) return false;
  const { width, height } = img.getOriginalSize();
  const longest = Math.max(width, height);
  if (!longest || longest <= MAX_SOURCE_EDGE) return false;

  // Read the URL while the element is still the original one — after setElement, getSrc
  // would have nothing but the canvas to go on.
  const srcUrl = img.getSrc();

  const ratio = MAX_SOURCE_EDGE / longest;
  const down = document.createElement("canvas");
  down.width = Math.max(1, Math.round(width * ratio));
  down.height = Math.max(1, Math.round(height * ratio));
  const ctx = down.getContext("2d");
  if (!ctx) return false;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(el, 0, 0, down.width, down.height);

  (img as any)._srcUrl = srcUrl;
  // Measured on the object's own width, not the bitmap's: a design restored from JSON comes
  // back with the *serialized* width (already ours, if it was saved after this shrink) but a
  // full-size element, and compensating for the element would then double-count and blow the
  // background up by the shrink ratio on every reload.
  const before = img.width || width;
  // setElement resets width/height to the new bitmap's and re-runs any filters on it.
  img.setElement(down);
  const after = img.width || down.width;
  // …which would shrink the object on the page, so give the scale back what the bitmap lost.
  const compensation = before / after;
  img.set({ scaleX: (img.scaleX ?? 1) * compensation, scaleY: (img.scaleY ?? 1) * compensation });
  img.setCoords();
  return true;
}

/**
 * Same, for a background restored by `loadFromJSON` — that rebuilds the image from its
 * saved `src`, i.e. at full resolution again, so undo/redo and reopening a design both
 * need this or the truncation comes back on the next filter change.
 */
export function normalizeBackgroundSource(canvas: fabric.Canvas): void {
  const bg = findBackgroundImage(canvas);
  if (bg) downscaleOversizedSource(bg);
}

export function isBackgroundImage(obj: fabric.FabricObject | undefined | null): boolean {
  return !!obj && (obj as any)._isBgImage === true;
}

/**
 * The background layer of `canvas`, if there is one.
 *
 * Falls back to the bottom-most image for designs saved *before* the marker was
 * serialized (see above) and tags it, so those keep working instead of accumulating
 * duplicate backgrounds. The logo is an image too, hence the explicit exclusion.
 */
export function findBackgroundImage(canvas: fabric.Canvas): fabric.FabricImage | undefined {
  const objects = canvas.getObjects();
  const tagged = objects.find(isBackgroundImage);
  if (tagged) return tagged as fabric.FabricImage;

  const legacy = objects.find((o) => o instanceof fabric.FabricImage && !isLogoObject(o));
  if (legacy) {
    (legacy as any)._isBgImage = true;
    return legacy as fabric.FabricImage;
  }
  return undefined;
}

/**
 * Makes the background draggable/resizable so the operator can reframe the source image
 * (it used to be fully locked, which meant a photo that didn't sit well could only be
 * fixed by swapping it in Twenty).
 *
 * Rotation stays locked on purpose: for framing a background it's almost always an
 * accident, and the Cover/Contain buttons are the escape hatch back to a clean fit.
 */
export function makeBackgroundInteractive(img: fabric.FabricImage): void {
  img.set({
    selectable: true,
    evented: true,
    hasControls: true,
    hasBorders: true,
    lockRotation: true,
  });
  // Per-instance (unlike mutating `controls`, which is shared between objects).
  img.setControlVisible("mtr", false);
}
