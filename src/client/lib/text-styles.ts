import * as fabric from "fabric";

/**
 * Per-character text formatting: applying a style to just the selected word instead of the
 * whole text box.
 *
 * Fabric keeps two parallel stores for a text object: the object's own properties
 * (`obj.fill`, `obj.fontSize`, …) and a `styles[line][char]` map of overrides. At paint
 * time `getCompleteStyleDeclaration` merges the character override *over* the object
 * value, so a per-character entry always wins. This module owns the rules for deciding
 * which of the two a given write should land in.
 *
 * Three things about Fabric 6 that shape everything here (all read from its source, they
 * are not obvious from the docs):
 *
 *  1. Only the properties in Fabric's own `styleProperties` list can live per character
 *     (shapes/Text/constants.ts). Anything else handed to `setSelectionStyles` is stored
 *     and then silently ignored at render time — so the split has to be made from that
 *     list, not from what intuitively feels character-level. `paintFirst`,
 *     `strokeLineJoin` and `strokeUniform` are the ones that catch you out: they read as
 *     text properties but are object-only.
 *  2. A collapsed caret cannot carry a style. `setSelectionStyles` loops `start..end`, so
 *     a zero-width selection writes nothing, and Fabric has no notion of a pending style
 *     for the next character typed. Hence `textRange()` returns null for a caret and
 *     every caller falls back to editing the whole box — the same rule the bold button
 *     has always used.
 *  3. Writing `undefined` *deletes* an override rather than storing one: `_extendStyles`
 *     runs the merged declaration through `pickBy(v => v !== undefined)`, so the key is
 *     dropped and the character falls back to the object value. That is what "clear
 *     formatting" is built on.
 *
 * Indices are flat grapheme offsets across the whole text. Never touch
 * `obj.styles[line][char]` directly: `Textbox` remaps wrapped graphical lines onto logical
 * lines through its `_styleMap`, and only `get/setSelectionStyles` go through that
 * translation.
 */

/** A character range selected inside a text box being edited. */
export interface TextRange {
  start: number;
  end: number;
}

/** One of the properties Fabric can store on a single character. */
export type TextStyleProp = (typeof fabric.FabricText._styleProperties)[number];

/**
 * The properties Fabric stores per character.
 *
 * Taken from Fabric's own static rather than copied into a literal here, so the two can't
 * drift apart on an upgrade — the same reasoning as deriving the downscale cap from
 * `fabric.config.textureSize` in lib/background.ts. As of v6.9 it is: fontSize,
 * fontWeight, fontFamily, fontStyle, underline, overline, linethrough, stroke,
 * strokeWidth, fill, deltaY, textBackgroundColor, textDecorationThickness.
 */
export const STYLE_PROPERTIES: readonly TextStyleProp[] = fabric.FabricText._styleProperties;

const PER_CHAR: ReadonlySet<string> = new Set<string>(STYLE_PROPERTIES);

/** Whether Fabric can store this property on a single character. */
export function isPerCharProp(key: string): boolean {
  return PER_CHAR.has(key);
}

/**
 * Properties that change glyph metrics, so the box has to be re-measured after them —
 * and, for the font ones, re-measured *again* once the face has actually loaded
 * (see lib/fonts.ts).
 */
const METRIC_PROPS = new Set(["fontSize", "fontWeight", "fontFamily", "fontStyle"]);
export const changesMetrics = (keys: string[]) => keys.some((k) => METRIC_PROPS.has(k));
export const changesFontFace = (keys: string[]) =>
  keys.some((k) => k === "fontFamily" || k === "fontWeight" || k === "fontStyle");

/** Clears every per-character override when passed to `setSelectionStyles` (see note 3). */
export const BLANK_STYLE: Record<string, undefined> = Object.fromEntries(
  STYLE_PROPERTIES.map((p) => [p, undefined])
);

/** True for both `Textbox` and plain `IText` — `Textbox extends IText`. */
export function isTextObject(obj: fabric.FabricObject | null): obj is fabric.IText {
  return obj instanceof fabric.IText;
}

/**
 * The characters selected inside `obj` right now, or null when the target is the whole
 * box (not a text object, not being edited, or a collapsed caret — see note 2).
 *
 * Always read live at the moment of the write rather than cached: typing replaces the
 * selection *without* firing `text:selection:changed` (`updateFromTextArea` assigns the
 * indices directly), so a remembered range can silently point at the wrong characters.
 */
export function textRange(obj: fabric.FabricObject | null): TextRange | null {
  if (!isTextObject(obj) || !obj.isEditing) return null;
  const { selectionStart: start, selectionEnd: end } = obj;
  if (typeof start !== "number" || typeof end !== "number" || start === end) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

/** What a control should display: the effective value, and whether the range disagrees. */
export interface StyleReading {
  value: unknown;
  mixed: boolean;
}

/**
 * Reads the effective value of every per-character property in one pass — one pass because
 * `getSelectionStyles` allocates a full declaration per selected character, and calling it
 * once per control would redo that on every re-render.
 *
 * The `complete` flag makes Fabric merge the object's values underneath the overrides, so
 * the result is what the characters actually look like rather than `undefined` wherever
 * no override exists.
 */
export function summarizeTextStyle(
  obj: fabric.FabricObject | null,
  range: TextRange | null
): Record<string, StyleReading> {
  const wholeObject = () =>
    Object.fromEntries(
      STYLE_PROPERTIES.map((p) => [p, { value: (obj as any)?.[p], mixed: false }])
    );

  if (!isTextObject(obj) || !range) return wholeObject();

  const styles = obj.getSelectionStyles(range.start, range.end, true) as Record<string, unknown>[];
  if (styles.length === 0) return wholeObject();

  return Object.fromEntries(
    STYLE_PROPERTIES.map((p) => {
      const first = styles[0][p];
      return [p, { value: first, mixed: styles.some((s) => s[p] !== first) }];
    })
  );
}

/**
 * Splits a props object into what goes on the selected characters and what has to go on
 * the object regardless (see note 1). The outline controls rely on this: `stroke` and
 * `strokeWidth` are per-character, but the `paintFirst`/`strokeLineJoin`/`strokeUniform`
 * that make an outline read cleanly are not, and have to ride along on the object.
 */
export function splitTextStyleProps(
  props: Record<string, unknown>
): [perChar: Record<string, unknown>, onObject: Record<string, unknown>] {
  const perChar: Record<string, unknown> = {};
  const onObject: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (isPerCharProp(key)) perChar[key] = value;
    else onObject[key] = value;
  }
  return [perChar, onObject];
}
