import * as fabric from "fabric";
import type { BackgroundEffects, ScrimKind } from "./effects";

/**
 * The "local news post" recipe, as a set of editor settings.
 *
 * This started life as a prompt handed to an image model. Written out as concrete values it
 * turns out that almost none of it needs a model: keeping the framing, not cropping, not
 * inventing objects and not regenerating the photograph — most of what that prompt spends
 * its length insisting on — are guaranteed here simply because nothing ever repaints the
 * photo. What is left is a handful of filters and type settings, which are cheap, instant,
 * identical every time, and undoable.
 *
 * The other reason to do it here: run through a model, the headline comes back as pixels. A
 * typo then means regenerating the whole image. Applied to the canvas it stays real text —
 * still editable, still selectable word by word, still saved in `canvas_json`.
 *
 * Every value below is also exposed as its own control, so this is a starting point rather
 * than a black box.
 */

/**
 * Photo treatment: "mejorar ligeramente nitidez y contraste" and "oscurecer suavemente…
 * sin exagerar". Deliberately restrained — the photo has to stay clearly readable, which is
 * the point the source prompt makes twice.
 */
export const PHOTO_RECIPE: BackgroundEffects & { scrimKind: ScrimKind; scrimOpacity: number } = {
  sharpen: 0.35,
  contrast: 0.12,
  brightness: -0.1,
  blur: 0,
  // A uniform veil rather than a gradient: the headline sits in the middle of the frame in
  // this layout, so darkening only one edge would miss it.
  scrimKind: "solid",
  scrimOpacity: 0.3,
};

/** Proportions, not pixels, so the recipe holds on the 1080×1350 and 1080×1920 presets too. */
const HEADLINE = {
  /** Leaves the side margins the prompt asks for. */
  widthOfPage: 0.82,
  /** ~83px on a 1080 page: large, and short enough to break into balanced lines. */
  sizeOfPage: 1 / 13,
  /** "Interlineado compacto pero legible". */
  lineHeight: 1.05,
  /** "Espaciado entre letras ligeramente reducido" — Fabric counts these in 1/1000 em. */
  charSpacing: -20,
  shadowBlurOfSize: 0.16,
  shadowOffsetOfSize: 0.05,
};

export interface HeadlineRecipe {
  props: Record<string, unknown>;
  /** Applied after the box has re-measured, since centring needs its final height. */
  width: number;
}

/**
 * The typographic half: heavy sans, white, centred, tight, with a discreet shadow and no
 * outline. Returns plain props so it goes through `applyTextStyle` like every other text
 * change — which means it lands on the history stack and Ctrl+Z takes it back.
 */
export function headlineRecipe(pageWidth: number): HeadlineRecipe {
  const fontSize = Math.round(pageWidth * HEADLINE.sizeOfPage);
  return {
    width: Math.round(pageWidth * HEADLINE.widthOfPage),
    props: {
      fontFamily: "Montserrat",
      // 800 is shipped under public/fonts/Montserrat — this is the "Montserrat ExtraBold"
      // the recipe names, not a synthesised bold.
      fontWeight: "800",
      fontStyle: "normal",
      underline: false,
      fill: "#ffffff",
      textAlign: "center",
      lineHeight: HEADLINE.lineHeight,
      charSpacing: HEADLINE.charSpacing,
      // "Sin contorno grueso": the shadow does the separating instead.
      stroke: null,
      strokeWidth: 0,
      shadow: new fabric.Shadow({
        color: "rgba(0,0,0,0.55)",
        blur: Math.round(fontSize * HEADLINE.shadowBlurOfSize),
        offsetX: Math.round(fontSize * HEADLINE.shadowOffsetOfSize),
        offsetY: Math.round(fontSize * HEADLINE.shadowOffsetOfSize),
        affectStroke: true,
      }),
      fontSize,
    },
  };
}

/**
 * Uppercases the text without disturbing per-character formatting.
 *
 * `styles` is keyed by character position, so this is only safe while the length is
 * unchanged — true for Spanish (á→Á) but not universally (ß→SS), hence the guard. A
 * highlighted word keeps its colour either way; it would simply be left in its original
 * case if some locale ever broke the assumption.
 */
export function uppercaseText(text: string): string | null {
  const upper = text.toUpperCase();
  return upper.length === text.length && upper !== text ? upper : null;
}

/** Centres a text box on the page, horizontally and vertically. */
export function centreOnPage(obj: fabric.FabricObject, pageWidth: number, pageHeight: number): void {
  obj.set({
    left: (pageWidth - (obj.width ?? 0) * (obj.scaleX ?? 1)) / 2,
    top: (pageHeight - (obj.height ?? 0) * (obj.scaleY ?? 1)) / 2,
  });
  obj.setCoords();
}
