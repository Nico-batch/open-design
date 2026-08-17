import * as fabric from "fabric";
import type { EventCopy } from "./event-fields";
import { applyBackgroundEffects, applyScrim, NO_EFFECTS, type ScrimTone } from "./effects";
import { findBackgroundImage, downscaleOversizedSource } from "./background";
import { bringLogoToFront } from "./logo";
import { syncCanvasFonts } from "./fonts";

/**
 * La estructura fija de un post de agenda, rellenada con los campos que tenga el evento.
 *
 * La idea de fondo: **nada tiene una posición absoluta**. Los bloques se declaran en orden
 * y se apilan midiendo lo que ocupan de verdad; el que no tiene dato no se crea, y su hueco
 * no existe. Por eso un evento sin dirección o sin subtítulo no deja un agujero en el
 * diseño, que es justo lo que obliga a retocar a mano.
 *
 * `event-fields.ts` decide *qué se dice*; este fichero solo decide *dónde se pone*.
 */

// Fabric descarta al serializar cualquier propiedad que no esté registrada (§9.12 de
// CLAUDE.md), y el registro tiene una trampa que costó un bug encontrar.
//
// `toObject()` serializa
// `propertiesToInclude.concat(FabricObject.customProperties, this.constructor.customProperties)`.
// Podría parecer que basta con añadir la marca a la clase base, pero **no**: `Textbox` no
// declara `customProperties` propia y por tanto la hereda —y ahí sí aparece la marca—,
// mientras que `Rect` y `FabricImage` sí la declaran (`effects.ts` y `background.ts`
// escriben las suyas) y esa propiedad propia **tapa** la heredada. Resultado observado en
// el `canvas_json` guardado: los textos conservaban su rol y la píldora y el cartel lo
// perdían, así que al recargar "Rehacer plantilla" ya no sabía que existían y cada pasada
// dejaba un cartel más encima del anterior.
//
// Por eso se añade clase por clase, y **conservando** lo que cada una ya tuviera. Este
// módulo importa `effects.ts` y `background.ts` arriba, así que sus asignaciones ya han
// ocurrido cuando corre esto: aquí solo se añade, nunca se pisa.
for (const klass of [fabric.Textbox, fabric.Rect, fabric.FabricImage] as unknown as Array<{
  customProperties?: string[];
}>) {
  klass.customProperties = [...(klass.customProperties ?? []), "_tplRole", "_tplTheme"];
}

export type TplRole =
  | "poster"
  | "category"
  | "title"
  | "subtitle"
  | "date"
  | "place"
  | "price"
  | "priceBg";

/** "poster" = el cartel se ve entero sobre un fondo desenfocado; "bleed" = imagen a sangre. */
export type EventLayoutMode = "poster" | "bleed";

/**
 * Cuándo se puede llevar la imagen a sangre en vez de enseñarla entera.
 *
 * El criterio NO es solo geométrico, y conviene explicar por qué es tan estrecho. Lo que
 * llega en la "Imagen" de un evento es casi siempre un cartel que **ya lleva impresos el
 * nombre, la fecha y el lugar**. Llevarlo a sangre hace dos daños a la vez: recorta el
 * cartel, y pone nuestro bloque de datos justo encima de los datos que el cartel ya daba.
 * Enseñarlo entero con la ficha debajo es la disposición habitual de un post de agenda y
 * no destruye nada.
 *
 * Como no hay forma fiable de distinguir un cartel de una fotografía, el umbral se inclina
 * al lado que no pierde información: solo va a sangre la imagen que encaja en la página
 * **sin recortar prácticamente nada** (±8 %), que es el único caso en el que a sangre es
 * claramente mejor. Para el resto está el botón "A sangre" del panel, a un clic.
 */
const ASPECT_TOLERANCE = 1.08;

export function chooseLayoutMode(
  img: fabric.FabricImage,
  pageWidth: number,
  pageHeight: number
): EventLayoutMode {
  const natural = (img.width || 1) / (img.height || 1);
  const page = pageWidth / pageHeight;
  const ratio = natural / page;
  return ratio < 1 / ASPECT_TOLERANCE || ratio > ASPECT_TOLERANCE ? "poster" : "bleed";
}

// ── Identificación ──────────────────────────────────────────────────

export function tplRole(obj: fabric.FabricObject | undefined | null): TplRole | null {
  return (obj as any)?._tplRole ?? null;
}

export function findByRole(canvas: fabric.Canvas, role: TplRole): fabric.FabricObject | undefined {
  return canvas.getObjects().find((o) => tplRole(o) === role);
}

export function hasEventTemplate(canvas: fabric.Canvas): boolean {
  return canvas.getObjects().some((o) => tplRole(o) !== null);
}

/** El modo se *deduce* de lo que hay en el lienzo en vez de guardarse aparte: un estado
 *  menos que pueda quedar desincronizado con lo que se ve. */
export function currentLayoutMode(canvas: fabric.Canvas): EventLayoutMode | null {
  if (!hasEventTemplate(canvas)) return null;
  return findByRole(canvas, "poster") ? "poster" : "bleed";
}

/**
 * Borra lo que generó la plantilla y nada más. El fondo, el velo, el logo y cualquier cosa
 * que el operador haya añadido a mano no llevan marca, así que sobreviven a un "Rehacer".
 */
export function clearEventTemplate(canvas: fabric.Canvas): void {
  for (const obj of canvas.getObjects()) {
    if (tplRole(obj) !== null) canvas.remove(obj);
  }
}

// ── Paleta y medidas ────────────────────────────────────────────────

/**
 * Los dos temas, con la paleta de El Faro de Alicante: azul noche `#0a2540`, ámbar
 * `#f4a825` y crema `#fbf7f0`.
 *
 * No son "el mismo diseño en otro color": lo que cambia es de qué lado está el contraste.
 * Con tinta clara sobre una foto oscura, lo que separa el texto del fondo es una sombra
 * **oscura**; con tinta oscura sobre una foto clara esa sombra desaparece y hace falta lo
 * contrario, un halo claro. Y el velo tiene que ir en el mismo sentido, o el tema oscuro
 * pintaría letras azul noche sobre una foto que acabamos de ennegrecer.
 *
 * El ámbar sobrevive en los dos, pero de forma distinta: como texto solo funciona sobre
 * fondo oscuro (sobre crema se queda en ~2.5:1), así que en el tema oscuro se retira del
 * rótulo de categoría y se queda donde sí rinde, la píldora — un bloque sólido con texto
 * azul noche encima, que es un contraste holgado.
 */
export type EventTheme = "light" | "dark";

const NAVY = "#0a2540";
const AMBER = "#f4a825";
const CREAM = "#fbf7f0";

interface Palette {
  /** Titular, fecha: la tinta principal. */
  ink: string;
  /** Subtítulo y lugar: la misma tinta, con menos peso. */
  inkMuted: string;
  /** Rótulo de categoría. */
  accent: string;
  pillFill: string;
  pillInk: string;
  /** Color de la sombra/halo que despega el texto de la foto. */
  shadow: string;
  /** Un halo no lleva desplazamiento; una sombra proyectada sí. */
  shadowOffset: boolean;
  scrimTone: ScrimTone;
}

const THEMES: Record<EventTheme, Palette> = {
  // Tinta clara para foto oscura.
  light: {
    ink: CREAM,
    inkMuted: "rgba(251,247,240,0.84)",
    accent: AMBER,
    pillFill: AMBER,
    pillInk: NAVY,
    shadow: "rgba(10,37,64,0.55)",
    shadowOffset: true,
    scrimTone: "dark",
  },
  // Tinta oscura para foto clara.
  dark: {
    ink: NAVY,
    inkMuted: "rgba(10,37,64,0.82)",
    accent: NAVY,
    pillFill: AMBER,
    pillInk: NAVY,
    // Halo crema en vez de sombra: sobre una foto clara, una sombra oscura ensucia el
    // texto en lugar de separarlo.
    shadow: "rgba(251,247,240,0.85)",
    shadowOffset: false,
    scrimTone: "light",
  },
};

/** El tema con el que se compuso, leído del lienzo. Como el modo, se deduce en vez de
 *  guardarse aparte — un estado menos que pueda desincronizarse de lo que se ve. */
export function currentTheme(canvas: fabric.Canvas): EventTheme {
  const marked = canvas.getObjects().find((o) => (o as any)._tplTheme);
  return ((marked as any)?._tplTheme as EventTheme) ?? "light";
}

/** Todo en proporciones de la página, nunca en píxeles — el mismo criterio que `enhance.ts`,
 *  para que la receta valga igual en 1080×1080, 1080×1350 y 1080×1920. */
const M = {
  margin: 0.074,
  blockWidth: 0.84,
  titleOfPage: { bleed: 1 / 11, poster: 1 / 14 },
  subtitleOfPage: 1 / 30,
  dateOfPage: 1 / 26,
  placeOfPage: 1 / 32,
  categoryOfPage: 1 / 34,
  // Más pequeño que el lugar a propósito: es una etiqueta, no una línea de texto.
  priceOfPage: 1 / 40,
};

/** Hasta dónde puede encoger el titular antes de que se prefiera descartar otro bloque. */
const TITLE_MIN_SCALE = 0.62;
const TITLE_MAX_LINES = { bleed: 4, poster: 3 };
const SUBTITLE_MAX_LINES = 2;

// ── Bloques ─────────────────────────────────────────────────────────

interface Block {
  role: TplRole;
  obj: fabric.FabricObject;
  /** Separación por encima, en múltiplos del cuerpo de letra del propio bloque. */
  gapBefore: number;
  /** Se descarta antes cuanto mayor sea, si no cabe todo. 0 = nunca se descarta. */
  dropPriority: number;
  /** Rectángulo que acompaña al bloque (la píldora), recolocado con él. */
  backdrop?: fabric.Rect;
}

function makeText(
  text: string,
  role: TplRole,
  opts: {
    fontSize: number;
    fontFamily: string;
    fontWeight: string;
    fill: string;
    width: number;
    charSpacing?: number;
    lineHeight?: number;
    shadow?: fabric.Shadow | null;
  }
): fabric.Textbox {
  const box = new fabric.Textbox(text, {
    width: opts.width,
    fontSize: opts.fontSize,
    fontFamily: opts.fontFamily,
    fontWeight: opts.fontWeight,
    fill: opts.fill,
    textAlign: "center",
    charSpacing: opts.charSpacing ?? 0,
    lineHeight: opts.lineHeight ?? 1.15,
    shadow: opts.shadow ?? null,
    editable: true,
  });
  (box as any)._tplRole = role;
  return box;
}

/** Separación y orden de sacrificio de cada bloque, en una tabla y no repartidos por el
 *  constructor, porque el re-apilado tras un cambio de tamaño los necesita otra vez. */
const BLOCK_META: Record<string, { gapBefore: number; dropPriority: number }> = {
  category: { gapBefore: 0, dropPriority: 1 },
  title: { gapBefore: 0.45, dropPriority: 0 },
  subtitle: { gapBefore: 0.55, dropPriority: 3 },
  date: { gapBefore: 0.8, dropPriority: 0 },
  place: { gapBefore: 0.35, dropPriority: 2 },
  price: { gapBefore: 0.9, dropPriority: 2 },
};

/** Orden vertical del bloque de datos, idéntico en los dos modos. */
const BLOCK_ORDER: TplRole[] = ["category", "title", "subtitle", "date", "place", "price"];

/**
 * Lo que separa el texto de la foto sin recurrir a un contorno grueso — el mismo criterio
 * que el titular de noticias (`enhance.ts`), pero en el sentido que pida el tema: sombra
 * proyectada bajo la tinta clara, halo sin desplazamiento bajo la tinta oscura.
 */
function textShadow(fontSize: number, theme: EventTheme, strength = 1): fabric.Shadow {
  const p = THEMES[theme];
  const offset = p.shadowOffset ? Math.round(fontSize * 0.05) : 0;
  return new fabric.Shadow({
    color: strength === 1 ? p.shadow : fadeColor(p.shadow, strength),
    // El halo necesita más difuminado que la sombra para leerse como tal y no como un borde.
    blur: Math.round(fontSize * (p.shadowOffset ? 0.16 : 0.24)),
    offsetX: p.shadowOffset ? Math.round(fontSize * 0.04) : 0,
    offsetY: offset,
    affectStroke: true,
  });
}

/** Baja el alfa de un `rgba(...)` de la paleta sin tener que declarar cada variante. */
function fadeColor(rgba: string, factor: number): string {
  return rgba.replace(/([\d.]+)\s*\)$/, (_, a) => `${(parseFloat(a) * factor).toFixed(3)})`);
}

function buildBlocks(
  copy: EventCopy,
  pageWidth: number,
  mode: EventLayoutMode,
  theme: EventTheme
): Block[] {
  const width = Math.round(pageWidth * M.blockWidth);
  const p = THEMES[theme];
  const blocks: Block[] = [];
  const push = (role: TplRole, obj: fabric.FabricObject, backdrop?: fabric.Rect) => {
    (obj as any)._tplTheme = theme;
    if (backdrop) (backdrop as any)._tplTheme = theme;
    blocks.push({ role, obj, backdrop, ...BLOCK_META[role] });
  };

  if (copy.categoria) {
    const fontSize = Math.round(pageWidth * M.categoryOfPage);
    push(
      "category",
      makeText(copy.categoria.toUpperCase(), "category", {
        fontSize,
        fontFamily: "Montserrat",
        fontWeight: "700",
        fill: p.accent,
        width,
        // Muy abierto: una sola palabra corta en mayúsculas necesita el tracking para
        // leerse como un rótulo y no como una palabra suelta perdida sobre la foto.
        charSpacing: 160,
        shadow: textShadow(fontSize, theme),
      })
    );
  }

  {
    const fontSize = Math.round(pageWidth * M.titleOfPage[mode]);
    push(
      "title",
      makeText(copy.titulo.toUpperCase(), "title", {
        fontSize,
        fontFamily: "Montserrat",
        // 800 viene en public/fonts/Montserrat: es la ExtraBold de verdad, no una negrita
        // sintética — el mismo peso que usa "Mejorar titular".
        fontWeight: "800",
        fill: p.ink,
        width,
        charSpacing: -20,
        lineHeight: 1.02,
        shadow: textShadow(fontSize, theme),
      })
    );
  }

  if (copy.subtitulo) {
    const fontSize = Math.round(pageWidth * M.subtitleOfPage);
    push(
      "subtitle",
      makeText(copy.subtitulo, "subtitle", {
        fontSize,
        fontFamily: "Inter",
        fontWeight: "400",
        fill: p.inkMuted,
        width,
        lineHeight: 1.25,
        shadow: textShadow(fontSize, theme, 0.8),
      })
    );
  }

  if (copy.fecha) {
    const fontSize = Math.round(pageWidth * M.dateOfPage);
    push(
      "date",
      makeText(copy.fecha, "date", {
        fontSize,
        fontFamily: "Montserrat",
        fontWeight: "700",
        fill: p.ink,
        width,
        charSpacing: 20,
        shadow: textShadow(fontSize, theme),
      })
    );
  }

  if (copy.lugar) {
    const fontSize = Math.round(pageWidth * M.placeOfPage);
    push(
      "place",
      makeText(copy.lugar, "place", {
        fontSize,
        fontFamily: "Inter",
        fontWeight: "500",
        fill: p.inkMuted,
        width,
        shadow: textShadow(fontSize, theme, 0.8),
      })
    );
  }

  if (copy.precio) {
    const fontSize = Math.round(pageWidth * M.priceOfPage);
    const text = makeText(copy.precio, "price", {
      fontSize,
      fontFamily: "Montserrat",
      fontWeight: "800",
      fill: p.pillInk,
      width,
      charSpacing: 100,
    });
    // Rect + Textbox como hermanos y no un `Group`: un grupo fija el sistema de
    // coordenadas de sus hijos al crearse, así que no se re-maqueta cuando el texto cambia
    // de medidas al llegar la fuente real (§9.13 bug B) — y además obligaría a desagrupar
    // para editar el texto. El rectángulo no recibe eventos, igual que el velo, para que
    // el clic llegue al texto que hay encima.
    const backdrop = new fabric.Rect({
      fill: p.pillFill,
      selectable: false,
      evented: false,
      hoverCursor: "default",
    });
    (backdrop as any)._tplRole = "priceBg";
    push("price", text, backdrop);
  }

  return blocks;
}

// ── Apilado ─────────────────────────────────────────────────────────

function measure(obj: fabric.FabricObject): number {
  if (obj instanceof fabric.Textbox) obj.initDimensions();
  return (obj.height ?? 0) * (obj.scaleY ?? 1);
}

/**
 * Reduce el cuerpo de un texto hasta que quepa en `maxLines` y ninguna línea se salga de la
 * caja. Lo segundo no lo arregla el ajuste de línea: `Textbox` no parte palabras, así que
 * un nombre con una palabra larguísima o un hashtag desborda por mucho que sobre altura.
 */
function fitToLines(box: fabric.Textbox, maxLines: number, minScale: number): void {
  const original = box.fontSize ?? 1;
  const floor = original * minScale;
  for (let i = 0; i < 12; i++) {
    box.initDimensions();
    const tooManyLines = box.textLines.length > maxLines;
    const overflows = box.textLines.some((_, li) => box.getLineWidth(li) > (box.width ?? 0) + 1);
    if (!tooManyLines && !overflows) return;
    const next = Math.round((box.fontSize ?? 1) * 0.94);
    if (next < floor) break;
    box.set({ fontSize: next });
  }
  box.initDimensions();
}

interface StackResult {
  /** Y de la parte superior del bloque de datos, ya colocado. */
  top: number;
  height: number;
}

/**
 * Coloca los bloques anclados **por abajo**: crecen hacia arriba desde el margen inferior.
 * Es lo que mantiene la composición estable cuando el titular pasa de dos líneas a cuatro
 * — lo contrario (anclar arriba) desplazaría la fecha y el lugar fuera de la página.
 */
function stackBlocks(
  blocks: Block[],
  canvas: fabric.Canvas,
  pageWidth: number,
  pageHeight: number,
  mode: EventLayoutMode
): StackResult {
  const margin = Math.round(pageWidth * M.margin);
  const anchorBottom = pageHeight - margin;
  const maxHeight = pageHeight * (mode === "poster" ? 0.42 : 0.62);

  const title = blocks.find((b) => b.role === "title")?.obj as fabric.Textbox | undefined;
  if (title) fitToLines(title, TITLE_MAX_LINES[mode], TITLE_MIN_SCALE);

  // Media frase cortada es peor que ninguna: si la entradilla no cabe en dos líneas, se va
  // entera en vez de dejar un párrafo suelto compitiendo con el titular.
  const subtitle = blocks.find((b) => b.role === "subtitle");
  if (subtitle) {
    const box = subtitle.obj as fabric.Textbox;
    box.initDimensions();
    if (box.textLines.length > SUBTITLE_MAX_LINES) subtitle.dropPriority = 99;
  }

  let visible = blocks.filter((b) => b.dropPriority !== 99);

  const totalOf = (list: Block[]) =>
    list.reduce((sum, b, i) => {
      const gap = i === 0 ? 0 : b.gapBefore * (((b.obj as fabric.Textbox).fontSize ?? 0) || 0);
      return sum + gap + measure(b.obj);
    }, 0);

  // Si aún no cabe, se sacrifican bloques por prioridad descendente. `title` y `date` van
  // con prioridad 0: sin ellos el post no dice qué es ni cuándo, que es lo único que de
  // verdad no puede faltar.
  let total = totalOf(visible);
  while (total > maxHeight) {
    const worst = visible.reduce((a, b) => (b.dropPriority > a.dropPriority ? b : a), visible[0]);
    if (!worst || worst.dropPriority === 0) break;
    visible = visible.filter((b) => b !== worst);
    total = totalOf(visible);
  }

  // Los descartados salen del lienzo, no se dejan escondidos debajo.
  for (const b of blocks) {
    if (!visible.includes(b)) {
      canvas.remove(b.obj);
      if (b.backdrop) canvas.remove(b.backdrop);
    }
  }

  let y = anchorBottom - total;
  const top = y;

  visible.forEach((b, i) => {
    if (i > 0) y += b.gapBefore * (((b.obj as fabric.Textbox).fontSize ?? 0) || 0);
    const h = measure(b.obj);
    const w = (b.obj.width ?? 0) * (b.obj.scaleX ?? 1);
    b.obj.set({ left: (pageWidth - w) / 2, top: y });
    b.obj.setCoords();

    if (b.backdrop) {
      // La píldora se dimensiona sobre el ancho de la línea real, no sobre el de la caja
      // (que es el del bloque entero y dejaría un rectángulo de lado a lado).
      const textWidth = (b.obj as fabric.Textbox).getLineWidth(0);
      const padX = h * 0.62;
      const padY = h * 0.3;
      const pillW = textWidth + padX * 2;
      const pillH = h + padY * 2;
      b.backdrop.set({
        left: (pageWidth - pillW) / 2,
        top: y - padY,
        width: pillW,
        height: pillH,
        rx: pillH / 2,
        ry: pillH / 2,
        scaleX: 1,
        scaleY: 1,
      });
      b.backdrop.setCoords();
      // Justo debajo de su texto, sin depender de en qué posición estuviera cada uno.
      // Calcularlo con `indexOf` fallaba al re-apilar: tras un `loadFromJSON` el par ya
      // venía colocado, y mover el rectángulo a la posición del texto lo dejaba *encima*,
      // tapando la palabra. Subir los dos al frente en orden es exacto en ambos casos —
      // los bloques no se solapan entre sí, así que estar arriba no molesta a nadie, y el
      // logo se recoloca al final de todos modos.
      canvas.bringObjectToFront(b.backdrop);
      canvas.bringObjectToFront(b.obj);
    }

    y += h;
  });

  return { top, height: total };
}

// ── Cartel del modo "poster" ────────────────────────────────────────

/**
 * Duplica el fondo para mostrarlo entero encima de sí mismo, desenfocado.
 *
 * Se clona en vez de volver a descargar la imagen: el navegador ya tiene ese bitmap y
 * clonar evita una segunda petición al proxy (que a su vez son otra llamada GraphQL a
 * Twenty para firmar la URL).
 */
async function buildPoster(bg: fabric.FabricImage): Promise<fabric.FabricImage> {
  const poster = (await bg.clone()) as fabric.FabricImage;
  // `clone()` copia las propiedades registradas, así que el cartel nace marcado como
  // fondo. Si se quedara así, `findBackgroundImage` lo devolvería a él y el refresco desde
  // Twenty sustituiría el cartel en lugar del fondo de detrás.
  delete (poster as any)._isBgImage;
  delete (poster as any)._bgFit;
  (poster as any)._tplRole = "poster";
  poster.set({
    selectable: true,
    evented: true,
    hasControls: true,
    lockRotation: true,
    // El fondo lleva desenfoque; el cartel tiene que verse nítido, así que no hereda nada.
    filters: [],
    shadow: new fabric.Shadow({ color: "rgba(0,0,0,0.55)", blur: 40, offsetX: 0, offsetY: 10 }),
  });
  poster.applyFilters();
  poster.setControlVisible("mtr", false);
  downscaleOversizedSource(poster);
  return poster;
}

/** Encaja el cartel completo (contain) en el hueco que ha dejado libre el bloque de datos. */
function fitPoster(
  poster: fabric.FabricImage,
  pageWidth: number,
  stackTop: number
): void {
  const margin = Math.round(pageWidth * M.margin);
  const usableW = pageWidth - margin * 2;
  // El bloque de datos manda: el cartel se queda con lo que sobra, y no al revés. Al revés
  // es como se producen los solapes cuando el titular ocupa una línea más de lo previsto.
  const usableH = Math.max(stackTop - margin * 2, pageWidth * 0.25);
  const natW = poster.width || 1;
  const natH = poster.height || 1;
  const scale = Math.min(usableW / natW, usableH / natH);
  poster.set({
    scaleX: scale,
    scaleY: scale,
    left: (pageWidth - natW * scale) / 2,
    top: margin + Math.max(0, (usableH - natH * scale) / 2),
  });
  poster.setCoords();
}

// ── Composición ─────────────────────────────────────────────────────

/**
 * Tratamiento del fondo de cada modo. Se fija **siempre entero**, los dos ajustes a la vez:
 * si solo se pusiera el que toca, al cambiar de modo quedarían mezclados el desenfoque de
 * uno y el velo del otro.
 */
function applyModeBackground(
  canvas: fabric.Canvas,
  mode: EventLayoutMode,
  pageWidth: number,
  pageHeight: number,
  theme: EventTheme
): void {
  const tone = THEMES[theme].scrimTone;
  // El brillo va en el sentido del tema: la tinta oscura necesita que la foto se aclare,
  // no que se apague, o el velo claro tendría que pelearse con ella.
  const lift = theme === "dark" ? 0.12 : -0.3;
  if (mode === "poster") {
    applyBackgroundEffects(canvas, { blur: 0.3, brightness: lift, contrast: 0, sharpen: 0 });
    applyScrim(canvas, pageWidth, pageHeight, "solid", 0.25, tone);
  } else {
    applyBackgroundEffects(canvas, {
      ...NO_EFFECTS,
      contrast: 0.08,
      brightness: theme === "dark" ? 0.06 : -0.05,
    });
    // Degradado en vez de velo uniforme: aquí el texto va abajo, así que tratar la foto
    // entera apagaría justo la parte que se quiere enseñar.
    applyScrim(canvas, pageWidth, pageHeight, "bottom", 0.8, tone);
  }
}

export interface ComposeOptions {
  pageWidth: number;
  pageHeight: number;
  /** Fuerza el modo. Si falta, se decide por la proporción de la imagen de fondo. */
  mode?: EventLayoutMode;
  /** Tinta clara (para foto oscura) u oscura (para foto clara). Por defecto, clara. */
  theme?: EventTheme;
}

/**
 * Compone la página entera. Devuelve el modo que ha acabado usando.
 *
 * Borra lo que hubiera de una composición anterior, así que sirve igual para la primera
 * apertura y para "Rehacer plantilla".
 */
export async function composeEventTemplate(
  canvas: fabric.Canvas,
  copy: EventCopy,
  opts: ComposeOptions
): Promise<EventLayoutMode> {
  const { pageWidth, pageHeight } = opts;
  const theme = opts.theme ?? "light";
  clearEventTemplate(canvas);

  const bg = findBackgroundImage(canvas);
  const mode = opts.mode ?? (bg ? chooseLayoutMode(bg, pageWidth, pageHeight) : "bleed");

  if (bg) {
    applyModeBackground(canvas, mode, pageWidth, pageHeight, theme);
  } else {
    // Sin foto no hay nada que velar, y el lienzo nace blanco (`page-canvas.tsx`): con el
    // tema claro sería texto crema sobre blanco, o sea un post en blanco. Se pone el color
    // de marca contrario al de la tinta, que además deja ver enseguida que falta la foto.
    canvas.backgroundColor = theme === "dark" ? CREAM : NAVY;
  }

  const blocks = buildBlocks(copy, pageWidth, mode, theme);
  for (const b of blocks) {
    if (b.backdrop) canvas.add(b.backdrop);
    canvas.add(b.obj);
  }

  // Primera pasada: mide con las fuentes que haya cargadas en este momento.
  let stack = stackBlocks(blocks, canvas, pageWidth, pageHeight, mode);

  // Y ahora la de verdad. El texto en canvas no dispara la descarga de webfonts, así que lo
  // que se acaba de medir son las métricas de la fuente de reserva (§9.13 bug B). No basta
  // con recolocar un objeto como hace "Mejorar titular": si el titular pasa de dos líneas a
  // tres al llegar Montserrat 800, se mueve todo lo que va debajo — hay que re-apilar.
  await syncCanvasFonts(canvas);
  stack = stackBlocks(blocks, canvas, pageWidth, pageHeight, mode);

  if (mode === "poster" && bg) {
    const poster = await buildPoster(bg);
    fitPoster(poster, pageWidth, stack.top);
    canvas.add(poster);
    // Encima del velo, debajo del texto: el cartel es contenido, no fondo.
    const firstBlock = blocks.map((b) => canvas.getObjects().indexOf(b.obj)).filter((i) => i >= 0);
    if (firstBlock.length) canvas.moveObjectTo(poster, Math.min(...firstBlock));
  }

  // `canvas.add` apila encima, y el logo ya estaba puesto antes de componer.
  bringLogoToFront(canvas);
  canvas.requestRenderAll();
  return mode;
}

/**
 * Re-apila la plantilla ya existente para un tamaño de página nuevo, sin volver a pedir
 * nada a Twenty ni tocar los textos.
 *
 * Es lo que hace que cambiar de cuadrado a vertical u historia "adapte" el diseño en vez
 * de dejar los bloques anclados al borde inferior de la página anterior. Los cuerpos de
 * letra van en proporción al **ancho**, y los tres presets miden 1080 de ancho, así que lo
 * único que cambia de verdad es el anclaje vertical y cuánto sitio hay.
 *
 * El titular sí se devuelve a su cuerpo nominal antes de re-ajustarlo: `fitToLines` solo
 * sabe encoger, de modo que sin este reinicio cada cambio de tamaño lo dejaría un poco más
 * pequeño que el anterior, sin vuelta atrás.
 */
export function relayoutEventTemplate(
  canvas: fabric.Canvas,
  pageWidth: number,
  pageHeight: number
): boolean {
  const byRole = new Map<string, fabric.FabricObject>();
  for (const o of canvas.getObjects()) {
    const role = tplRole(o);
    if (role) byRole.set(role, o);
  }
  if (!byRole.has("title")) return false;

  const mode: EventLayoutMode = byRole.has("poster") ? "poster" : "bleed";

  const blocks: Block[] = [];
  for (const role of BLOCK_ORDER) {
    const obj = byRole.get(role);
    if (!obj) continue;
    blocks.push({
      role,
      obj,
      backdrop: role === "price" ? (byRole.get("priceBg") as fabric.Rect | undefined) : undefined,
      ...BLOCK_META[role],
    });
  }

  const title = byRole.get("title") as fabric.Textbox | undefined;
  if (title) title.set({ fontSize: Math.round(pageWidth * M.titleOfPage[mode]) });

  const stack = stackBlocks(blocks, canvas, pageWidth, pageHeight, mode);

  const poster = byRole.get("poster") as fabric.FabricImage | undefined;
  if (poster) fitPoster(poster, pageWidth, stack.top);

  bringLogoToFront(canvas);
  canvas.requestRenderAll();
  return true;
}

/**
 * Tras un refresco de la imagen desde Twenty, el cartel del modo "poster" también tiene que
 * reflejar la foto nueva: si no, el fondo desenfocado enseñaría una imagen y el cartel de
 * encima otra distinta — una incoherencia difícil de atribuir a nada.
 */
export async function refreshPosterImage(canvas: fabric.Canvas): Promise<void> {
  const poster = findByRole(canvas, "poster") as fabric.FabricImage | undefined;
  const bg = findBackgroundImage(canvas);
  if (!poster || !bg) return;
  // Se compara el tamaño natural del bitmap y no la URL: la del proxy es **estable por
  // registro** (`/api/twenty/event/:id/image`), así que sigue siendo la misma aunque en
  // Twenty hayan sustituido la foto — comparar cadenas no detectaría nunca el cambio.
  // Es el mismo criterio que usa `preserveFraming` en `applyBackgroundToCanvas`.
  if (poster.width === bg.width && poster.height === bg.height) return;

  const replacement = await buildPoster(bg);
  // Se conserva el encuadre del cartel anterior: puede haberlo movido el operador.
  replacement.set({
    left: poster.left,
    top: poster.top,
    scaleX: poster.scaleX,
    scaleY: poster.scaleY,
  });
  replacement.setCoords();

  // El índice se lee antes de quitar nada, o el sustituto acabaría encima del texto.
  const index = canvas.getObjects().indexOf(poster);
  canvas.remove(poster);
  canvas.add(replacement);
  if (index >= 0) canvas.moveObjectTo(replacement, index);
  bringLogoToFront(canvas);
  canvas.requestRenderAll();
}
