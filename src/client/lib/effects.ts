import * as fabric from "fabric";
import { findBackgroundImage } from "./background";

// Same reason as the background marker (see background.ts): Fabric drops properties it
// doesn't know about when serializing, so the scrim has to declare its own or it would
// come back from a save as an anonymous black rectangle nobody can identify or remove.
fabric.Rect.customProperties = ["_isScrim", "_scrimKind"];

/**
 * How the darkening layer ("scrim") is shaped. Putting text straight onto a photo is the
 * classic legibility problem; the three standard answers in editorial design are:
 *
 *  - `solid`  — an even veil over the whole image. Most reliable, flattest looking.
 *  - `bottom` — a gradient fading from transparent at the top to dark at the bottom, for
 *               text sitting low. Keeps most of the photo visible, which is why it's what
 *               news and social layouts usually reach for.
 *  - `top`    — the same, mirrored, for text at the top.
 */
export type ScrimKind = "none" | "solid" | "bottom" | "top";

export interface BackgroundEffects {
  /** Fabric's Blur filter, 0–1 (a fraction of the image size, not pixels). */
  blur: number;
  /** Fabric's Brightness filter, -1–0 here: we only ever darken, to help contrast. */
  brightness: number;
  /** Fabric's Contrast filter, -1–1. Positive is the useful direction for a photo. */
  contrast: number;
  /** Unsharp amount, 0–1, applied through a convolution kernel — see sharpenMatrix. */
  sharpen: number;
}

export const NO_EFFECTS: BackgroundEffects = { blur: 0, brightness: 0, contrast: 0, sharpen: 0 };

/**
 * A sharpening kernel scaled by `amount`, so the slider goes from "untouched" to "clearly
 * crisper" instead of being a switch.
 *
 * It is the textbook 5-point Laplacian sharpen interpolated with the identity: at 0 the
 * centre is 1 and the neighbours are 0, which leaves every pixel exactly as it was; as the
 * amount rises the neighbours subtract more and the centre compensates. The weights always
 * sum to 1, which is what keeps overall brightness unchanged — a kernel that doesn't sum to
 * 1 silently lightens or darkens the whole photo, and that is the usual way this goes wrong.
 */
export function sharpenMatrix(amount: number): number[] {
  const a = amount;
  return [
    0, -a, 0,
    -a, 1 + 4 * a, -a,
    0, -a, 0,
  ];
}

/** Recovers the amount from a kernel produced by sharpenMatrix. */
function sharpenAmount(matrix: number[] | undefined): number {
  const neighbour = matrix?.[1];
  return typeof neighbour === "number" ? Math.max(0, -neighbour) : 0;
}

export function isScrim(obj: fabric.FabricObject | undefined | null): boolean {
  return !!obj && (obj as any)._isScrim === true;
}

export function findScrim(canvas: fabric.Canvas): fabric.Rect | undefined {
  return canvas.getObjects().find(isScrim) as fabric.Rect | undefined;
}

/** Current effect values, read back off the background's filters (Fabric persists those). */
export function readBackgroundEffects(canvas: fabric.Canvas): BackgroundEffects {
  const bg = findBackgroundImage(canvas);
  if (!bg?.filters) return { ...NO_EFFECTS };
  const blurFilter = bg.filters.find((f) => f instanceof fabric.filters.Blur) as
    | fabric.filters.Blur
    | undefined;
  const brightnessFilter = bg.filters.find((f) => f instanceof fabric.filters.Brightness) as
    | fabric.filters.Brightness
    | undefined;
  const contrastFilter = bg.filters.find((f) => f instanceof fabric.filters.Contrast) as
    | fabric.filters.Contrast
    | undefined;
  const sharpenFilter = bg.filters.find((f) => f instanceof fabric.filters.Convolute) as
    | fabric.filters.Convolute
    | undefined;
  return {
    blur: blurFilter?.blur ?? 0,
    brightness: brightnessFilter?.brightness ?? 0,
    contrast: contrastFilter?.contrast ?? 0,
    sharpen: sharpenAmount(sharpenFilter?.matrix as number[] | undefined),
  };
}

/**
 * Replaces the background's filter stack. Rebuilt from scratch each time (rather than
 * mutating in place) so the order stays deterministic and turning an effect back to zero
 * actually removes it instead of leaving an identity filter behind.
 *
 * `applyFilters()` re-renders the image into an offscreen canvas and reads it back, so it
 * only works on an untainted source — ours are all same-origin (`/api/news/:id/image`
 * proxies Twenty precisely so this holds, and uploads are served from our own origin).
 */
export function applyBackgroundEffects(canvas: fabric.Canvas, effects: BackgroundEffects): boolean {
  const bg = findBackgroundImage(canvas);
  if (!bg) return false;

  const filters: NonNullable<fabric.FabricImage["filters"]> = [];
  // Order matters and is not arbitrary: sharpening amplifies whatever detail is there, so
  // it goes first, while the photo is still untouched. Blur after it would undo it, and
  // sharpening after a contrast boost would exaggerate the halos contrast already creates.
  if (effects.sharpen > 0) {
    filters.push(new fabric.filters.Convolute({ matrix: sharpenMatrix(effects.sharpen) }));
  }
  if (effects.blur > 0) filters.push(new fabric.filters.Blur({ blur: effects.blur }));
  if (effects.contrast !== 0) {
    filters.push(new fabric.filters.Contrast({ contrast: effects.contrast }));
  }
  if (effects.brightness < 0) {
    filters.push(new fabric.filters.Brightness({ brightness: effects.brightness }));
  }

  bg.filters = filters;
  bg.applyFilters();
  canvas.requestRenderAll();
  return true;
}

function scrimFill(kind: ScrimKind, opacity: number, width: number, height: number): string | fabric.Gradient<"linear"> {
  const dark = (a: number) => `rgba(0,0,0,${a})`;
  if (kind === "solid") return dark(opacity);

  // Gradient stops carry the alpha themselves, so the object's own opacity stays at 1 and
  // there's only one place controlling strength.
  const stops =
    kind === "bottom"
      ? [
          { offset: 0, color: dark(0) },
          { offset: 0.45, color: dark(opacity * 0.35) },
          { offset: 1, color: dark(opacity) },
        ]
      : [
          { offset: 0, color: dark(opacity) },
          { offset: 0.55, color: dark(opacity * 0.35) },
          { offset: 1, color: dark(0) },
        ];

  return new fabric.Gradient({
    type: "linear",
    gradientUnits: "pixels",
    coords: { x1: 0, y1: 0, x2: 0, y2: height },
    colorStops: stops,
  });
}

/**
 * Adds, updates or removes the scrim layer. It always sits directly on top of the
 * background image and below everything else, so it darkens the photo without touching
 * the text or shapes drawn over it. Not selectable — it's a backdrop, and having it
 * swallow clicks meant for the text would be maddening.
 */
export function applyScrim(
  canvas: fabric.Canvas,
  pageWidth: number,
  pageHeight: number,
  kind: ScrimKind,
  opacity: number
): void {
  const existing = findScrim(canvas);

  if (kind === "none") {
    if (existing) {
      canvas.remove(existing);
      canvas.requestRenderAll();
    }
    return;
  }

  const fill = scrimFill(kind, opacity, pageWidth, pageHeight);
  const rect =
    existing ??
    new fabric.Rect({
      selectable: false,
      evented: false,
      hoverCursor: "default",
    });

  rect.set({ left: 0, top: 0, width: pageWidth, height: pageHeight, scaleX: 1, scaleY: 1, fill });
  (rect as any)._isScrim = true;
  (rect as any)._scrimKind = kind;
  rect.setCoords();

  if (!existing) canvas.add(rect);

  // Keep it immediately above the background, whatever else has been added since.
  const bg = findBackgroundImage(canvas);
  const objects = canvas.getObjects();
  const bgIndex = bg ? objects.indexOf(bg) : -1;
  canvas.moveObjectTo(rect, bgIndex >= 0 ? bgIndex + 1 : 0);

  canvas.requestRenderAll();
}

/** Current scrim settings, for restoring the panel's state from a loaded design. */
export function readScrim(canvas: fabric.Canvas): { kind: ScrimKind; opacity: number } {
  const scrim = findScrim(canvas);
  if (!scrim) return { kind: "none", opacity: 0.4 };
  const kind = ((scrim as any)._scrimKind as ScrimKind) ?? "solid";
  const fill = scrim.fill;
  let opacity = 0.4;
  if (typeof fill === "string") {
    const m = fill.match(/rgba?\([^)]*,\s*([\d.]+)\s*\)/);
    if (m) opacity = parseFloat(m[1]);
  } else if (fill instanceof fabric.Gradient) {
    const strongest = fill.colorStops
      .map((s) => {
        const m = String(s.color).match(/rgba?\([^)]*,\s*([\d.]+)\s*\)/);
        return m ? parseFloat(m[1]) : 0;
      })
      .reduce((a, b) => Math.max(a, b), 0);
    if (strongest > 0) opacity = strongest;
  }
  return { kind, opacity };
}

/** Keeps the scrim covering the page after a canvas resize. */
export function resizeScrim(canvas: fabric.Canvas, pageWidth: number, pageHeight: number): void {
  const scrim = findScrim(canvas);
  if (!scrim) return;
  const kind = ((scrim as any)._scrimKind as ScrimKind) ?? "solid";
  const { opacity } = readScrim(canvas);
  applyScrim(canvas, pageWidth, pageHeight, kind, opacity);
}
