import * as fabric from "fabric";
import type { NewsCopy } from "./news-fields";
import { ACCOUNT_HANDLE } from "./news-fields";
import { applyBackgroundEffects, applyScrim, NO_EFFECTS } from "./effects";
import { findBackgroundImage, downscaleOversizedSource } from "./background";
import { bringLogoToFront } from "./logo";
import { syncCanvasFonts } from "./fonts";
import { BRAND } from "./palette";

/**
 * La plantilla fija de un post de noticia: foto arriba, franja translúcida abajo con el chip
 * de sección, el titular y el pie.
 *
 * La diferencia de fondo con la plantilla de eventos (`event-template.ts`) no es estética:
 * ahí el texto va **encima** de la foto, con toda la fotografía compitiendo con él, y el
 * trabajo consiste en apagarla entera (velo, desenfoque, sombra en la letra); aquí el texto
 * vive en su propia franja, así que la fotografía se queda **intacta en la mitad que se ve**
 * —sin filtros ni velos, como exige la guía— y el titular no puede competir con ella por
 * construcción. Por eso las dos plantillas no comparten paleta ni bloques.
 *
 * La franja no es opaca: deja ver la foto por detrás, desenfocada, como un cristal
 * esmerilado. Y ese desenfoque **no se aplica a la fotografía**, que sigue limpia: es una
 * copia suya, recortada a la franja (ver `syncGlass`). El color de la franja va encima con
 * la opacidad que mande `readBandOpacity`, que es lo que garantiza el contraste del titular.
 *
 * `news-fields.ts` decide *qué se dice*; este fichero solo decide *dónde se pone*.
 */

// Fabric descarta al serializar cualquier propiedad que no esté registrada, y el registro
// tiene la trampa que documenta §9.26 de CLAUDE.md: `toObject()` serializa
// `propertiesToInclude.concat(FabricObject.customProperties, this.constructor.customProperties)`,
// de modo que registrarlo solo en la clase base **no basta** — `Rect` declara su propio array
// (lo escribe `effects.ts`) y esa propiedad propia *tapa* la heredada. Se añade clase por
// clase y conservando lo que cada una ya tuviera.
//
// **Marca propia (`_nwRole`), no la `_tplRole` de los eventos**, y esto es deliberado:
// `relayoutEventTemplate` corre sobre *todos* los lienzos desde `setCanvasSize` y le basta
// encontrar un objeto con `_tplRole: "title"` para re-apilar la página como si fuera un
// evento. Con propiedades distintas las dos plantillas no pueden interferir.
//
// `FabricImage` está en la lista por la capa de cristal (`syncGlass`), y su registro depende
// del orden de evaluación de los módulos: `background.ts` **sobrescribe**
// `FabricImage.customProperties` con un array literal, así que este bucle tiene que correr
// después. Lo garantiza el `import` de `background.ts` de arriba — un módulo importado se
// evalúa antes que quien lo importa.
for (const klass of [fabric.Textbox, fabric.Rect, fabric.FabricImage] as unknown as Array<{
  customProperties?: string[];
}>) {
  klass.customProperties = [...(klass.customProperties ?? []), "_nwRole", "_nwVariant"];
}

/**
 * Marca del titular que el editor inserta **automáticamente** al abrir un registro del CRM
 * (el cuadro de texto suelto de siempre). No es parte de la plantilla, pero la plantilla
 * tiene que poder retirarlo: si no, al pulsar "Aplicar plantilla" ese titular se quedaría
 * flotando encima de la foto, duplicando el que la plantilla pinta en la franja.
 *
 * Es una marca aparte y no un `_nwRole` a propósito: `hasNewsTemplate` diría que sí hay
 * plantilla en una página que solo tiene el titular suelto, y el panel ofrecería "volver al
 * diseño normal" estando ya en él. Lo que el operador añada a mano no lleva marca y no se
 * toca nunca.
 */
export const RECORD_TITLE_PROP = "_isRecordTitle";
(fabric.Textbox as unknown as { customProperties?: string[] }).customProperties = [
  ...((fabric.Textbox as unknown as { customProperties?: string[] }).customProperties ?? []),
  RECORD_TITLE_PROP,
];

/** Marca un cuadro de texto como "el titular que puso el editor solo". */
export function markRecordTitle(obj: fabric.FabricObject): void {
  (obj as any)[RECORD_TITLE_PROP] = true;
}

export type NwRole =
  | "glass"
  | "band"
  | "chipBg"
  | "chip"
  | "figure"
  | "unit"
  | "headline"
  | "rule"
  | "account";

/** `navy` = franja azul noche con tinta crema (por defecto). `cream` = al revés. */
export type NewsVariant = "navy" | "cream";

// ── Paleta ──────────────────────────────────────────────────────────

const { navy: NAVY, amber: AMBER, cream: CREAM } = BRAND;

interface Palette {
  /** Color de la franja. Se pinta con alfa (ver `DEFAULT_BAND_ALPHA`), nunca opaco. */
  band: string;
  /** Titular y pie. */
  ink: string;
  chipFill: string;
  chipInk: string;
  /** La cifra destacada. */
  figure: string;
}

/**
 * Las dos variantes. La regla que las gobierna —y la única combinación de la paleta que está
 * prohibida— es que **ámbar y crema nunca se tocan**: sobre crema, el ámbar se queda en
 * ~2.5:1 de contraste. Por eso en la variante clara el ámbar desaparece por completo y su
 * papel (chip, cifra) lo hace el azul noche.
 */
const PALETTES: Record<NewsVariant, Palette> = {
  navy: { band: NAVY, ink: CREAM, chipFill: AMBER, chipInk: NAVY, figure: AMBER },
  cream: { band: CREAM, ink: NAVY, chipFill: NAVY, chipInk: CREAM, figure: NAVY },
};

/** Opacidades que la guía da sobre el color de tinta. */
const UNIT_ALPHA = 0.72;
const RULE_ALPHA = 0.22;
const ACCOUNT_ALPHA = 0.68;

/**
 * Cuánto cubre la franja de la foto desenfocada que tiene detrás.
 *
 * La variante clara necesita más cuerpo que la oscura, y no por gusto: debajo hay una
 * fotografía que normalmente es más oscura que el crema, así que con el mismo alfa la franja
 * clara se ensucia y el titular azul noche pierde contraste antes. El operador puede bajar
 * las dos desde el panel — `BAND_ALPHA_MIN` es el suelo, elegido para que el titular siga
 * legible sobre cualquier foto.
 */
const DEFAULT_BAND_ALPHA: Record<NewsVariant, number> = { navy: 0.82, cream: 0.86 };
export const BAND_ALPHA_MIN = 0.5;

/**
 * Cuánto se desenfoca la copia de la foto que se ve a través de la franja.
 *
 * Es el mismo valor con el que la plantilla de eventos difumina el fondo de su modo cartel:
 * suficiente para que ninguna forma reconocible compita con el titular, y no tanto como para
 * que el color deje de ser el de la foto.
 */
const GLASS_BLUR = 0.3;

function withAlpha(hex: string, alpha: number): string {
  const color = new fabric.Color(hex);
  const [r, g, b] = color.getSource();
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Medidas ─────────────────────────────────────────────────────────

/**
 * Las medidas de la guía, en píxeles sobre una página de 1080 de ancho. Se usan tal cual y
 * solo se escalan por `pageWidth / 1080`, en vez de convertirlas a fracciones: así el código
 * se puede leer al lado de la especificación sin traducir nada. Los tres presets del editor
 * miden 1080 de ancho, de modo que en la práctica el factor es 1.
 */
const REF_WIDTH = 1080;

const D = {
  /** La franja arranca aquí… salvo que el titular necesite más sitio (ver `layout`). */
  bandTopRatio: 0.62,
  padSide: 64,
  padTop: 64,
  padBottom: 48,
  // El chip es una etiqueta, no una línea de texto: a 38 px competía con el titular.
  chipSize: 30,
  chipPadX: 24,
  chipPadY: 10,
  chipRadius: 7,
  chipTracking: 2,
  gapAfterChip: 36,
  figureSize: 132,
  figureTracking: -6,
  unitSize: 44,
  /** Separación entre la cifra y su unidad. */
  gapFigureUnit: 16,
  gapAfterFigure: 24,
  headlineMax: 96,
  headlineMin: 66,
  headlineTracking: -2,
  headlineLineHeight: 0.98,
  gapAfterHeadline: 42,
  ruleHeight: 1,
  gapAfterRule: 30,
  accountSize: 34,
};

const HEADLINE_MAX_LINES = 3;
/** Paso del ajuste automático del titular. 2 px sobre un rango de 30 son 15 intentos. */
const HEADLINE_STEP = 2;

const FAMILY = "Barlow Condensed";
/** Los dos únicos pesos que admite la guía. */
const REGULAR = "400";
const MEDIUM = "500";

/**
 * Cuánto del excedente vertical de la foto se recorta por arriba. La guía pide un recorte
 * "anclado al tercio superior, nunca centrado": con 0.25 se descarta el 75 % por abajo, que
 * es lo que salva las cabezas en una foto de prensa (donde el sujeto casi nunca está en el
 * borde inferior).
 */
const PHOTO_ANCHOR = 0.25;

/**
 * Dónde cae la línea de base dentro de la caja de un texto de una sola línea, como fracción
 * del cuerpo. Fabric no expone las métricas verticales de la cara, así que este valor está
 * medido sobre Barlow Condensed; solo se usa para alinear la unidad con la base de la cifra,
 * y como las dos usan la misma cara el error se cancela salvo por la diferencia de cuerpo.
 */
const BASELINE_RATIO = 0.78;

/** El tracking de la guía viene en píxeles; `charSpacing` de Fabric va en 1/1000 em. */
function tracking(px: number, fontSize: number): number {
  return Math.round((px / fontSize) * 1000);
}

// ── Identificación ──────────────────────────────────────────────────

export function nwRole(obj: fabric.FabricObject | undefined | null): NwRole | null {
  return (obj as any)?._nwRole ?? null;
}

export function findByRole(canvas: fabric.Canvas, role: NwRole): fabric.FabricObject | undefined {
  return canvas.getObjects().find((o) => nwRole(o) === role);
}

export function hasNewsTemplate(canvas: fabric.Canvas): boolean {
  return canvas.getObjects().some((o) => nwRole(o) !== null);
}

/** La variante se *deduce* del lienzo en vez de guardarse aparte: un estado menos que pueda
 *  quedar desincronizado con lo que se ve. */
export function currentVariant(canvas: fabric.Canvas): NewsVariant {
  const marked = canvas.getObjects().find((o) => (o as any)._nwVariant);
  return ((marked as any)?._nwVariant as NewsVariant) ?? "navy";
}

/**
 * La opacidad de la franja, leída del alfa de su propio relleno — igual que la variante y el
 * modo de los eventos, se deduce del lienzo en vez de guardarse en un segundo sitio que pueda
 * contradecirlo. Mismo `match` sobre `rgba(...)` que usa `readScrim` en `effects.ts`.
 */
export function readBandOpacity(canvas: fabric.Canvas, variant?: NewsVariant): number {
  const fallback = DEFAULT_BAND_ALPHA[variant ?? currentVariant(canvas)];
  const band = findByRole(canvas, "band") as fabric.Rect | undefined;
  const fill = band?.fill;
  if (typeof fill !== "string") return fallback;
  const m = fill.match(/rgba?\([^)]*,\s*([\d.]+)\s*\)/);
  return m ? parseFloat(m[1]) : fallback;
}

/**
 * Cambia la opacidad de la franja. No re-maqueta: la geometría no depende del color.
 *
 * Devuelve `false` si esta página no tiene plantilla.
 */
export function setNewsBandOpacity(canvas: fabric.Canvas, alpha: number): boolean {
  const band = findByRole(canvas, "band") as fabric.Rect | undefined;
  if (!band) return false;
  const variant = ((band as any)._nwVariant as NewsVariant) ?? "navy";
  band.set({ fill: withAlpha(PALETTES[variant].band, alpha) });
  // `set` sobre un relleno no marca el objeto como sucio, así que Fabric volvería a estampar
  // el bitmap cacheado con el color viejo (§9.21).
  band.dirty = true;
  canvas.requestRenderAll();
  return true;
}

/** La cifra destacada tal como está en el lienzo, para que el panel no tenga que guardarla
 *  en un segundo sitio que pueda contradecir al diseño. */
export function readNewsFigure(canvas: fabric.Canvas): { valor: string; unidad: string } {
  const figure = findByRole(canvas, "figure") as fabric.Textbox | undefined;
  const unit = findByRole(canvas, "unit") as fabric.Textbox | undefined;
  return { valor: figure?.text ?? "", unidad: unit?.text ?? "" };
}

/** Borra lo que generó la plantilla y nada más: la foto, el logo y cualquier cosa que el
 *  operador haya añadido a mano no llevan marca y sobreviven. */
export function clearNewsTemplate(canvas: fabric.Canvas): void {
  for (const obj of canvas.getObjects()) {
    if (nwRole(obj) !== null) canvas.remove(obj);
  }
}

// ── Construcción de los bloques ─────────────────────────────────────

interface Built {
  band: fabric.Rect;
  chipBg?: fabric.Rect;
  chip?: fabric.Textbox;
  figure?: fabric.Textbox;
  unit?: fabric.Textbox;
  headline: fabric.Textbox;
  rule: fabric.Rect;
  account: fabric.Textbox;
}

function mark<T extends fabric.FabricObject>(obj: T, role: NwRole, variant: NewsVariant): T {
  (obj as any)._nwRole = role;
  (obj as any)._nwVariant = variant;
  return obj;
}

function makeText(
  text: string,
  role: NwRole,
  variant: NewsVariant,
  opts: {
    fontSize: number;
    fontWeight: string;
    fill: string;
    width: number;
    charSpacing?: number;
    lineHeight?: number;
  }
): fabric.Textbox {
  const box = new fabric.Textbox(text, {
    width: opts.width,
    fontSize: opts.fontSize,
    fontFamily: FAMILY,
    fontWeight: opts.fontWeight,
    fill: opts.fill,
    textAlign: "left",
    charSpacing: opts.charSpacing ?? 0,
    lineHeight: opts.lineHeight ?? 1,
    // Ni sombra, ni contorno, ni degradado: la guía los prohíbe expresamente en el texto, y
    // aquí no hacen falta porque el contraste lo da la franja, no la letra.
    shadow: null,
    editable: true,
  });
  return mark(box, role, variant);
}

/** Rectángulos generados (franja, chip, línea del pie): son chrome de la plantilla, no
 *  contenido que se arrastre, así que no reciben eventos — el clic llega al texto de encima. */
function makeRect(role: NwRole, variant: NewsVariant, fill: string, extra?: Partial<fabric.Rect>): fabric.Rect {
  const rect = new fabric.Rect({
    fill,
    selectable: false,
    evented: false,
    hoverCursor: "default",
    ...extra,
  });
  return mark(rect, role, variant);
}

function buildBlocks(
  copy: NewsCopy,
  pageWidth: number,
  variant: NewsVariant,
  bandAlpha: number
): Built {
  const s = pageWidth / REF_WIDTH;
  const p = PALETTES[variant];
  const usable = pageWidth - 2 * D.padSide * s;

  const built: Built = {
    band: makeRect("band", variant, withAlpha(p.band, bandAlpha)),
    headline: makeText(copy.titular, "headline", variant, {
      fontSize: D.headlineMax * s,
      fontWeight: MEDIUM,
      fill: p.ink,
      width: usable,
      charSpacing: tracking(D.headlineTracking, D.headlineMax),
      lineHeight: D.headlineLineHeight,
    }),
    rule: makeRect("rule", variant, withAlpha(p.ink, RULE_ALPHA)),
    account: makeText(ACCOUNT_HANDLE, "account", variant, {
      fontSize: D.accountSize * s,
      fontWeight: REGULAR,
      fill: withAlpha(p.ink, ACCOUNT_ALPHA),
      width: usable,
    }),
  };

  if (copy.seccion) {
    built.chipBg = makeRect("chipBg", variant, p.chipFill, {
      rx: D.chipRadius * s,
      ry: D.chipRadius * s,
    });
    built.chip = makeText(copy.seccion.toUpperCase(), "chip", variant, {
      fontSize: D.chipSize * s,
      fontWeight: MEDIUM,
      fill: p.chipInk,
      width: usable,
      charSpacing: tracking(D.chipTracking, D.chipSize),
    });
  }

  if (copy.dato) {
    built.figure = makeText(copy.dato, "figure", variant, {
      fontSize: D.figureSize * s,
      fontWeight: MEDIUM,
      fill: p.figure,
      width: usable,
      charSpacing: tracking(D.figureTracking, D.figureSize),
    });
    if (copy.datoUnidad) {
      built.unit = makeText(copy.datoUnidad, "unit", variant, {
        fontSize: D.unitSize * s,
        fontWeight: REGULAR,
        fill: withAlpha(p.ink, UNIT_ALPHA),
        width: usable,
      });
    }
  }

  return built;
}

// ── Maquetación ─────────────────────────────────────────────────────

function textHeight(box: fabric.Textbox): number {
  box.initDimensions();
  return (box.height ?? 0) * (box.scaleY ?? 1);
}

/** Ajusta la caja de un texto de una línea a su contenido, para que su recuadro de selección
 *  no se extienda por toda la franja. Hay que rehacerlo en cada pasada: al llegar la fuente
 *  real el ancho cambia. */
function shrinkToLine(box: fabric.Textbox, maxWidth: number): number {
  box.set({ width: maxWidth });
  box.initDimensions();
  const lineWidth = box.getLineWidth(0);
  box.set({ width: Math.min(maxWidth, Math.ceil(lineWidth) + 2) });
  box.initDimensions();
  return box.width ?? 0;
}

/**
 * Elige el cuerpo del titular: el **mayor** entre 96 y 66 px que quepa en 3 líneas y dentro
 * del hueco que deja la franja en su posición nominal (62 %).
 *
 * Las dos condiciones son de la guía y hacen falta las dos. Solo con "≤ 3 líneas" un titular
 * corto se quedaría a 96 px ocupando media página y empujando la franja muy por encima del
 * 62 %; solo con el hueco disponible, uno largo se partiría en cinco líneas. Si ni a 66 px
 * cabe —pasa con los titulares de 98 caracteres, que son lo normal en el CRM— se queda en 66
 * y es la franja la que crece hacia arriba: la regla innegociable es que el titular no se
 * superponga a la foto, no que la franja mida exactamente el 38 %.
 */
function fitHeadline(box: fabric.Textbox, maxWidth: number, budget: number, scale: number): void {
  const max = D.headlineMax * scale;
  const min = D.headlineMin * scale;
  const step = HEADLINE_STEP * scale;
  box.set({ width: maxWidth });

  for (let size = max; size >= min; size -= step) {
    box.set({ fontSize: size, charSpacing: tracking(D.headlineTracking, size / scale) });
    box.initDimensions();
    const tooManyLines = box.textLines.length > HEADLINE_MAX_LINES;
    // El ajuste de línea no salva una palabra más ancha que la caja: `Textbox` no parte
    // palabras, así que un topónimo largo desborda por mucho que sobre altura.
    const overflows = box.textLines.some((_, li) => box.getLineWidth(li) > maxWidth + 1);
    if (!tooManyLines && !overflows && textHeight(box) <= budget) return;
  }

  box.set({ fontSize: min, charSpacing: tracking(D.headlineTracking, D.headlineMin) });
  box.initDimensions();
}

interface LayoutResult {
  /** Y donde empieza la franja, es decir dónde acaba la foto. */
  bandTop: number;
}

/**
 * Coloca la franja y su contenido, y encaja la foto en lo que queda arriba.
 *
 * El contenido se ancla **por abajo** (el pie clavado a 48 px del borde) y la franja se
 * calcula *después*, a partir de lo que ha ocupado. Ese orden es lo que garantiza que el
 * titular nunca entre en la zona de la foto, independientemente de cuántas líneas ocupe.
 */
function layout(built: Built, canvas: fabric.Canvas, pageWidth: number, pageHeight: number): LayoutResult {
  const s = pageWidth / REF_WIDTH;
  const left = D.padSide * s;
  const usable = pageWidth - 2 * left;

  // Todo lo que no es el titular, incluida la separación que lleva debajo: es lo que hay que
  // descontar para saber de cuánto sitio dispone.
  const chipHeight = built.chip ? textHeight(built.chip) + 2 * D.chipPadY * s : 0;
  const chipGap = built.chip ? D.gapAfterChip * s : 0;
  const figureHeight = built.figure ? textHeight(built.figure) : 0;
  const figureGap = built.figure ? D.gapAfterFigure * s : 0;
  const ruleBlock = D.gapAfterHeadline * s + D.ruleHeight * s + D.gapAfterRule * s;
  const accountHeight = textHeight(built.account);
  const fixed = chipHeight + chipGap + figureHeight + figureGap + ruleBlock + accountHeight;

  const nominalBandTop = Math.round(pageHeight * D.bandTopRatio);
  const budget = pageHeight - nominalBandTop - D.padTop * s - D.padBottom * s - fixed;
  fitHeadline(built.headline, usable, budget, s);

  const headlineHeight = textHeight(built.headline);
  const content = fixed + headlineHeight;
  const contentTop = pageHeight - D.padBottom * s - content;
  const bandTop = Math.min(nominalBandTop, Math.round(contentTop - D.padTop * s));

  built.band.set({ left: 0, top: bandTop, width: pageWidth, height: pageHeight - bandTop, scaleX: 1, scaleY: 1 });
  built.band.setCoords();

  let y = contentTop;

  if (built.chip && built.chipBg) {
    const lineWidth = shrinkToLine(built.chip, usable);
    const h = textHeight(built.chip);
    built.chipBg.set({
      left,
      top: y,
      width: lineWidth + 2 * D.chipPadX * s,
      height: h + 2 * D.chipPadY * s,
      scaleX: 1,
      scaleY: 1,
    });
    built.chipBg.setCoords();
    built.chip.set({ left: left + D.chipPadX * s, top: y + D.chipPadY * s });
    built.chip.setCoords();
    y += h + 2 * D.chipPadY * s + D.gapAfterChip * s;
  }

  if (built.figure) {
    const figureWidth = shrinkToLine(built.figure, usable);
    built.figure.set({ left, top: y });
    built.figure.setCoords();
    if (built.unit) {
      shrinkToLine(built.unit, usable);
      // Alineada con la **base** de la cifra, no con su borde superior: como las dos usan la
      // misma cara, basta desplazarla por la diferencia de cuerpo (ver BASELINE_RATIO).
      const drop = ((built.figure.fontSize ?? 0) - (built.unit.fontSize ?? 0)) * BASELINE_RATIO;
      built.unit.set({ left: left + figureWidth + D.gapFigureUnit * s, top: y + drop });
      built.unit.setCoords();
    }
    y += textHeight(built.figure) + D.gapAfterFigure * s;
  }

  built.headline.set({ left, top: y, width: usable });
  built.headline.setCoords();
  y += headlineHeight + D.gapAfterHeadline * s;

  built.rule.set({ left, top: y, width: usable, height: D.ruleHeight * s, scaleX: 1, scaleY: 1 });
  built.rule.setCoords();
  y += D.ruleHeight * s + D.gapAfterRule * s;

  built.account.set({ left, top: y, width: usable });
  built.account.setCoords();

  // La foto primero, que además la manda al fondo: así el índice base de abajo es fiable.
  fitPhotoToBand(canvas, pageWidth, bandTop);
  // Y su copia desenfocada, recortada a la franja recién colocada. Va aquí, dentro de
  // `layout`, para que las cinco rutas que mueven la franja o cambian la foto la actualicen
  // sin tener que acordarse de ella (ver el comentario de `syncGlass`).
  syncGlass(canvas, pageWidth, pageHeight, bandTop, ((built.band as any)._nwVariant as NewsVariant) ?? "navy");

  // Orden interno de la plantilla: el cristal va sobre la foto, la franja sobre el cristal y
  // el resto encima, en el orden del diseño.
  //
  // Se mueven a un tramo contiguo **justo encima de la foto** en vez de subirlos al frente.
  // Subirlos dejaría cualquier objeto que el operador haya añadido a mano por *debajo* de la
  // franja — su trabajo desaparecería al cambiar de formato. Así lo añadido a mano se queda
  // arriba, que es lo que cualquiera espera.
  const photo = findBackgroundImage(canvas);
  const glass = findByRole(canvas, "glass");
  let index = photo ? 1 : 0;
  for (const obj of [glass, built.band, built.chipBg, built.chip, built.figure, built.unit, built.headline, built.rule, built.account]) {
    if (!obj) continue;
    canvas.moveObjectTo(obj, index);
    index++;
  }

  bringLogoToFront(canvas);
  return { bandTop };
}

/**
 * Encaja la foto en la banda superior: cover sobre `pageWidth × bandTop`, centrada en
 * horizontal y anclada al tercio alto en vertical (ver PHOTO_ANCHOR).
 *
 * No se reutiliza `fitBackgroundImage` de `use-canvas.ts` porque esa encaja contra la página
 * entera y centra el recorte, que es exactamente lo que la guía descarta.
 */
export function fitPhotoToBand(canvas: fabric.Canvas, pageWidth: number, bandTop: number): void {
  const img = findBackgroundImage(canvas);
  if (!img) return;
  const natW = img.width || 1;
  const natH = img.height || 1;
  const scale = Math.max(pageWidth / natW, bandTop / natH);
  const overflowY = natH * scale - bandTop;
  img.set({
    scaleX: scale,
    scaleY: scale,
    left: (pageWidth - natW * scale) / 2,
    top: -overflowY * PHOTO_ANCHOR,
  });
  img.setCoords();
  canvas.sendObjectToBack(img);
}

// ── Cristal: la foto desenfocada que se ve a través de la franja ────

/** El `src` con el que se construyó una imagen, sea cual sea el camino por el que llegó. */
function sourceUrl(img: fabric.FabricImage): string {
  return ((img as any)._srcUrl as string) || img.getSrc() || "";
}

/**
 * Crea, actualiza o quita la copia desenfocada de la foto que se ve por debajo de la franja.
 *
 * Se construye **de forma síncrona** desde el mismo elemento de la foto, en vez de con
 * `clone()` (que es lo que hace el cartel de los eventos): así cabe dentro de `layout()`, que
 * es síncrona y es el único punto por el que pasan las cinco rutas que pueden mover la franja
 * o cambiar la foto. Un `clone()` obligaría a repetir el refresco en cada una de ellas, que es
 * exactamente el error que §9.18 costó cuatro sitios encontrar.
 *
 * Geometría: la misma escala y el mismo `left` que la foto de arriba, anclada al borde
 * inferior de la página. La franja enseña así la continuación de la misma fotografía, al mismo
 * zoom y con el mismo encuadre horizontal, en vez de un recorte a otra escala que se lee como
 * una segunda imagen.
 */
function syncGlass(
  canvas: fabric.Canvas,
  pageWidth: number,
  pageHeight: number,
  bandTop: number,
  variant: NewsVariant
): void {
  const photo = findBackgroundImage(canvas);
  const existing = findByRole(canvas, "glass") as fabric.FabricImage | undefined;

  if (!photo) {
    // Sin foto no hay nada que ver a través de la franja; dejarla sería un rectángulo con la
    // última imagen que hubo, congelada.
    if (existing) canvas.remove(existing);
    return;
  }

  const src = sourceUrl(photo);
  let glass = existing;

  // Re-filtrar un bitmap de 4096 px es lo caro de todo esto, y mover la franja no lo necesita:
  // solo se reconstruye si la foto ha cambiado (o si no había cristal todavía).
  if (!glass || sourceUrl(glass) !== src) {
    if (glass) canvas.remove(glass);
    // `_originalElement` y no `getElement()`: este último devuelve el bitmap ya filtrado en
    // cuanto la imagen lleva efectos, y desenfocar eso encadenaría filtros sobre filtros.
    const el = (photo as any)._originalElement as HTMLImageElement | HTMLCanvasElement | undefined;
    if (!el) return;
    glass = new fabric.FabricImage(el, {
      selectable: false,
      evented: false,
      hoverCursor: "default",
    });
    // Sin esto, Fabric serializa la imagen incrustando el bitmap entero en base64 dentro de
    // `canvas_json` — construirla desde un elemento es justo el caso que dispara eso (§9.18).
    (glass as any)._srcUrl = src;
    // Normalmente no hace nada —la foto ya llega reducida— pero si el elemento pasara de
    // 4096 px el desenfoque borraría todo lo que sobresale, en silencio (§9.18).
    downscaleOversizedSource(glass);
    glass.filters = [new fabric.filters.Blur({ blur: GLASS_BLUR })];
    glass.applyFilters();
    canvas.add(glass);
  }

  mark(glass, "glass", variant);

  // Misma escala que la foto, anclada abajo. `fitPhotoToBand` deja siempre la foto con al
  // menos el alto de la banda superior, que es mayor que el de la franja, así que en la
  // práctica cubre; el `max` cubre el caso degenerado (una foto en la que no fuera cierto)
  // subiendo la escala lo justo para tapar la franja.
  const natW = glass.width || 1;
  const natH = glass.height || 1;
  const bandHeight = pageHeight - bandTop;
  const scale = Math.max(photo.scaleX ?? 1, bandHeight / natH, pageWidth / natW);
  glass.set({
    scaleX: scale,
    scaleY: scale,
    left: scale === (photo.scaleX ?? 1) ? (photo.left ?? 0) : (pageWidth - natW * scale) / 2,
    top: pageHeight - natH * scale,
  });
  // El recorte se rehace siempre: la franja cambia de altura con el titular y con el formato.
  glass.clipPath = new fabric.Rect({
    left: 0,
    top: bandTop,
    width: pageWidth,
    height: bandHeight,
    absolutePositioned: true,
  });
  glass.setCoords();
}

// ── Composición ─────────────────────────────────────────────────────

export interface ComposeNewsOptions {
  pageWidth: number;
  pageHeight: number;
  variant?: NewsVariant;
  /** Opacidad de la franja, 0–1. Por defecto, la de la variante. */
  bandAlpha?: number;
}

/**
 * Compone la página entera. Borra lo que hubiera de una composición anterior, así que sirve
 * igual para la primera apertura y para "Rehacer plantilla".
 */
export async function composeNewsTemplate(
  canvas: fabric.Canvas,
  copy: NewsCopy,
  opts: ComposeNewsOptions
): Promise<NewsVariant> {
  const { pageWidth, pageHeight } = opts;
  const variant = opts.variant ?? "navy";
  // Rehacer la plantilla conserva la opacidad que el operador hubiera elegido: es un ajuste
  // suyo sobre el diseño, no un dato del registro que haya que volver a leer de Twenty.
  const bandAlpha = opts.bandAlpha ?? readBandOpacity(canvas, variant);
  clearNewsTemplate(canvas);
  // El titular suelto que el editor pone al abrir el registro lo sustituye el de la franja.
  for (const obj of canvas.getObjects()) {
    if ((obj as any)[RECORD_TITLE_PROP]) canvas.remove(obj);
  }

  // "La fotografía conserva sus colores originales sin filtros ni virados", y "sin texto,
  // degradados ni velos encima": se limpia lo que hubiera puesto el operador (o la plantilla
  // de eventos, si el diseño viene de ahí) en vez de dejarlo a medias.
  applyBackgroundEffects(canvas, NO_EFFECTS);
  applyScrim(canvas, pageWidth, pageHeight, "none", 0);

  if (!findBackgroundImage(canvas)) {
    // Sin foto, la mitad de arriba se quedaría en el blanco del lienzo — y con la variante
    // clara ni se vería dónde empieza la franja. El azul de marca deja claro que falta la
    // imagen sin que el diseño parezca roto.
    canvas.backgroundColor = NAVY;
  }

  const built = buildBlocks(copy, pageWidth, variant, bandAlpha);
  for (const obj of [built.band, built.chipBg, built.chip, built.figure, built.unit, built.headline, built.rule, built.account]) {
    if (obj) canvas.add(obj);
  }

  // Primera pasada con las fuentes que haya; la de verdad, después.
  layout(built, canvas, pageWidth, pageHeight);
  // El texto en canvas no dispara la descarga de webfonts, así que lo que se acaba de medir
  // son las métricas de la cara de reserva (§9.13 bug B). Y aquí no basta con recolocar: si
  // el titular pasa de dos líneas a tres al llegar Barlow Condensed, cambia también la altura
  // de la franja y con ella el encaje de la foto — hay que maquetar entero otra vez.
  await syncCanvasFonts(canvas);
  layout(built, canvas, pageWidth, pageHeight);

  canvas.requestRenderAll();
  return variant;
}

/**
 * Re-maqueta la plantilla ya existente para un tamaño de página nuevo, sin volver a pedir
 * nada a Twenty ni tocar los textos. Devuelve `false` si esta página no tiene plantilla.
 *
 * Es lo que hace que cambiar a Story o a cuadrado *adapte* el diseño en vez de dejar la
 * franja anclada al borde inferior de la página anterior. También re-encaja la foto, que
 * estaba ajustada a la banda de antes.
 */
export function relayoutNewsTemplate(
  canvas: fabric.Canvas,
  pageWidth: number,
  pageHeight: number
): boolean {
  const built = collect(canvas);
  if (!built) return false;
  const s = pageWidth / REF_WIDTH;
  // Los cuerpos van en proporción al ancho, y el titular vuelve a su cuerpo nominal antes de
  // reajustarse: `fitHeadline` solo sabe encoger desde el máximo, así que sin este reinicio
  // cada cambio de formato lo dejaría un poco más pequeño que el anterior, sin vuelta atrás.
  built.headline.set({ fontSize: D.headlineMax * s });
  if (built.chip) built.chip.set({ fontSize: D.chipSize * s });
  if (built.figure) built.figure.set({ fontSize: D.figureSize * s });
  if (built.unit) built.unit.set({ fontSize: D.unitSize * s });
  built.account.set({ fontSize: D.accountSize * s });

  layout(built, canvas, pageWidth, pageHeight);
  canvas.requestRenderAll();
  return true;
}

/** Los objetos de la plantilla que hay en el lienzo, indexados por su papel. */
function collect(canvas: fabric.Canvas): Built | null {
  const byRole = new Map<NwRole, fabric.FabricObject>();
  for (const obj of canvas.getObjects()) {
    const role = nwRole(obj);
    if (role) byRole.set(role, obj);
  }
  const band = byRole.get("band") as fabric.Rect | undefined;
  const headline = byRole.get("headline") as fabric.Textbox | undefined;
  const rule = byRole.get("rule") as fabric.Rect | undefined;
  const account = byRole.get("account") as fabric.Textbox | undefined;
  // Sin estos cuatro no hay nada que re-maquetar: son los que existen siempre.
  if (!band || !headline || !rule || !account) return null;
  // El cristal no aparece aquí a propósito: no es un bloque que se apile ni que se recoloree,
  // lo gestiona `syncGlass` a partir de la foto y de la franja ya colocada.
  return {
    band,
    headline,
    rule,
    account,
    chipBg: byRole.get("chipBg") as fabric.Rect | undefined,
    chip: byRole.get("chip") as fabric.Textbox | undefined,
    figure: byRole.get("figure") as fabric.Textbox | undefined,
    unit: byRole.get("unit") as fabric.Textbox | undefined,
  };
}

/**
 * Cambia de variante recoloreando lo que ya hay, en vez de recomponer.
 *
 * Importa: recomponer volvería a pedir el registro a Twenty y **descartaría los retoques que
 * el operador haya hecho sobre los textos generados**, que es un precio absurdo por cambiar
 * dos colores. La geometría no cambia, así que tampoco hace falta re-maquetar.
 */
export function applyNewsVariant(canvas: fabric.Canvas, variant: NewsVariant): boolean {
  const built = collect(canvas);
  if (!built) return false;
  const p = PALETTES[variant];

  // Se conserva la opacidad que el operador hubiera puesto —mismo criterio que `setScrim` con
  // el tono del velo (§9.27)— salvo que siguiera en el valor por defecto de la variante que
  // deja, en cuyo caso pasa al de la nueva: las dos no cubren igual (ver DEFAULT_BAND_ALPHA).
  const previous = ((built.band as any)._nwVariant as NewsVariant) ?? "navy";
  const current = readBandOpacity(canvas, previous);
  const alpha = current === DEFAULT_BAND_ALPHA[previous] ? DEFAULT_BAND_ALPHA[variant] : current;

  built.band.set({ fill: withAlpha(p.band, alpha) });
  built.headline.set({ fill: p.ink });
  built.rule.set({ fill: withAlpha(p.ink, RULE_ALPHA) });
  built.account.set({ fill: withAlpha(p.ink, ACCOUNT_ALPHA) });
  built.chipBg?.set({ fill: p.chipFill });
  built.chip?.set({ fill: p.chipInk });
  built.figure?.set({ fill: p.figure });
  built.unit?.set({ fill: withAlpha(p.ink, UNIT_ALPHA) });

  // El cristal no cambia de color, pero sí lleva la marca de variante: `currentVariant` coge
  // el primer objeto que la tenga, y si se quedara con la vieja el panel mentiría.
  const glass = findByRole(canvas, "glass");
  for (const obj of [glass, built.band, built.chipBg, built.chip, built.figure, built.unit, built.headline, built.rule, built.account]) {
    if (!obj) continue;
    (obj as any)._nwVariant = variant;
    // `set` sobre el relleno de un texto no marca el objeto como sucio, así que Fabric
    // volvería a estampar el bitmap cacheado con el color viejo (§9.21).
    obj.dirty = true;
  }
  canvas.requestRenderAll();
  return true;
}

/**
 * Pone, cambia o quita la cifra destacada. Es el único bloque que no sale del CRM: no existe
 * como campo en Twenty, así que lo escribe el operador desde el panel.
 *
 * Vaciar la cifra borra el bloque y el titular sube a ocupar su sitio, que es lo que dice la
 * guía ("si es null, se omite y el titular sube").
 */
export function setNewsFigure(
  canvas: fabric.Canvas,
  valor: string,
  unidad: string,
  pageWidth: number,
  pageHeight: number
): boolean {
  const built = collect(canvas);
  if (!built) return false;
  const s = pageWidth / REF_WIDTH;
  const variant = currentVariant(canvas);
  const p = PALETTES[variant];
  const usable = pageWidth - 2 * D.padSide * s;
  const value = valor.trim();
  // La unidad sin cifra no dice nada, así que se va con ella.
  const unit = value ? unidad.trim() : "";

  if (!value) {
    if (built.figure) canvas.remove(built.figure);
    if (built.unit) canvas.remove(built.unit);
    built.figure = undefined;
    built.unit = undefined;
  } else {
    if (built.figure) {
      built.figure.set({ text: value });
      built.figure.dirty = true;
    } else {
      built.figure = makeText(value, "figure", variant, {
        fontSize: D.figureSize * s,
        fontWeight: MEDIUM,
        fill: p.figure,
        width: usable,
        charSpacing: tracking(D.figureTracking, D.figureSize),
      });
      canvas.add(built.figure);
    }
    if (!unit) {
      if (built.unit) canvas.remove(built.unit);
      built.unit = undefined;
    } else if (built.unit) {
      built.unit.set({ text: unit });
      built.unit.dirty = true;
    } else {
      built.unit = makeText(unit, "unit", variant, {
        fontSize: D.unitSize * s,
        fontWeight: REGULAR,
        fill: withAlpha(p.ink, UNIT_ALPHA),
        width: usable,
      });
      canvas.add(built.unit);
    }
  }

  layout(built, canvas, pageWidth, pageHeight);
  canvas.requestRenderAll();
  return true;
}
