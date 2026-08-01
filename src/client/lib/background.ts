import * as fabric from "fabric";
import { isLogoObject } from "./logo";

// Fabric only serializes the properties it knows about, so our own markers have to be
// registered explicitly. Without this they were silently dropped on save: after a reload
// the background could no longer be found, so "replace the background" added a *second*
// image on top of the old one (and the Cover/Contain buttons stopped working on restored
// designs).
fabric.FabricImage.customProperties = ["_isBgImage", "_bgFit"];

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
