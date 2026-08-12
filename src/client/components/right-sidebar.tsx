import { useState, useEffect, useMemo } from "preact/hooks";
import {
  Bold,
  Italic,
  Underline,
  AlignLeft,
  AlignCenter,
  AlignRight,
  FlipHorizontal,
  FlipVertical,
  Trash2,
  Copy,
  Eraser,
  WandSparkles,
} from "lucide-preact";
import * as fabric from "fabric";
import { useEditor } from "../context";
import { FONT_FAMILIES } from "../lib/fonts";
import { isBackgroundImage } from "../lib/background";
import { textRange, summarizeTextStyle } from "../lib/text-styles";
import {
  readTextShadow,
  buildTextShadow,
  defaultsFor,
  isHollowFill,
  hollowProps,
  type TextGlowKind,
} from "../lib/text-effects";
import { EmojiPicker } from "./emoji-picker";

/**
 * Keeps a control from stealing focus out of the text box being edited. Losing focus
 * doesn't end Fabric's editing session, but it does stop the caret and wipe the selection
 * highlight, so buttons that don't need typing keep the focus where it is.
 */
const keepFocus = (e: Event) => e.preventDefault();

/**
 * Hands the keyboard back to the text box when a field that had to take focus is finished
 * with. Bound to Enter rather than `change`, because `change` also fires on blur — that is,
 * exactly when the operator has just clicked another control — and stealing focus back then
 * would fight them.
 */
const onEnter = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key !== "Enter") return;
  // preventDefault first, and it is not cosmetic: moving focus to the text box mid-keydown
  // hands the keystroke's default action to the box, and Enter there *replaces the selected
  // characters with a newline* — pressing Enter to confirm a colour deleted the very word
  // being formatted. Cancelling the keystroke lets the focus move without it landing
  // anywhere.
  e.preventDefault();
  fn();
};

export function RightSidebar() {
  const {
    selectedObject,
    selectionVersion,
    updateSelectedObject,
    applyTextStyle,
    clearTextStyle,
    restoreTextFocus,
    enhanceHeadline,
    toggleBold,
    insertEmoji,
    deleteSelected,
    canvas,
    setBackground,
    setBackgroundImageFit,
    setBackgroundScale,
    canvasWidth,
    canvasHeight,
  } = useEditor();

  const isText = selectedObject instanceof fabric.Textbox || selectedObject instanceof fabric.IText;
  const isImage = selectedObject instanceof fabric.FabricImage;
  const isBackground = isBackgroundImage(selectedObject);
  const isShape = selectedObject && !isText && !isImage;

  // What the text controls should be showing: the style of the selected characters when
  // there are any, of the whole box otherwise. Read in one pass and memoised because
  // getSelectionStyles builds a full style declaration per selected character, and doing
  // that once per control would repeat the work on every re-render.
  //
  // selectionVersion is the dependency that matters: the fabric object is mutated in
  // place, so its identity never changes and only that counter marks it as stale. It
  // also covers caret movement, which bumps it through the text:selection:changed
  // listener in use-canvas.ts.
  const range = isText ? textRange(selectedObject) : null;
  const textStyle = useMemo(
    () => summarizeTextStyle(selectedObject, range),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedObject, selectionVersion, range?.start, range?.end]
  );
  const styleOf = (prop: string) => textStyle[prop] ?? { value: undefined, mixed: false };
  /** The effective value, or `fallback` when the selection spans more than one value. */
  const styleValue = <T,>(prop: string, fallback: T): T => {
    const s = styleOf(prop);
    return s.mixed || s.value === undefined || s.value === null ? fallback : (s.value as T);
  };
  /** A toggle only reads as "on" when every selected character has it on. */
  const styleIsOn = (prop: string, on: (v: unknown) => boolean) => {
    const s = styleOf(prop);
    return !s.mixed && on(s.value);
  };

  // Fabric defaults strokeWidth to 1 with stroke:null, so width alone doesn't tell you
  // whether there's an outline — without checking the colour too, the panel would claim
  // "1px" on text that has none. Read through styleOf so the outline of a single
  // highlighted word reports itself rather than the box's.
  const strokePaint = isText ? styleOf("stroke") : { value: selectedObject?.stroke, mixed: false };
  const strokeSize = isText
    ? styleValue<number>("strokeWidth", 0)
    : ((selectedObject?.strokeWidth as number) ?? 0);
  const hasOutline = !!strokePaint.value && strokeSize > 0;
  const outlineWidth = hasOutline ? strokeSize : 0;
  const outlineColor = ((strokePaint.value as string) || "#000000").toString();

  /**
   * Applies a text outline the way it actually needs to be done, rather than just setting
   * `stroke`:
   *
   *  - `paintFirst: "stroke"` — by default Fabric paints the fill and *then* the stroke on
   *    top, so half the outline's width eats into the glyph and the letters come out
   *    thinner and muddier the heavier the outline. Painting the stroke first leaves the
   *    fill covering its inner half, which is what makes an outline read cleanly.
   *  - `strokeLineJoin: "round"` — a miter join throws long spikes off the sharp corners of
   *    letters like A, V or W once the outline gets thick.
   *  - `strokeUniform: true` — keeps the outline an even thickness if the text box is
   *    scaled, instead of stretching with it.
   *
   * Picking a colour while the outline is off turns it on at a width proportional to the
   * font size, so the colour swatch does something visible instead of nothing.
   */
  const applyOutline = ({ color, width }: { color?: string; width?: number }) => {
    if (!selectedObject) return;
    const fontSize = styleValue<number>("fontSize", 48) || 48;
    const nextWidth =
      width ?? (outlineWidth > 0 ? outlineWidth : Math.max(2, Math.round(fontSize * 0.06)));

    // Dragging the width to 0 clears the colour too, so "off" is genuinely off rather
    // than a zero-width stroke lingering on the object.
    if (nextWidth === 0) {
      applyTextStyle({ stroke: null, strokeWidth: 0 });
      return;
    }

    applyTextStyle({
      stroke: color ?? outlineColor,
      strokeWidth: nextWidth,
      // Only stroke/strokeWidth can be held per character; these three are object-level in
      // Fabric, and applyTextStyle routes them there. Harmless on the characters that have
      // no outline, since the stroke pass skips anything without one.
      paintFirst: "stroke",
      strokeLineJoin: "round",
      strokeUniform: true,
    });
  };

  // ── Text effects (lib/text-effects.ts) ───────────────────────────────────────────
  // Read off the object on every render, so the panel reflects a design that was just
  // reloaded or undone rather than its own memory of the last thing clicked.
  const shadow = readTextShadow(selectedObject);
  // Read through styleOf, not off the object: fill and stroke are per-character, so with a
  // word selected these controls are about that word.
  const hollow = isHollowFill(styleOf("fill").value);
  const textBg = styleValue<string>("textBackgroundColor", "");

  /** Changes one setting of the shadow/glow, keeping the rest. */
  const applyShadow = (patch: Partial<typeof shadow>) => {
    // Switching the effect on from nothing starts from values that actually read, instead
    // of a zero-blur zero-offset shadow that looks like the button did nothing.
    const base =
      shadow.kind === "none" && patch.kind && patch.kind !== "none"
        ? { ...defaultsFor(patch.kind), ...patch }
        : { ...shadow, ...patch };
    applyTextStyle({ shadow: buildTextShadow(base) });
  };

  const toggleHollow = () => {
    if (!selectedObject) return;
    applyTextStyle(
      hollowProps(
        {
          fill: styleOf("fill").value,
          stroke: strokePaint.value,
          // outlineWidth, not strokeSize: Fabric leaves strokeWidth at 1 even with no
          // stroke colour, and taking that at face value gave hollow letters a hairline
          // edge instead of one derived from the font size.
          strokeWidth: outlineWidth,
          fontSize: styleValue<number>("fontSize", 48) || 48,
        },
        !hollow
      )
    );
  };

  if (!selectedObject) {
    return (
      <aside class="w-[280px] bg-zinc-900 border-l border-zinc-800 flex flex-col shrink-0">
        <div class="p-4 border-b border-zinc-800">
          <h2 class="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Canvas</h2>
        </div>
        <div class="p-4 flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <span class="text-[11px] text-zinc-400">Dimensions</span>
            <span class="text-[11px] text-zinc-300 font-mono">{canvasWidth} x {canvasHeight}</span>
          </div>
          <label class="text-[11px] text-zinc-400">Background color</label>
          <input
            type="color"
            class="w-full h-8 rounded-md border border-zinc-700 cursor-pointer bg-transparent"
            onChange={(e) => setBackground("color", (e.target as HTMLInputElement).value)}
          />
        </div>
      </aside>
    );
  }

  return (
    <aside class="w-[280px] bg-zinc-900 border-l border-zinc-800 flex flex-col shrink-0 overflow-y-auto">
      {/* Header */}
      <div class="p-4 border-b border-zinc-800 flex items-center justify-between">
        <h2 class="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          {isText ? "Text" : isBackground ? "Background" : isImage ? "Image" : "Shape"}
        </h2>
        <div class="flex gap-1">
          <button
            class="p-1 rounded text-zinc-400 bg-transparent border-none cursor-pointer hover:text-zinc-100 hover:bg-zinc-800 transition-all"
            onClick={async () => {
              if (!canvas || !selectedObject) return;
              const clone = await selectedObject.clone();
              clone.set({ left: (selectedObject.left || 0) + 20, top: (selectedObject.top || 0) + 20 });
              canvas.add(clone);
              canvas.setActiveObject(clone);
            }}
            title="Duplicate"
          >
            <Copy size={14} />
          </button>
          <button
            class="p-1 rounded text-zinc-400 bg-transparent border-none cursor-pointer hover:text-red-400 hover:bg-red-500/10 transition-all"
            onClick={deleteSelected}
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div class="p-4 flex flex-col gap-4">
        {/* ── Text properties ───────────────────────────────────────── */}
        {isText && (
          <>
            {/* The typographic half of the "local news post" recipe (lib/enhance.ts): heavy
                white Montserrat, uppercase, tightened, shadowed and centred on the page.
                Always the whole box — it is a layout preset, so applying it to a selected
                word would leave the rest of the headline behind. */}
            <button
              class="w-full flex items-center justify-center gap-1.5 py-2 rounded-md border border-accent/60 bg-accent/10 text-[11px] font-semibold text-accent cursor-pointer transition-all hover:bg-accent/20"
              title="Convierte este texto en titular de noticia: MAYÚSCULAS, Montserrat ExtraBold blanco, centrado en la página y con sombra suave"
              onMouseDown={keepFocus}
              onClick={() => enhanceHeadline()}
            >
              <WandSparkles size={13} />
              Mejorar titular
            </button>

            {/* Font family */}
            <div>
              <label class="text-[11px] text-zinc-400 mb-1 block">Font family</label>
              <select
                class="w-full bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-200 px-2 py-1.5 outline-none cursor-pointer focus:border-accent"
                value={styleOf("fontFamily").mixed ? "" : styleValue("fontFamily", "Inter")}
                onChange={(e) => {
                  applyTextStyle({ fontFamily: (e.target as HTMLSelectElement).value });
                  restoreTextFocus();
                }}
              >
                {/* Only reachable when the selection spans more than one family: showing
                    one of them would claim the whole selection uses it. */}
                {styleOf("fontFamily").mixed && (
                  <option value="" disabled>
                    varios
                  </option>
                )}
                {FONT_FAMILIES.map((f) => (
                  <option key={f} value={f} style={{ fontFamily: f }}>
                    {f}
                  </option>
                ))}
              </select>
            </div>

            {/* Font size */}
            <div>
              <label class="text-[11px] text-zinc-400 mb-1 block">Font size</label>
              <input
                type="number"
                class="w-full bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-200 px-2 py-1.5 outline-none focus:border-accent"
                value={styleOf("fontSize").mixed ? "" : styleValue("fontSize", 18)}
                placeholder={styleOf("fontSize").mixed ? "varios" : undefined}
                onKeyDown={onEnter(restoreTextFocus)}
                onInput={(e) => {
                  const next = parseInt((e.target as HTMLInputElement).value);
                  if (!Number.isNaN(next)) applyTextStyle({ fontSize: next });
                }}
              />
            </div>

            {/* Bold / Italic / Underline */}
            <div>
              <label class="text-[11px] text-zinc-400 mb-1 block">Style</label>
              <div class="flex gap-1">
                <button
                  class={`p-1.5 rounded-md border cursor-pointer transition-all ${
                    styleIsOn("fontWeight", (v) => v === "700" || v === 700 || v === "bold")
                      ? "bg-accent/20 border-accent text-accent"
                      : "bg-transparent border-zinc-700 text-zinc-400 hover:text-zinc-50"
                  }`}
                  title="Bold — applies to the selected characters while editing text, or the whole box otherwise"
                  onMouseDown={keepFocus}
                  onClick={toggleBold}
                >
                  <Bold size={14} />
                </button>
                <button
                  class={`p-1.5 rounded-md border cursor-pointer transition-all ${
                    styleIsOn("fontStyle", (v) => v === "italic")
                      ? "bg-accent/20 border-accent text-accent"
                      : "bg-transparent border-zinc-700 text-zinc-400 hover:text-zinc-50"
                  }`}
                  title="Italic — applies to the selected characters while editing text, or the whole box otherwise"
                  onMouseDown={keepFocus}
                  onClick={() =>
                    applyTextStyle({
                      fontStyle: styleIsOn("fontStyle", (v) => v === "italic") ? "normal" : "italic",
                    })
                  }
                >
                  <Italic size={14} />
                </button>
                <button
                  class={`p-1.5 rounded-md border cursor-pointer transition-all ${
                    styleIsOn("underline", (v) => v === true)
                      ? "bg-accent/20 border-accent text-accent"
                      : "bg-transparent border-zinc-700 text-zinc-400 hover:text-zinc-50"
                  }`}
                  title="Underline — applies to the selected characters while editing text, or the whole box otherwise"
                  onMouseDown={keepFocus}
                  onClick={() =>
                    applyTextStyle({ underline: !styleIsOn("underline", (v) => v === true) })
                  }
                >
                  <Underline size={14} />
                </button>
              </div>
            </div>

            {/* Emoji */}
            <div>
              <label class="text-[11px] text-zinc-400 mb-1 block">Emoji</label>
              <EmojiPicker onPick={insertEmoji} />
            </div>

            {/* Text alignment */}
            <div>
              <label class="text-[11px] text-zinc-400 mb-1 block">Alignment</label>
              <div class="flex gap-1">
                {[
                  { align: "left", icon: AlignLeft },
                  { align: "center", icon: AlignCenter },
                  { align: "right", icon: AlignRight },
                ].map(({ align, icon: Icon }) => (
                  <button
                    key={align}
                    class={`p-1.5 rounded-md border cursor-pointer transition-all ${
                      (selectedObject as any).textAlign === align
                        ? "bg-accent/20 border-accent text-accent"
                        : "bg-transparent border-zinc-700 text-zinc-400 hover:text-zinc-50"
                    }`}
                    onClick={() => updateSelectedObject({ textAlign: align })}
                  >
                    <Icon size={14} />
                  </button>
                ))}
              </div>
            </div>

            {/* Text color — the one control most likely to be aimed at a single word, so
                it reads and writes the selected characters when there are any. */}
            <div>
              <label class="text-[11px] text-zinc-400 mb-1 block">Color</label>
              <div class="flex items-center gap-2">
                <input
                  type="color"
                  class="w-8 h-8 rounded border border-zinc-700 cursor-pointer bg-transparent shrink-0"
                  value={styleValue("fill", "#ffffff")}
                  onMouseDown={keepFocus}
                  onInput={(e) => applyTextStyle({ fill: (e.target as HTMLInputElement).value })}
                />
                <input
                  type="text"
                  class="flex-1 bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-200 px-2 py-1.5 outline-none focus:border-accent font-mono"
                  value={styleOf("fill").mixed ? "" : styleValue("fill", "#ffffff")}
                  placeholder={styleOf("fill").mixed ? "varios" : undefined}
                  onKeyDown={onEnter(restoreTextFocus)}
                  onInput={(e) => applyTextStyle({ fill: (e.target as HTMLInputElement).value })}
                />
              </div>
            </div>

            {/* Outline — the other half of the legibility toolkit (lib/effects.ts covers
                the photo side): a contrasting outline keeps text readable over a busy
                image without darkening the whole picture. */}
            <div>
              <label class="text-[11px] text-zinc-400 mb-1 flex justify-between">
                Outline
                <span class="text-zinc-400 font-mono">
                  {outlineWidth > 0 ? `${outlineWidth}px` : "off"}
                </span>
              </label>
              <div class="flex items-center gap-2 mb-2">
                <input
                  type="color"
                  class="w-8 h-8 rounded border border-zinc-700 cursor-pointer bg-transparent shrink-0"
                  value={outlineColor}
                  onMouseDown={keepFocus}
                  onInput={(e) => applyOutline({ color: (e.target as HTMLInputElement).value })}
                />
                <input
                  type="text"
                  class="flex-1 bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-200 px-2 py-1.5 outline-none focus:border-accent font-mono"
                  value={outlineColor}
                  onKeyDown={onEnter(restoreTextFocus)}
                  onInput={(e) => applyOutline({ color: (e.target as HTMLInputElement).value })}
                />
              </div>
              <input
                type="range"
                min="0"
                max="20"
                step="0.5"
                class="w-full accent-accent"
                value={outlineWidth}
                onMouseDown={keepFocus}
                onInput={(e) => applyOutline({ width: parseFloat((e.target as HTMLInputElement).value) })}
              />
            </div>

            {/* Effects — the letter side of legibility over a photo. The Bg panel covers
                the picture side (lib/effects.ts); between them a headline can be made to
                read without flattening the image. */}
            <div>
              <label class="text-[11px] text-zinc-400 mb-1 block">Efectos</label>
              <div class="flex gap-1.5 mb-2">
                {([
                  { kind: "none", label: "Ninguno", hint: "Sin sombra ni resplandor" },
                  { kind: "shadow", label: "Sombra", hint: "Sombra desplazada detrás de la letra" },
                  { kind: "glow", label: "Resplandor", hint: "Halo alrededor de la letra, sin desplazamiento" },
                ] as { kind: TextGlowKind; label: string; hint: string }[]).map(({ kind, label, hint }) => (
                  <button
                    key={kind}
                    class={`flex-1 py-1 rounded-md border text-[11px] cursor-pointer transition-all ${
                      shadow.kind === kind
                        ? "bg-accent/20 border-accent text-accent"
                        : "bg-transparent border-zinc-700 text-zinc-400 hover:text-zinc-50 hover:border-zinc-500"
                    }`}
                    title={hint}
                    onMouseDown={keepFocus}
                    onClick={() => applyShadow({ kind })}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Fabric keeps one shadow per object, so these controls serve whichever of the
                  two is active — and neither can be narrowed down to a selected word. */}
              {shadow.kind !== "none" && (
                <div class="flex flex-col gap-2 pl-2 border-l border-zinc-700">
                  <div class="flex items-center gap-2">
                    <input
                      type="color"
                      class="w-8 h-8 rounded border border-zinc-700 cursor-pointer bg-transparent shrink-0"
                      value={shadow.color}
                      onMouseDown={keepFocus}
                      onInput={(e) => applyShadow({ color: (e.target as HTMLInputElement).value })}
                    />
                    <input
                      type="text"
                      class="flex-1 bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-200 px-2 py-1.5 outline-none focus:border-accent font-mono"
                      value={shadow.color}
                      onKeyDown={onEnter(restoreTextFocus)}
                      onInput={(e) => applyShadow({ color: (e.target as HTMLInputElement).value })}
                    />
                  </div>
                  <div>
                    <label class="text-[11px] text-zinc-400 mb-1 flex justify-between">
                      Intensidad
                      <span class="text-zinc-400 font-mono">{Math.round(shadow.strength * 100)}%</span>
                    </label>
                    <input
                      type="range" min="0" max="1" step="0.05" class="w-full accent-accent"
                      value={shadow.strength}
                      onMouseDown={keepFocus}
                      onInput={(e) => applyShadow({ strength: parseFloat((e.target as HTMLInputElement).value) })}
                    />
                  </div>
                  <div>
                    <label class="text-[11px] text-zinc-400 mb-1 flex justify-between">
                      Desenfoque
                      <span class="text-zinc-400 font-mono">{shadow.blur}px</span>
                    </label>
                    <input
                      type="range" min="0" max="60" step="1" class="w-full accent-accent"
                      value={shadow.blur}
                      onMouseDown={keepFocus}
                      onInput={(e) => applyShadow({ blur: parseInt((e.target as HTMLInputElement).value) })}
                    />
                  </div>
                  {/* A glow has to stay centred on the letter, so distance is hidden for it
                      rather than shown as a slider that does nothing. */}
                  {shadow.kind === "shadow" && (
                    <div>
                      <label class="text-[11px] text-zinc-400 mb-1 flex justify-between">
                        Distancia
                        <span class="text-zinc-400 font-mono">{shadow.distance}px</span>
                      </label>
                      <input
                        type="range" min="0" max="40" step="1" class="w-full accent-accent"
                        value={shadow.distance}
                        onMouseDown={keepFocus}
                        onInput={(e) => applyShadow({ distance: parseInt((e.target as HTMLInputElement).value) })}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Hollow letters and a band behind the text. Both are per-character in Fabric,
                so unlike the shadow these two do follow a selected word. */}
            <div>
              <label class="text-[11px] text-zinc-400 mb-1 block">Relleno</label>
              <button
                class={`w-full py-1 mb-2 rounded-md border text-[11px] cursor-pointer transition-all ${
                  hollow
                    ? "bg-accent/20 border-accent text-accent"
                    : "bg-transparent border-zinc-700 text-zinc-400 hover:text-zinc-50 hover:border-zinc-500"
                }`}
                title="Letra hueca: quita el relleno y deja solo el contorno, que toma el color que tenía la letra"
                onMouseDown={keepFocus}
                onClick={toggleHollow}
              >
                Hueco (solo contorno)
              </button>

              <label class="text-[11px] text-zinc-400 mb-1 flex justify-between">
                Fondo del texto
                <span class="text-zinc-400 font-mono">{textBg ? "on" : "off"}</span>
              </label>
              <div class="flex items-center gap-2">
                <input
                  type="color"
                  class="w-8 h-8 rounded border border-zinc-700 cursor-pointer bg-transparent shrink-0"
                  value={textBg || "#000000"}
                  onMouseDown={keepFocus}
                  onInput={(e) =>
                    applyTextStyle({ textBackgroundColor: (e.target as HTMLInputElement).value })
                  }
                />
                <button
                  class="flex-1 py-1.5 rounded-md border border-zinc-700 bg-transparent text-[11px] text-zinc-400 cursor-pointer transition-all hover:text-zinc-50 hover:border-zinc-500 disabled:opacity-40"
                  title="Quita la banda de color de detrás del texto"
                  disabled={!textBg}
                  onMouseDown={keepFocus}
                  onClick={() => applyTextStyle({ textBackgroundColor: "" })}
                >
                  Quitar fondo
                </button>
              </div>
            </div>

            {/* Clearing per-character overrides. Setting a colour with nothing highlighted
                leaves hand-coloured words alone on purpose (Fabric paints the character
                value over the object's), so this is the way back to a uniform box. */}
            <div>
              <button
                class="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md border border-zinc-700 bg-transparent text-[11px] text-zinc-400 cursor-pointer transition-all hover:text-zinc-50 hover:border-zinc-500"
                title={
                  range
                    ? "Devuelve los caracteres seleccionados al estilo del cuadro"
                    : "Quita los ajustes por palabra de todo el cuadro"
                }
                onMouseDown={keepFocus}
                onClick={clearTextStyle}
              >
                <Eraser size={13} />
                {range ? "Quitar formato de la selección" : "Quitar formato por palabra"}
              </button>
            </div>

            {/* Line height */}
            <div>
              <label class="text-[11px] text-zinc-400 mb-1 flex justify-between">
                Line height
                <span class="text-zinc-400 font-mono">{((selectedObject as any).lineHeight || 1.2).toFixed(1)}</span>
              </label>
              <input
                type="range"
                min="0.8"
                max="3"
                step="0.1"
                class="w-full accent-accent"
                value={(selectedObject as any).lineHeight || 1.2}
                onInput={(e) =>
                  updateSelectedObject({
                    lineHeight: parseFloat((e.target as HTMLInputElement).value),
                  })
                }
              />
            </div>

            {/* Letter spacing */}
            <div>
              <label class="text-[11px] text-zinc-400 mb-1 flex justify-between">
                Letter spacing
                <span class="text-zinc-400 font-mono">{(selectedObject as any).charSpacing || 0}</span>
              </label>
              <input
                type="range"
                min="-200"
                max="800"
                step="10"
                class="w-full accent-accent"
                value={(selectedObject as any).charSpacing || 0}
                onInput={(e) =>
                  updateSelectedObject({
                    charSpacing: parseInt((e.target as HTMLInputElement).value),
                  })
                }
              />
            </div>
          </>
        )}

        {/* ── Shape properties ──────────────────────────────────────── */}
        {isShape && (
          <>
            {/* Fill color */}
            <div>
              <label class="text-[11px] text-zinc-400 mb-1 block">Fill color</label>
              <div class="flex items-center gap-2">
                <input
                  type="color"
                  class="w-8 h-8 rounded border border-zinc-700 cursor-pointer bg-transparent shrink-0"
                  value={(selectedObject.fill as string) || "#6366f1"}
                  onInput={(e) =>
                    updateSelectedObject({ fill: (e.target as HTMLInputElement).value })
                  }
                />
                <input
                  type="text"
                  class="flex-1 bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-200 px-2 py-1.5 outline-none focus:border-accent font-mono"
                  value={(selectedObject.fill as string) || "#6366f1"}
                  onInput={(e) =>
                    updateSelectedObject({ fill: (e.target as HTMLInputElement).value })
                  }
                />
              </div>
            </div>

            {/* Stroke */}
            <div>
              <label class="text-[11px] text-zinc-400 mb-1 block">Stroke color</label>
              <div class="flex items-center gap-2">
                <input
                  type="color"
                  class="w-8 h-8 rounded border border-zinc-700 cursor-pointer bg-transparent shrink-0"
                  value={(selectedObject.stroke as string) || "#000000"}
                  onInput={(e) =>
                    updateSelectedObject({ stroke: (e.target as HTMLInputElement).value })
                  }
                />
                <input
                  type="number"
                  class="w-16 bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-200 px-2 py-1.5 outline-none focus:border-accent"
                  value={selectedObject.strokeWidth || 0}
                  min={0}
                  placeholder="Width"
                  onInput={(e) =>
                    updateSelectedObject({
                      strokeWidth: parseInt((e.target as HTMLInputElement).value) || 0,
                    })
                  }
                />
              </div>
            </div>

            {/* Border radius (for rect) */}
            {selectedObject instanceof fabric.Rect && (
              <div>
                <label class="text-[11px] text-zinc-400 mb-1 flex justify-between">
                  Border radius
                  <span class="text-zinc-400 font-mono">{(selectedObject as any).rx || 0}px</span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="100"
                  class="w-full accent-accent"
                  value={(selectedObject as any).rx || 0}
                  onInput={(e) => {
                    const val = parseInt((e.target as HTMLInputElement).value);
                    updateSelectedObject({ rx: val, ry: val });
                  }}
                />
              </div>
            )}
          </>
        )}

        {/* ── Background image ──────────────────────────────────────── */}
        {/* A photo scaled to cover the page can reach past the workspace margin, putting
            its corner handles out of reach — this panel is the dependable way to resize
            it (and to undo a bad framing). See lib/workspace.ts. */}
        {isBackground && (
          <>
            <div>
              <label class="text-[11px] text-zinc-400 mb-1 flex justify-between">
                Scale
                <span class="text-zinc-400 font-mono">
                  {Math.round((selectedObject.scaleX ?? 1) * 100)}%
                </span>
              </label>
              <input
                type="range"
                min="0.1"
                max="4"
                step="0.01"
                class="w-full accent-accent"
                value={selectedObject.scaleX ?? 1}
                onInput={(e) =>
                  setBackgroundScale(parseFloat((e.target as HTMLInputElement).value))
                }
              />
              <p class="text-[10px] text-zinc-400 mt-1">
                Also draggable directly on the canvas.
              </p>
            </div>

            <div>
              <label class="text-[11px] text-zinc-400 mb-1 block">Reset framing</label>
              <div class="flex gap-1.5">
                {(["cover", "contain"] as const).map((f) => (
                  <button
                    key={f}
                    class="flex-1 py-1 rounded-md border border-zinc-700 bg-transparent text-[11px] capitalize text-zinc-400 cursor-pointer transition-all hover:text-zinc-50 hover:border-zinc-500"
                    onClick={() => setBackgroundImageFit(f)}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ── Image properties ──────────────────────────────────────── */}
        {isImage && !isBackground && (
          <>
            <div>
              <label class="text-[11px] text-zinc-400 mb-1 block">Flip</label>
              <div class="flex gap-1">
                <button
                  class={`p-1.5 rounded-md border cursor-pointer transition-all ${
                    selectedObject.flipX
                      ? "bg-accent/20 border-accent text-accent"
                      : "bg-transparent border-zinc-700 text-zinc-400 hover:text-zinc-50"
                  }`}
                  onClick={() => updateSelectedObject({ flipX: !selectedObject.flipX })}
                >
                  <FlipHorizontal size={14} />
                </button>
                <button
                  class={`p-1.5 rounded-md border cursor-pointer transition-all ${
                    selectedObject.flipY
                      ? "bg-accent/20 border-accent text-accent"
                      : "bg-transparent border-zinc-700 text-zinc-400 hover:text-zinc-50"
                  }`}
                  onClick={() => updateSelectedObject({ flipY: !selectedObject.flipY })}
                >
                  <FlipVertical size={14} />
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── Common: Opacity ───────────────────────────────────────── */}
        <div>
          <label class="text-[11px] text-zinc-400 mb-1 flex justify-between">
            Opacity
            <span class="text-zinc-400 font-mono">{Math.round((selectedObject.opacity ?? 1) * 100)}%</span>
          </label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            class="w-full accent-accent"
            value={selectedObject.opacity ?? 1}
            onInput={(e) =>
              updateSelectedObject({
                opacity: parseFloat((e.target as HTMLInputElement).value),
              })
            }
          />
        </div>
      </div>
    </aside>
  );
}
