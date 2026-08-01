import * as fabric from "fabric";

/** Families shipped under `public/fonts/<Family>/<weight>.woff2` (see fonts.css). */
export const FONT_FAMILIES = [
  "Inter",
  "Playfair Display",
  "Montserrat",
  "Poppins",
  "Roboto",
  "Open Sans",
  "Lora",
  "Raleway",
  "Source Sans Pro",
  "Merriweather",
];

/**
 * Why any of this is needed.
 *
 * Canvas text does not pull in webfonts the way DOM text does: the browser only fetches an
 * `@font-face` file once something *in the document* needs it, and a `fillText()` on a
 * `<canvas>` doesn't count. So Fabric measures the text with whatever fallback font is
 * available, caches those character widths, and lays everything out from them — while the
 * font eventually arrives and is what actually gets painted. The result is exactly the set
 * of symptoms this editor had:
 *
 *   - the selection box and handles not matching the glyphs ("el recuadro se descuadra"),
 *   - words drawn on top of each other, because Textbox wrapped the lines using the
 *     wrong widths,
 *   - text that visibly reflows a moment after the page settles.
 *
 * Fabric's own documentation spells out the fix: once the font is really available, clear
 * its char-width cache and call `initDimensions()` to force a re-measure. That's what
 * `syncCanvasFonts` does.
 *
 * (Phase 1 replaced the template's `WebFont.load` — which had a ready callback — with
 * plain `@font-face` CSS and never added the re-measure step, which is where this
 * regression came from.)
 */
export async function ensureFontLoaded(family: string, weight: string | number = 400): Promise<void> {
  if (!document.fonts) return;
  try {
    // The size is irrelevant for loading; only family/weight select the face.
    await document.fonts.load(`${weight} 16px "${family}"`);
  } catch {
    // A font that fails to load must never break editing — the fallback still renders.
  }
}

type TextStyle = { fontFamily?: string; fontWeight?: string | number };

/** Every (family, weight) pair actually used on the canvas, per-character styles included. */
function collectUsedFaces(canvas: fabric.Canvas): Map<string, Set<string | number>> {
  const used = new Map<string, Set<string | number>>();
  const add = (family?: string, weight?: string | number) => {
    if (!family) return;
    if (!used.has(family)) used.set(family, new Set());
    used.get(family)!.add(weight ?? 400);
  };

  for (const obj of canvas.getObjects()) {
    if (!(obj instanceof fabric.FabricText)) continue;
    add(obj.fontFamily, obj.fontWeight);
    // Per-character overrides (the bold-on-selection feature writes these).
    const styles = (obj as unknown as { styles?: Record<string, Record<string, TextStyle>> }).styles;
    if (!styles) continue;
    for (const line of Object.values(styles)) {
      for (const style of Object.values(line ?? {})) {
        add(style?.fontFamily ?? obj.fontFamily, style?.fontWeight ?? obj.fontWeight);
      }
    }
  }
  return used;
}

/**
 * Loads every font the canvas actually uses, then re-measures its text so the layout and
 * the selection boxes match the glyphs that get painted. Safe to call repeatedly — once a
 * face is loaded the browser resolves it immediately.
 */
export async function syncCanvasFonts(canvas: fabric.Canvas): Promise<void> {
  const used = collectUsedFaces(canvas);
  if (used.size === 0) return;

  await Promise.all(
    [...used.entries()].flatMap(([family, weights]) =>
      [...weights].map((weight) => ensureFontLoaded(family, weight))
    )
  );

  // Measurements taken before the font arrived are cached and wrong — drop them.
  for (const family of used.keys()) fabric.cache.clearFontCache(family);

  let dirty = false;
  for (const obj of canvas.getObjects()) {
    if (!(obj instanceof fabric.FabricText)) continue;
    obj.initDimensions();
    obj.setCoords();
    obj.dirty = true;
    dirty = true;
  }
  if (dirty) canvas.requestRenderAll();
}
