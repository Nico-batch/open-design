import * as fabric from "fabric";

// Brand logo (faro/lighthouse, blanco sobre negro, 1024x1024). To replace, drop the new
// file at public/logo.jpg (or update this path) — no other changes needed.
export const LOGO_URL = "/logo.jpg";

const MAX_WIDTH_RATIO = 0.18;
const MAX_WIDTH_PX = 220;
const PADDING_RATIO = 0.04;
const MIN_PADDING_PX = 20;

let cachedImg: fabric.FabricImage | null = null;
let loading: Promise<fabric.FabricImage> | null = null;

function loadLogoImage(): Promise<fabric.FabricImage> {
  if (cachedImg) return Promise.resolve(cachedImg);
  if (loading) return loading;
  loading = fabric.FabricImage.fromURL(LOGO_URL, { crossOrigin: "anonymous" }).then((img) => {
    cachedImg = img;
    return img;
  });
  return loading;
}

export function isLogoObject(obj: fabric.FabricObject | undefined | null): boolean {
  return !!obj && (obj as any)._isLogo === true;
}

function positionLogo(obj: fabric.FabricObject, canvasWidth: number, canvasHeight: number) {
  const naturalWidth = (obj.width || 1) as number;
  const targetWidth = Math.min(canvasWidth * MAX_WIDTH_RATIO, MAX_WIDTH_PX);
  const scale = targetWidth / naturalWidth;
  const padding = Math.max(canvasWidth * PADDING_RATIO, MIN_PADDING_PX);

  obj.set({
    scaleX: scale,
    scaleY: scale,
    left: canvasWidth - padding - targetWidth,
    top: padding,
  });
  void canvasHeight; // reserved for future vertical constraints
}

/** (Re)adds the fixed, locked logo layer to `canvas`, positioned top-right. */
export async function applyLogoToCanvas(
  canvas: fabric.Canvas,
  canvasWidth: number,
  canvasHeight: number
): Promise<void> {
  const existing = canvas.getObjects().find(isLogoObject);
  if (existing) canvas.remove(existing);

  const source = await loadLogoImage();
  const logo = await source.clone();
  logo.set({
    selectable: false,
    evented: false,
    hasControls: false,
    hasBorders: false,
    lockMovementX: true,
    lockMovementY: true,
    hoverCursor: "default",
    excludeFromExport: false,
  });
  (logo as any)._isLogo = true;
  positionLogo(logo, canvasWidth, canvasHeight);

  canvas.add(logo);
  canvas.bringObjectToFront(logo);
  canvas.requestRenderAll();
}

/** Removes the logo layer (if present), runs `fn`, then restores it. Use around any
 *  serialization that must not persist the logo (saves, undo/redo history). */
export function withoutLogo<T>(canvas: fabric.Canvas, fn: () => T): T {
  const logo = canvas.getObjects().find(isLogoObject);
  if (logo) canvas.remove(logo);
  try {
    return fn();
  } finally {
    if (logo) {
      canvas.add(logo);
      canvas.bringObjectToFront(logo);
    }
  }
}
