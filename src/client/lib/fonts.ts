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
export async function ensureFontLoaded(
  family: string,
  weight: string | number = 400,
  text?: string
): Promise<void> {
  if (!document.fonts) return;
  try {
    // The size is irrelevant for loading; only family/weight select the face. The second
    // argument matters for families split by `unicode-range` (the emoji font): it tells
    // the browser which subsets are actually needed, so only those get fetched.
    await document.fonts.load(`${weight} 16px "${family}"`, text);
  } catch {
    // A font that fails to load must never break editing — the fallback still renders.
  }
}

// ── Emojis ──────────────────────────────────────────────────────────
//
// The font is self-hosted (see fonts.css) so a design looks the same on any machine
// instead of picking up whatever emoji set the operator's OS ships — Windows, for one,
// has no country flags at all, so 🇪🇸 comes out as the bare letters "ES".
//
// Making canvas text use it needs one hook, not a change to every text object: Fabric
// builds the `ctx.font` string in `_getFontDeclaration`, and uses that same string both
// to MEASURE and to PAINT. Appending the emoji family there keeps those two in step and
// leaves `fontFamily` on the object untouched — which matters, because that value feeds
// the font dropdown and gets serialized into `canvas_json`.

export const EMOJI_FONT_FAMILY = "Noto Color Emoji";

/** Anything the emoji font should handle: pictographs, the variation selector that turns
 *  a symbol into an emoji, ZWJ (family/couple sequences) and regional indicators (flags). */
const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/u;

export function containsEmoji(text: string): boolean {
  return EMOJI_RE.test(text);
}

let fontDeclarationPatched = false;

/** Adds the emoji family as a fallback to every canvas font declaration Fabric builds. */
export function installEmojiFontFallback(): void {
  if (fontDeclarationPatched) return;
  fontDeclarationPatched = true;
  const proto = fabric.FabricText.prototype as unknown as {
    _getFontDeclaration: (...args: unknown[]) => string;
  };
  const original = proto._getFontDeclaration;
  proto._getFontDeclaration = function (...args: unknown[]) {
    return `${original.apply(this, args)}, "${EMOJI_FONT_FAMILY}"`;
  };
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

  // Emoji get measured with the same fallback trap as any other webfont (see above): if
  // the font isn't there yet, Fabric measures a placeholder glyph, caches that width and
  // wraps the line with it. Only fetched when there are emoji on the canvas — the family
  // is ~2 MB across all its subsets, and the text passed here narrows it to the ones
  // actually needed.
  const emojiText = canvas
    .getObjects()
    .filter((obj): obj is fabric.FabricText => obj instanceof fabric.FabricText)
    .map((obj) => obj.text ?? "")
    .join("");

  await Promise.all([
    ...[...used.entries()].flatMap(([family, weights]) =>
      [...weights].map((weight) => ensureFontLoaded(family, weight))
    ),
    containsEmoji(emojiText) ? ensureFontLoaded(EMOJI_FONT_FAMILY, 400, emojiText) : Promise.resolve(),
  ]);

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
