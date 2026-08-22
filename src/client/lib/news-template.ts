import * as fabric from "fabric";
import type { NewsCopy } from "./news-fields";
import { ACCOUNT_HANDLE } from "./news-fields";
import { applyBackgroundEffects, applyScrim, NO_EFFECTS } from "./effects";
import { findBackgroundImage, downscaleOversizedSource } from "./background";
import { bringLogoToFront } from "./logo";
import { syncCanvasFonts } from "./fonts";
import { BRAND } from "./palette";

/**
 * La plantilla fija de un post de noticia: **una sola fotografía a página completa**, nítida
 * arriba y desenfocada abajo, con el chip de sección, el titular y el pie sobre la parte
 * desenfocada.
 *
 * No hay ningún bloque de color: la mitad de abajo es la misma foto, sin virar y sin velo.
 * Y no hay ningún corte entre las dos mitades, que es la razón de ser de todo el diseño —
 * la copia desenfocada va **exactamente encima de la original, con su misma transformación**,
 * y aparece con un degradado de alfa (ver `syncGlass` y `fadeMask`), de modo que lo único que
 * cambia a lo largo de esa transición es la nitidez. Los mismos píxeles, cada vez más suaves.
 *
 * De ahí se sigue el resto: sin bloque de color, la legibilidad del texto tiene que salir de
 * otro sitio, y sale de tres a la vez — el desenfoque (que borra el *detalle* del fondo, que
 * es lo que de verdad estorba a la lectura), el peso de la letra (Barlow Condensed 600) y una
 * sombra o un halo bajo la tinta. Cuál de los dos se elige lo decide la propia fotografía:
 * `chooseInk` mide su luminancia media en la zona del texto.
 *
 * Con la plantilla de eventos (`event-template.ts`) comparte ahora la idea —texto sobre foto,
 * contraste resuelto en la letra— pero no la ejecución: allí la foto se apaga entera con un
 * velo, aquí se conserva a plena luz en la mitad que se ve y solo se difumina la otra.
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

/** Si la página ya tiene el titular suelto que pone el editor al abrir el registro. */
export function hasRecordTitle(canvas: fabric.Canvas): boolean {
  return canvas.getObjects().some((o) => (o as any)[RECORD_TITLE_PROP]);
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

/**
 * De qué color va la tinta. Los nombres vienen de cuando la franja era un bloque de color y
 * se conservan porque están grabados en el `canvas_json` de los borradores ya guardados:
 * `navy` es la combinación **de tinta clara** (crema sobre foto, con sombra oscura) y `cream`
 * la de **tinta oscura** (azul noche sobre foto, con halo claro). El panel los llama por lo
 * que hacen hoy — "Tinta clara" y "Tinta oscura" — no por su clave.
 */
export type NewsVariant = "navy" | "cream";

// ── Paleta ──────────────────────────────────────────────────────────

const { navy: NAVY, amber: AMBER, cream: CREAM } = BRAND;

interface Palette {
  /** Titular y pie. */
  ink: string;
  /** Sombra o halo bajo la tinta: es lo que despega el texto de la foto. */
  shadow: string;
  /** Una sombra proyectada se desplaza; un halo tiene que quedarse centrado en la letra. */
  shadowOffset: boolean;
  chipFill: string;
  chipInk: string;
  /** La cifra destacada. */
  figure: string;
}

/**
 * Las dos variantes.
 *
 * Ya no cambian el color de ningún bloque —desde §9.30 no hay ninguno: el texto va
 * directamente sobre la fotografía desenfocada— sino **de qué lado está el contraste**, que es
 * el mismo criterio que gobierna los dos temas de la plantilla de eventos (§9.27). Con tinta
 * clara lo que separa la letra del fondo es una sombra oscura; con tinta oscura esa sombra
 * ensuciaría el texto y hace falta lo contrario, un halo claro sin desplazamiento.
 *
 * La regla de la paleta sigue en pie: **ámbar y crema nunca se tocan** (sobre crema el ámbar
 * se queda en ~2.5:1), así que con tinta oscura el ámbar desaparece y su papel lo hace el azul
 * noche.
 */
const PALETTES: Record<NewsVariant, Palette> = {
  navy: {
    ink: CREAM,
    shadow: "rgba(0,0,0,0.62)",
    shadowOffset: true,
    chipFill: AMBER,
    chipInk: NAVY,
    figure: AMBER,
  },
  cream: {
    ink: NAVY,
    shadow: "rgba(251,247,240,0.9)",
    shadowOffset: false,
    chipFill: NAVY,
    chipInk: CREAM,
    figure: NAVY,
  },
};

/**
 * Opacidades sobre el color de tinta.
 *
 * Más altas que las que daba la guía original (0.72 / 0.22 / 0.68): aquellas se eligieron
 * contra un bloque de color liso, y sobre una fotografía —aunque esté desenfocada— un texto al
 * 68 % se deshace. La jerarquía se mantiene, solo que comprimida hacia arriba.
 */
const UNIT_ALPHA = 0.9;
const RULE_ALPHA = 0.45;
const ACCOUNT_ALPHA = 0.88;

/**
 * Cuánto se desenfoca la copia de la fotografía sobre la que va el texto.
 *
 * Es una de las tres cosas que hacen legible el titular ahora que no hay ningún bloque de color
 * debajo (las otras dos son el peso de la letra y la sombra), y en principio la más eficaz: lo
 * que estorba a la lectura no es el brillo del fondo sino su **detalle**.
 *
 * Aun así el valor por defecto es **bajo, por decisión del usuario**: a 0.20 la fotografía se
 * sigue reconociendo bajo el texto, que es el efecto que se busca. La contrapartida está
 * anotada como límite conocido — sobre una foto muy recargada el titular pierde contraste y hay
 * que subir el deslizador en ese post.
 */
const DEFAULT_BLUR = 0.2;
// El suelo va por debajo del valor por defecto para que se pueda bajar más, no solo subir.
export const BLUR_MIN = 0.05;
export const BLUR_MAX = 0.8;

/**
 * Altura de la transición entre la foto nítida y la desenfocada, como fracción de la página.
 *
 * Es lo que hace que no se vea ningún corte: en vez de un borde donde acaba una y empieza la
 * otra, la copia desenfocada aparece con un degradado de alfa a lo largo de ~135 px (en una
 * página de 1350), de modo que el desenfoque *crece* en vez de encenderse.
 */
const FADE_RATIO = 0.1;

/** Cuánto se desborda la máscara del desenfoque más allá de la página, por lado. */
const MASK_BLEED = 8;

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
/** El titular. Desde §9.30 va sobre la foto sin ningún bloque detrás, y el peso es lo primero
 *  que lo despega de ella: a 500 se deshacía sobre cualquier fondo con textura. */
const SEMIBOLD = "600";

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

/**
 * La sombra (o el halo) que separa la letra de la fotografía.
 *
 * Proporcional al cuerpo, para que valga igual en el titular y en el pie. Con tinta clara es
 * una sombra oscura ligeramente desplazada; con tinta oscura, un halo claro **sin desplazar**
 * y más difuminado — un halo desplazado se lee como una sombra mal hecha, no como un contorno.
 *
 * `affectStroke` no hace falta aquí porque este texto nunca lleva contorno: la sombra es
 * suficiente y un contorno grueso sobre una condensada estrecha embarra las letras.
 */
function inkShadow(fontSize: number, variant: NewsVariant): fabric.Shadow {
  const p = PALETTES[variant];
  return new fabric.Shadow({
    color: p.shadow,
    blur: Math.round(fontSize * (p.shadowOffset ? 0.3 : 0.36)),
    offsetX: 0,
    offsetY: p.shadowOffset ? Math.round(fontSize * 0.055) : 0,
  });
}

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
    /** `false` para el texto que ya va sobre un fondo opaco propio (el chip). */
    shadow?: false;
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
    // Sin contorno y sin degradado, como pedía la guía; la sombra, en cambio, dejó de ser
    // opcional en §9.30: es lo que separa la letra de la foto ahora que no hay bloque de
    // color. El chip es la excepción — va sobre su propia píldora opaca.
    shadow: opts.shadow === false ? null : inkShadow(opts.fontSize, variant),
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

function buildBlocks(copy: NewsCopy, pageWidth: number, variant: NewsVariant): Built {
  const s = pageWidth / REF_WIDTH;
  const p = PALETTES[variant];
  const usable = pageWidth - 2 * D.padSide * s;

  const built: Built = {
    // Sin relleno: desde §9.30 la "franja" no pinta nada, es solo el ancla de la
    // maquetación y la señal por la que `logo.ts` coloca la marca arriba a la izquierda.
    band: makeRect("band", variant, "rgba(0,0,0,0)"),
    headline: makeText(copy.titular, "headline", variant, {
      fontSize: D.headlineMax * s,
      fontWeight: SEMIBOLD,
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
      // Va sobre su propia píldora opaca: una sombra ahí solo ensuciaría el borde.
      shadow: false,
    });
  }

  if (copy.dato) {
    built.figure = makeText(copy.dato, "figure", variant, {
      fontSize: D.figureSize * s,
      fontWeight: SEMIBOLD,
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
  fitPhotoToPage(canvas, pageWidth, pageHeight);
  lockPhoto(canvas);
  // Y su copia desenfocada. Va aquí, dentro de `layout`, para que las cinco rutas que mueven
  // el borde del desenfoque o cambian la foto la actualicen sin tener que acordarse de ella
  // (ver el comentario de `syncGlass`).
  syncGlass(canvas, pageWidth, pageHeight, bandTop, readBlur(canvas));


  // La "franja" ya no pinta nada: desde §9.30 es solo el ancla de la maquetación (y la señal
  // por la que `logo.ts` sabe que tiene que colocar la marca arriba a la izquierda). Se fuerza
  // transparente en cada pasada, que es lo que migra sola a los borradores guardados cuando la
  // franja sí era un bloque de color.
  built.band.set({ fill: "rgba(0,0,0,0)" });
  built.band.dirty = true;

  // Orden interno de la plantilla: el cristal va sobre la foto y el texto encima, en el orden
  // del diseño.
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

  // Las sombras son proporcionales al cuerpo de letra, y el cuerpo lo acaba de decidir
  // `fitHeadline` (y lo reinicia `relayoutNewsTemplate` en cada cambio de formato), así que se
  // rehacen aquí, en el único punto por el que pasan todas las rutas.
  refreshShadows(built);

  bringLogoToFront(canvas);
  return { bandTop };
}

/** Rehace la sombra de cada texto contra su cuerpo y su variante actuales. */
function refreshShadows(built: Built): void {
  for (const box of [built.figure, built.unit, built.headline, built.account]) {
    if (!box) continue;
    const variant = ((box as any)._nwVariant as NewsVariant) ?? "navy";
    box.set({ shadow: inkShadow(box.fontSize ?? 48, variant) });
    box.dirty = true;
  }
}

/**
 * Encaja la foto en la **página entera**: cover sobre `pageWidth × pageHeight`, centrada en
 * horizontal y anclada al tercio alto en vertical (ver PHOTO_ANCHOR).
 *
 * Hasta §9.30 se encajaba solo contra la banda superior, porque debajo iba un bloque opaco y
 * lo que quedara tapado daba igual. Ahora la mitad de abajo **es la misma foto**, así que
 * tiene que llegar hasta el borde inferior o no habría nada que desenfocar.
 *
 * No se reutiliza `fitBackgroundImage` de `use-canvas.ts` porque esa centra el recorte
 * vertical, y aquí interesa descartarlo casi todo por abajo: es lo que salva las cabezas en
 * una foto de prensa.
 */
/**
 * Deja la fotografía fuera del alcance del ratón mientras la plantilla está puesta.
 *
 * No es una comodidad, es lo que impedía usar la plantilla: **todo lo que ésta genera es
 * `evented: false`** —la franja, el chip, la línea, el cristal— y los textos solo ocupan el
 * tercio bajo, así que cualquier clic sobre la mitad superior seleccionaba la foto. Desde ahí,
 * un `Delete` la borraba (y con ella el cristal, que `syncGlass` retira cuando no hay foto) y
 * un arrastre la descolocaba respecto de su propia copia desenfocada.
 *
 * Y no se pierde nada: con la plantilla puesta el encuadre lo decide `fitPhotoToPage`, que
 * corre en **cada** `layout()` —cambio de formato, de cifra, de desenfoque—, así que un
 * reencuadre a mano ya se estaba descartando en silencio. Cover/Contain, el deslizador de
 * escala y "Mejorar foto" siguen funcionando: van por `findBackgroundImage`, no por la
 * selección. `revertNewsTemplate` la devuelve a interactiva.
 */
function lockPhoto(canvas: fabric.Canvas): void {
  const img = findBackgroundImage(canvas);
  if (!img) return;
  img.set({ selectable: false, evented: false, hasControls: false, hoverCursor: "default" });
}

/**
 * Re-aplica lo que Fabric **no serializa**: `selectable`, `evented`, `hasControls` y
 * `hoverCursor`.
 *
 * Ninguna de esas cuatro entra en `toObject()`, así que **todo lo que la plantilla marca como
 * chrome vuelve de `loadFromJSON` siendo clicable y arrastrable**, con los valores por defecto
 * de Fabric. Y el objeto que más daño hace es el cristal, que cubre la fotografía entera: al
 * reabrir un borrador, un clic en cualquier punto de la imagen lo seleccionaba a él, de modo
 * que se podía arrastrar (dejando la mitad nítida y la difuminada descuadradas) o borrar de un
 * `Delete` — y con la foto pasaba lo mismo.
 *
 * Es el mismo patrón que `applyWorkspaceClip` (§9.16) y `normalizeBackgroundSource` (§9.18):
 * `loadFromJSON` devuelve el lienzo a su estado *serializado*, no al estado en memoria, así que
 * hay que rehacer a mano lo que no viaja en el JSON. Y por el mismo motivo se llama desde las
 * **tres** rutas que reconstruyen el lienzo: abrir la página, deshacer/rehacer y aplicar una
 * plantilla.
 */
export function normalizeNewsTemplate(canvas: fabric.Canvas): boolean {
  if (!hasNewsTemplate(canvas)) return false;
  for (const obj of canvas.getObjects()) {
    const role = nwRole(obj);
    if (role === null) continue;
    // Los textos sí se editan a mano —es media gracia de la plantilla—; el resto es chrome y
    // el clic tiene que atravesarlo.
    if (TEXT_ROLES.has(role)) {
      obj.set({ selectable: true, evented: true });
    } else {
      obj.set({ selectable: false, evented: false, hasControls: false, hoverCursor: "default" });
    }
  }
  lockPhoto(canvas);
  canvas.requestRenderAll();
  return true;
}

/** Los bloques que el operador puede seleccionar y editar. El resto es chrome. */
const TEXT_ROLES = new Set<NwRole>(["chip", "figure", "unit", "headline", "account"]);

/**
 * Re-sincroniza la geometría del cristal con la de la foto, sin volver a filtrar nada.
 *
 * Red de seguridad para el caso de que la foto acabe movida por cualquier vía que no pase por
 * `layout()`: sin esto, la mitad nítida y la difuminada dejan de encajar.
 */
export function resyncGlassGeometry(canvas: fabric.Canvas): boolean {
  const photo = findBackgroundImage(canvas);
  const glass = findByRole(canvas, "glass") as fabric.FabricImage | undefined;
  if (!photo || !glass) return false;
  glass.set({
    scaleX: photo.scaleX ?? 1,
    scaleY: photo.scaleY ?? 1,
    left: photo.left ?? 0,
    top: photo.top ?? 0,
  });
  glass.setCoords();
  canvas.requestRenderAll();
  return true;
}

export function fitPhotoToPage(canvas: fabric.Canvas, pageWidth: number, pageHeight: number): void {
  const img = findBackgroundImage(canvas);
  if (!img) return;
  const natW = img.width || 1;
  const natH = img.height || 1;
  const scale = Math.max(pageWidth / natW, pageHeight / natH);
  img.set({
    scaleX: scale,
    scaleY: scale,
    left: (pageWidth - natW * scale) / 2,
    top: -(natH * scale - pageHeight) * PHOTO_ANCHOR,
  });
  img.setCoords();
  canvas.sendObjectToBack(img);
}

// ── Cristal: la misma foto, desenfocada, sin costura ────────────

/** El `src` con el que se construyó una imagen, sea cual sea el camino por el que llegó. */
function sourceUrl(img: fabric.FabricImage): string {
  return ((img as any)._srcUrl as string) || img.getSrc() || "";
}

/**
 * La máscara que hace que no se vea ningún corte.
 *
 * Es una **imagen** y no un rectángulo, y ahí está todo el asunto: Fabric dibuja un `clipPath`
 * con `drawObject(ctx, forClipping = true)`, que **fuerza el relleno a negro opaco**
 * (`_setClippingProperties`), así que un degradado en el `fill` de un `Rect` se pierde y la
 * máscara sale opaca de borde a borde. Una `FabricImage`, en cambio, se pinta con `drawImage`
 * y conserva el alfa de sus propios píxeles — y como el recorte se aplica con
 * `globalCompositeOperation = destination-in`, ese alfa se traduce en transparencia real.
 *
 * De modo que la copia desenfocada no *empieza* en una línea: va apareciendo a lo largo del
 * degradado, mezclándose con la foto nítida que tiene justo debajo. Como las dos son la misma
 * imagen en la misma posición, la mezcla no duplica nada: lo único que cambia es la nitidez.
 */
function fadeMask(
  pageWidth: number,
  fadeTop: number,
  fadeHeight: number,
  pageHeight: number
): fabric.FabricImage | null {
  // La rampa solo varía en vertical, así que el ancho no aporta resolución… pero **no puede ser
  // de 1 px**: al escalar un origen de un solo texel hasta el ancho de la página, la
  // interpolación deja los bordes a medio alfa y el desenfoque no llegaba al borde derecho.
  // Con 8 px de ancho los texels interpolados quedan lejos del área que importa.
  const RAMP = 512;
  const COLS = 8;
  const el = document.createElement("canvas");
  el.width = COLS;
  el.height = RAMP;
  const ctx = el.getContext("2d");
  if (!ctx) return null;
  const total = pageHeight - fadeTop;
  if (total <= 0) return null;
  // Dónde acaba la rampa dentro de la máscara, en fracción de su altura.
  const stop = Math.min(1, fadeHeight / total);
  const grad = ctx.createLinearGradient(0, 0, 0, RAMP);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(stop, "rgba(0,0,0,1)");
  grad.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, COLS, RAMP);

  // Y además se desborda por los lados y por abajo. Es gratis —el recorte del área de trabajo
  // (§9.13) ya corta a la página, y el cristal no puede pintar más allá de la propia foto— y
  // cubre de una vez los dos motivos por los que el borde se quedaba corto: la interpolación
  // del bitmap y el error de precisión de invertir la matriz del cristal, que va escalado y
  // desplazado (`absolutePositioned`).
  const mask = new fabric.FabricImage(el, { left: -MASK_BLEED, top: fadeTop });
  mask.set({
    scaleX: (pageWidth + 2 * MASK_BLEED) / COLS,
    scaleY: (total + MASK_BLEED) / RAMP,
  });
  mask.absolutePositioned = true;
  return mask;
}

/**
 * Crea, actualiza o quita la copia desenfocada de la foto.
 *
 * Se construye **de forma síncrona** desde el mismo elemento de la foto, en vez de con
 * `clone()` (que es lo que hace el cartel de los eventos): así cabe dentro de `layout()`, que
 * es síncrona y es el único punto por el que pasan las cinco rutas que pueden mover el borde
 * del desenfoque o cambiar la foto. Un `clone()` obligaría a repetir el refresco en cada una
 * de ellas, que es exactamente el error que §9.18 costó cuatro sitios encontrar.
 *
 * Geometría: **exactamente la misma que la foto** —misma escala, mismo `left`, mismo `top`—,
 * porque cualquier diferencia se vería como una segunda imagen asomando por debajo. Lo único
 * que la separa de la original es el filtro y la máscara.
 */
function syncGlass(
  canvas: fabric.Canvas,
  pageWidth: number,
  pageHeight: number,
  bandTop: number,
  blur: number
): void {
  const photo = findBackgroundImage(canvas);
  const existing = findByRole(canvas, "glass") as fabric.FabricImage | undefined;

  if (!photo) {
    // Sin foto no hay nada que desenfocar; dejar el cristal sería congelar la última imagen
    // que hubo, ya sin la original debajo.
    if (existing) canvas.remove(existing);
    return;
  }

  const src = sourceUrl(photo);
  let glass = existing;

  // Re-filtrar un bitmap de 4096 px es lo caro de todo esto, y mover el borde del desenfoque
  // no lo necesita: solo se reconstruye si ha cambiado la foto o la intensidad del filtro.
  const currentBlur = (glass?.filters?.[0] as fabric.filters.Blur | undefined)?.blur;
  if (!glass || sourceUrl(glass) !== src || currentBlur !== blur) {
    // `_originalElement` y no `getElement()`: este último devuelve el bitmap ya filtrado en
    // cuanto la imagen lleva efectos, y desenfocar eso encadenaría filtros sobre filtros.
    const el = (photo as any)._originalElement as HTMLImageElement | HTMLCanvasElement | undefined;
    if (!el) return;
    if (glass) canvas.remove(glass);
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
    glass.filters = [new fabric.filters.Blur({ blur })];
    glass.applyFilters();
    canvas.add(glass);
  }

  mark(glass, "glass", currentVariant(canvas));

  glass.set({
    scaleX: photo.scaleX ?? 1,
    scaleY: photo.scaleY ?? 1,
    left: photo.left ?? 0,
    top: photo.top ?? 0,
  });
  // La máscara se rehace siempre: el borde del desenfoque se mueve con el titular y con el
  // formato. Arranca por encima de `bandTop` para que el desenfoque ya esté al 100 % cuando
  // empieza el texto, que va 64 px más abajo.
  const fade = Math.round(pageHeight * FADE_RATIO);
  glass.clipPath = fadeMask(pageWidth, Math.max(0, bandTop - fade), fade, pageHeight) ?? undefined;
  glass.setCoords();
}

/** La intensidad de desenfoque vigente, leída del propio filtro del cristal. */
export function readBlur(canvas: fabric.Canvas): number {
  const glass = findByRole(canvas, "glass") as fabric.FabricImage | undefined;
  const blur = (glass?.filters?.[0] as fabric.filters.Blur | undefined)?.blur;
  return typeof blur === "number" ? blur : DEFAULT_BLUR;
}

/**
 * Elige la tinta midiendo la fotografía en la zona donde va a ir el texto.
 *
 * Sin bloque de color detrás, el acierto o el fallo de la legibilidad se decide aquí: sobre
 * una foto oscura hace falta tinta clara, y sobre una clara, oscura. Se mide el **original sin
 * filtrar** y no el cristal, porque el desenfoque no cambia la luminancia media y el original
 * está disponible siempre; y se mide a resolución mínima (un `drawImage` a 24×12) porque lo
 * que interesa es la media, no el detalle.
 *
 * Leer píxeles exige que el lienzo no esté *tainted*: se cumple porque la foto llega por el
 * proxy `/api/twenty/:type/:id/image`, que existe precisamente para esto (§9.3).
 */
function chooseInk(photo: fabric.FabricImage, pageHeight: number, bandTop: number): NewsVariant {
  const el = (photo as any)._originalElement as HTMLImageElement | HTMLCanvasElement | undefined;
  if (!el) return "navy";
  const scale = photo.scaleY ?? 1;
  const top = photo.top ?? 0;
  // La franja del bitmap que cae bajo la zona de texto.
  const srcTop = Math.max(0, (bandTop - top) / scale);
  const srcBottom = Math.min(photo.height || 1, (pageHeight - top) / scale);
  if (srcBottom <= srcTop) return "navy";

  try {
    const probe = document.createElement("canvas");
    probe.width = 24;
    probe.height = 12;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) return "navy";
    ctx.drawImage(el, 0, srcTop, photo.width || 1, srcBottom - srcTop, 0, 0, 24, 12);
    const d = ctx.getImageData(0, 0, 24, 12).data;
    let lum = 0;
    for (let i = 0; i < d.length; i += 4) {
      lum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    }
    lum /= d.length / 4;
    // El umbral está alto a propósito: las dos tintas no son simétricas. La crema con sombra
    // oscura aguanta un fondo medio mucho mejor que el azul noche con halo claro, así que solo
    // se pasa a tinta oscura cuando la foto es de verdad luminosa.
    return lum > 165 ? "cream" : "navy";
  } catch {
    // Un lienzo *tainted* (una foto que no venga del proxy) lanza aquí. La tinta clara es la
    // opción que menos se equivoca a ciegas.
    return "navy";
  }
}

// ── Composición ─────────────────────────────────────────────────────

export interface ComposeNewsOptions {
  pageWidth: number;
  pageHeight: number;
  /** Si no se da, la elige `chooseInk` midiendo la propia fotografía. */
  variant?: NewsVariant;
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
  // Rehacer la plantilla conserva el desenfoque que el operador hubiera elegido: es un ajuste
  // suyo sobre el diseño, no un dato del registro que haya que volver a leer de Twenty.
  const blur = readBlur(canvas);
  // La tinta se decide contra la foto, y hay que hacerlo **antes** de construir los bloques
  // porque de ella dependen todos sus colores. `bandTop` todavía no existe —lo calcula
  // `layout`—, así que se usa su posición nominal: la medida es una media de la mitad baja de
  // la fotografía y no cambia porque el borde real acabe unas decenas de píxeles más arriba.
  const photo = findBackgroundImage(canvas);
  const variant =
    opts.variant ??
    (photo ? chooseInk(photo, pageHeight, Math.round(pageHeight * D.bandTopRatio)) : "navy");
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

  // El color del lienzo se fija **en los dos sentidos**, y eso es lo que importa: antes solo se
  // pintaba de azul cuando faltaba la foto y nunca se deshacía, así que una sola composición sin
  // imagen dejaba el azul grabado en el `canvas_json` para siempre — el "sólido azul oscuro" que
  // no había forma de quitar. Ahora, en cuanto vuelve a haber foto, el lienzo vuelve a blanco y
  // los diseños ya afectados se curan solos.
  canvas.backgroundColor = findBackgroundImage(canvas) ? "#ffffff" : NAVY;

  const built = buildBlocks(copy, pageWidth, variant);
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
  // Y la sombra cambia de sentido con la tinta: oscura y desplazada bajo la crema, halo claro
  // y centrado bajo el azul noche. Va después del bucle, que es quien pone `_nwVariant`.
  refreshShadows(built);
  canvas.requestRenderAll();
  return true;
}

/**
 * Cambia la intensidad del desenfoque del fondo.
 *
 * No re-maqueta: la geometría no depende del filtro. Sí reconstruye el cristal, porque
 * cambiar el desenfoque obliga a volver a filtrar el bitmap.
 */
export function setNewsBlur(
  canvas: fabric.Canvas,
  blur: number,
  pageWidth: number,
  pageHeight: number
): boolean {
  const built = collect(canvas);
  if (!built) return false;
  syncGlass(canvas, pageWidth, pageHeight, built.band.top ?? 0, blur);
  // `syncGlass` añade el cristal al final de la pila; devolverlo justo encima de la foto.
  const glass = findByRole(canvas, "glass");
  const photo = findBackgroundImage(canvas);
  if (glass) canvas.moveObjectTo(glass, photo ? 1 : 0);
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
        fontWeight: SEMIBOLD,
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
