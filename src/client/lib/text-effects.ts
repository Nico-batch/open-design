import * as fabric from "fabric";

/**
 * Effects that make a headline survive being dropped on a photograph.
 *
 * This is the letter-side counterpart of lib/effects.ts, which works on the picture (blur,
 * darken, scrim). Between them they cover the two ways out of the classic problem: calm the
 * photo down, or make the type strong enough not to care.
 *
 * Three facts about Fabric decide the shape of everything here, all read from its source
 * rather than assumed:
 *
 *  1. **An object has exactly one `shadow` slot.** So a drop shadow and a glow cannot both
 *     be on — a glow *is* a shadow with no offset and a wide blur. They are modelled as one
 *     mutually exclusive choice instead of two switches that would silently overwrite each
 *     other.
 *  2. **`shadow` is object-level, not per character.** It is absent from Fabric's
 *     `styleProperties` (see lib/text-styles.ts), so unlike colour or size it always applies
 *     to the whole text box. Routing it through `applyTextStyle` is still correct — the
 *     splitter sends anything non-per-character to the object — but a range selection
 *     cannot narrow it.
 *  3. **The shadow skips the outline unless asked.** `_renderTextStroke` calls
 *     `_removeShadow` when `shadow.affectStroke` is false, which is the default. Left alone,
 *     an outlined letter casts a shadow from its fill only and the outline looks pasted on;
 *     `affectStroke: true` makes the silhouette cast it as one shape.
 *
 * `textBackgroundColor` and `fill`/`stroke` (the hollow effect) *are* per-character, so
 * those two follow the selection for free once they go through `applyTextStyle`.
 */

/** Which of the two shadow-based effects is active. They share one slot — see note 1. */
export type TextGlowKind = "none" | "shadow" | "glow";

export interface TextShadow {
  kind: TextGlowKind;
  /** Opaque hex; the strength is carried separately so the colour picker stays usable. */
  color: string;
  /** 0–1. Folded into the rgba() actually handed to Fabric. */
  strength: number;
  blur: number;
  /** Offset along the down-right diagonal. Ignored by a glow, which must stay centred. */
  distance: number;
}

export const NO_TEXT_SHADOW: TextShadow = {
  kind: "none",
  color: "#000000",
  strength: 0.55,
  blur: 10,
  distance: 8,
};

const GLOW_DEFAULTS = { color: "#ffffff", strength: 0.9, blur: 18, distance: 0 };

/** Sensible starting point when an effect is switched on from nothing. */
export function defaultsFor(kind: TextGlowKind): TextShadow {
  if (kind === "glow") return { ...NO_TEXT_SHADOW, ...GLOW_DEFAULTS, kind };
  return { ...NO_TEXT_SHADOW, kind };
}

/** The `shadow` value to assign, or null to clear it. */
export function buildTextShadow(s: TextShadow): fabric.Shadow | null {
  if (s.kind === "none") return null;
  const offset = s.kind === "glow" ? 0 : s.distance;
  const color = new fabric.Color(s.color).setAlpha(s.strength).toRgba();
  return new fabric.Shadow({
    color,
    blur: s.blur,
    offsetX: offset,
    offsetY: offset,
    // Note 3: without this the outline is left out of the silhouette that casts the shadow.
    affectStroke: true,
  });
}

/**
 * Reads the effect back off an object, so the panel shows what the design actually has
 * after a reload or an undo rather than its own last known state.
 *
 * The kind is derived from the offset instead of being stored separately: no offset means a
 * glow. That keeps everything inside Fabric's own serialised `shadow` and leaves nothing
 * extra to register in `customProperties` or to lose on the way through `canvas_json`.
 */
export function readTextShadow(obj: fabric.FabricObject | null): TextShadow {
  const shadow = obj?.shadow as fabric.Shadow | null | undefined;
  if (!shadow) return NO_TEXT_SHADOW;

  const parsed = new fabric.Color(shadow.color);
  const distance = Math.round(Math.max(Math.abs(shadow.offsetX ?? 0), Math.abs(shadow.offsetY ?? 0)));
  return {
    kind: distance === 0 ? "glow" : "shadow",
    color: `#${parsed.toHex().toLowerCase()}`,
    strength: Math.round(parsed.getAlpha() * 100) / 100,
    blur: Math.round(shadow.blur ?? 0),
    distance,
  };
}

const TRANSPARENT = "transparent";
const FALLBACK_INK = "#ffffff";

/** Hollow letters: the fill removed so only the outline draws. */
export function isHollowFill(fill: unknown): boolean {
  return fill === TRANSPARENT || fill === "" || fill === null || fill === undefined;
}

/**
 * The fill and outline the hollow toggle should work from.
 *
 * Deliberately values rather than the object: `fill`, `stroke` and `strokeWidth` are all
 * per-character (lib/text-styles.ts), so with a word selected the toggle writes to that
 * word. Reading the object's own fill there would make a red word go hollow in the box's
 * colour instead of its own. The caller passes what the panel is already showing, which is
 * the range's values when there is a range and the box's otherwise.
 */
export interface HollowSource {
  fill: unknown;
  stroke: unknown;
  strokeWidth: number;
  fontSize: number;
}

/**
 * Turning hollow on and off, as a straight swap between fill and outline.
 *
 * The letter's colour becomes its outline, and back again — a solid red word turns into a
 * red-outlined one and returns to solid red. Being an exact involution is what makes the
 * button safe to press twice, and it needs no hidden "previous colour" to persist and go
 * stale on reload.
 *
 * It deliberately *overrides* an outline that was already there rather than keeping it. The
 * alternative loses more: a red word with a black outline would go hollow showing only
 * black, so the colour the eye actually tracks would vanish with no way back. Swapping keeps
 * the letter's own colour and costs an outline that can be re-added in two clicks — and undo
 * restores it anyway.
 *
 * Creating the outline on the way in is not optional: a transparent fill with no stroke is
 * an invisible word, which reads as the button having deleted the text.
 */
export function hollowProps(src: HollowSource, hollow: boolean): Record<string, unknown> {
  const fill = typeof src.fill === "string" && !isHollowFill(src.fill) ? src.fill : FALLBACK_INK;
  const stroke = typeof src.stroke === "string" && src.stroke ? src.stroke : "";

  if (hollow) {
    return {
      fill: TRANSPARENT,
      stroke: fill,
      strokeWidth: src.strokeWidth > 0 ? src.strokeWidth : Math.max(2, Math.round(src.fontSize * 0.05)),
      // Object-level, like in applyOutline — applyTextStyle routes them past the range.
      paintFirst: "stroke",
      strokeLineJoin: "round",
      strokeUniform: true,
    };
  }
  // Clearing the stroke as well is what keeps this an involution: leaving it behind would
  // give back a solid letter wearing an outline of its own colour, quietly a bit bolder
  // than the one that went in.
  return { fill: stroke || FALLBACK_INK, stroke: null, strokeWidth: 0 };
}
