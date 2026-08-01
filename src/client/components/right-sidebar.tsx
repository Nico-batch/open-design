import { useState, useEffect } from "preact/hooks";
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
} from "lucide-preact";
import * as fabric from "fabric";
import { useEditor } from "../context";
import { FONT_FAMILIES } from "../lib/fonts";
import { isBackgroundImage } from "../lib/background";
import { EmojiPicker } from "./emoji-picker";

export function RightSidebar() {
  const {
    selectedObject,
    updateSelectedObject,
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

  // Fabric defaults strokeWidth to 1 with stroke:null, so width alone doesn't tell you
  // whether there's an outline — without checking the colour too, the panel would claim
  // "1px" on text that has none.
  const hasOutline = !!selectedObject?.stroke && ((selectedObject?.strokeWidth as number) ?? 0) > 0;
  const outlineWidth = hasOutline ? (selectedObject!.strokeWidth as number) : 0;
  const outlineColor = ((selectedObject?.stroke as string) || "#000000").toString();

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
    const fontSize = ((selectedObject as any).fontSize as number) || 48;
    const nextWidth =
      width ?? (outlineWidth > 0 ? outlineWidth : Math.max(2, Math.round(fontSize * 0.06)));

    // Dragging the width to 0 clears the colour too, so "off" is genuinely off rather
    // than a zero-width stroke lingering on the object.
    if (nextWidth === 0) {
      updateSelectedObject({ stroke: null, strokeWidth: 0 });
      return;
    }

    updateSelectedObject({
      stroke: color ?? outlineColor,
      strokeWidth: nextWidth,
      paintFirst: "stroke",
      strokeLineJoin: "round",
      strokeUniform: true,
    });
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
            {/* Font family */}
            <div>
              <label class="text-[11px] text-zinc-400 mb-1 block">Font family</label>
              <select
                class="w-full bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-200 px-2 py-1.5 outline-none cursor-pointer focus:border-accent"
                value={(selectedObject as any).fontFamily || "Inter"}
                onChange={(e) =>
                  updateSelectedObject({ fontFamily: (e.target as HTMLSelectElement).value })
                }
              >
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
                value={(selectedObject as any).fontSize || 18}
                onInput={(e) =>
                  updateSelectedObject({
                    fontSize: parseInt((e.target as HTMLInputElement).value) || 18,
                  })
                }
              />
            </div>

            {/* Bold / Italic / Underline */}
            <div>
              <label class="text-[11px] text-zinc-400 mb-1 block">Style</label>
              <div class="flex gap-1">
                <button
                  class={`p-1.5 rounded-md border cursor-pointer transition-all ${
                    (selectedObject as any).fontWeight === "700" || (selectedObject as any).fontWeight === "bold"
                      ? "bg-accent/20 border-accent text-accent"
                      : "bg-transparent border-zinc-700 text-zinc-400 hover:text-zinc-50"
                  }`}
                  title="Bold — applies to the selected characters while editing text, or the whole box otherwise"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={toggleBold}
                >
                  <Bold size={14} />
                </button>
                <button
                  class={`p-1.5 rounded-md border cursor-pointer transition-all ${
                    (selectedObject as any).fontStyle === "italic"
                      ? "bg-accent/20 border-accent text-accent"
                      : "bg-transparent border-zinc-700 text-zinc-400 hover:text-zinc-50"
                  }`}
                  onClick={() =>
                    updateSelectedObject({
                      fontStyle: (selectedObject as any).fontStyle === "italic" ? "normal" : "italic",
                    })
                  }
                >
                  <Italic size={14} />
                </button>
                <button
                  class={`p-1.5 rounded-md border cursor-pointer transition-all ${
                    (selectedObject as any).underline
                      ? "bg-accent/20 border-accent text-accent"
                      : "bg-transparent border-zinc-700 text-zinc-400 hover:text-zinc-50"
                  }`}
                  onClick={() =>
                    updateSelectedObject({ underline: !(selectedObject as any).underline })
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

            {/* Text color */}
            <div>
              <label class="text-[11px] text-zinc-400 mb-1 block">Color</label>
              <div class="flex items-center gap-2">
                <input
                  type="color"
                  class="w-8 h-8 rounded border border-zinc-700 cursor-pointer bg-transparent shrink-0"
                  value={((selectedObject as any).fill as string) || "#ffffff"}
                  onInput={(e) =>
                    updateSelectedObject({ fill: (e.target as HTMLInputElement).value })
                  }
                />
                <input
                  type="text"
                  class="flex-1 bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-200 px-2 py-1.5 outline-none focus:border-accent font-mono"
                  value={((selectedObject as any).fill as string) || "#ffffff"}
                  onInput={(e) =>
                    updateSelectedObject({ fill: (e.target as HTMLInputElement).value })
                  }
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
                  onInput={(e) => applyOutline({ color: (e.target as HTMLInputElement).value })}
                />
                <input
                  type="text"
                  class="flex-1 bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-200 px-2 py-1.5 outline-none focus:border-accent font-mono"
                  value={outlineColor}
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
                onInput={(e) => applyOutline({ width: parseFloat((e.target as HTMLInputElement).value) })}
              />
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
