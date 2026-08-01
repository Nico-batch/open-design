import * as fabric from "fabric";

/**
 * Breathing room, in design units, drawn around the page itself.
 *
 * The canvas element used to be exactly the size of the page, which meant anything
 * extending past it — above all the background image, which is scaled to *cover* the page
 * and is therefore always bigger than it — had its corner handles outside the element,
 * where they can't be drawn or grabbed. Resizing the background was effectively
 * impossible. The canvas is now larger than the page, and painting is clipped to the page
 * so the margin still reads as "outside", while Fabric draws the controls after clipping
 * and they stay visible and clickable in that margin.
 */
/*
 * 320 is a compromise. A photo scaled to *cover* a square page overflows by
 * (photoAspect - 1) / 2 of the page width — ~270px each side for a 3:2 photo on a 1080
 * page, ~420px for a 16:9 one. Covering the widest case would mean a canvas nearly three
 * times the page area, and every pixel of it is real memory (×4 bytes, ×devicePixelRatio²,
 * ×number of pages). 320 covers the common cases; for anything wider, the background's
 * scale slider in the right panel is the reliable way to resize it, and dragging still
 * works regardless.
 */
export const WORKSPACE_PADDING = 320;

export function workspaceSize(width: number, height: number) {
  return { width: width + WORKSPACE_PADDING * 2, height: height + WORKSPACE_PADDING * 2 };
}

/**
 * Confines painting to the page.
 *
 * **Must be re-applied after every `loadFromJSON`.** Fabric's loader ends with
 * `this.set(enlivenedMap)` where the map carries `clipPath` straight from the parsed JSON
 * — and ours is deliberately `excludeFromExport`, so it is never in that JSON and the
 * assignment silently sets it to `undefined`. The clip is then gone and the design paints
 * over the whole workspace, margin included, which reads as the page having vanished.
 * That's what undo did before this was factored out (loadFromJSON is how undo restores a
 * snapshot).
 */
export function applyWorkspaceClip(canvas: fabric.Canvas, width: number, height: number): void {
  // excludeFromExport keeps this out of the saved canvas_json — it's a property of the
  // viewport, not of the design.
  canvas.clipPath = new fabric.Rect({
    left: 0,
    top: 0,
    width,
    height,
    absolutePositioned: true,
    excludeFromExport: true,
  });
  canvas.requestRenderAll();
}

/**
 * Sizes `canvas` to the page plus the margin, shifts the origin so design coordinate
 * (0,0) is still the page's top-left corner, and clips painting to the page.
 */
export function applyWorkspaceGeometry(canvas: fabric.Canvas, width: number, height: number): void {
  const dpr = window.devicePixelRatio || 1;
  const total = workspaceSize(width, height);

  canvas.setDimensions({ width: total.width * dpr, height: total.height * dpr }, { cssOnly: false });
  canvas.setDimensions({ width: total.width, height: total.height }, { cssOnly: true });
  // Objects keep using page coordinates; the translation puts the page inside the margin.
  canvas.setViewportTransform([dpr, 0, 0, dpr, WORKSPACE_PADDING * dpr, WORKSPACE_PADDING * dpr]);

  applyWorkspaceClip(canvas, width, height);
}

/**
 * Crop rectangle handed to Fabric's export so the output is exactly the page, with the
 * margin (and anything hanging into it) left out. Units are canvas element pixels, which
 * is what `toCanvasElement` expects — hence the devicePixelRatio.
 */
export function pageExportCrop(width: number, height: number) {
  const dpr = window.devicePixelRatio || 1;
  return {
    left: WORKSPACE_PADDING * dpr,
    top: WORKSPACE_PADDING * dpr,
    width: width * dpr,
    height: height * dpr,
  };
}

/**
 * Scales `obj` about the page's centre, so resizing the background from the panel keeps
 * it centred instead of drifting towards its own top-left origin.
 */
export function scaleAboutPageCenter(
  obj: fabric.FabricObject,
  scale: number,
  pageWidth: number,
  pageHeight: number
): void {
  const cx = pageWidth / 2;
  const cy = pageHeight / 2;
  const prev = obj.scaleX || 1;
  const ratio = scale / prev;
  obj.set({
    scaleX: scale,
    scaleY: scale,
    left: cx - (cx - (obj.left || 0)) * ratio,
    top: cy - (cy - (obj.top || 0)) * ratio,
  });
  obj.setCoords();
}
