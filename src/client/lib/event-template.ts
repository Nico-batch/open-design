import * as fabric from "fabric";
import type { EventCopy } from "./event-fields";
import { applyBackgroundEffects, applyScrim, NO_EFFECTS } from "./effects";
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
  klass.customProperties = [...(klass.customProperties ?? []), "_tplRole"];
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
 * Un único color de acento, usado dos veces (categoría y píldora de precio). Ámbar cálido:
 * aguanta sobre foto clara y sobre foto oscura, que es más de lo que puede decirse del
 * añil de la interfaz, y no compite con el blanco del titular.
 */
const ACCENT = "#ffc857";
const ON_ACCENT = "#111114";
const WHITE = "#ffffff";
const MUTED = "rgba(255,255,255,0.82)";

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
  priceOfPage: 1 / 32,
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

/** La sombra que ya usa el titular de noticias (`enhance.ts`), en proporción al cuerpo:
 *  es lo que separa el texto de la foto sin recurrir a un contorno grueso. */
function textShadow(fontSize: number, strength = 1): fabric.Shadow {
  return new fabric.Shadow({
    color: `rgba(0,0,0,${0.55 * strength})`,
    blur: Math.round(fontSize * 0.16),
    offsetX: Math.round(fontSize * 0.04),
    offsetY: Math.round(fontSize * 0.05),
    affectStroke: true,
  });
}

function buildBlocks(copy: EventCopy, pageWidth: number, mode: EventLayoutMode): Block[] {
  const width = Math.round(pageWidth * M.blockWidth);
  const blocks: Block[] = [];

  if (copy.categoria) {
    const fontSize = Math.round(pageWidth * M.categoryOfPage);
    blocks.push({
      role: "category",
      dropPriority: 1,
      gapBefore: 0,
      obj: makeText(copy.categoria.toUpperCase(), "category", {
        fontSize,
        fontFamily: "Montserrat",
        fontWeight: "700",
        fill: ACCENT,
        width,
        // Muy abierto: una sola palabra corta en mayúsculas necesita el tracking para
        // leerse como un rótulo y no como una palabra suelta perdida sobre la foto.
        charSpacing: 160,
        shadow: textShadow(fontSize),
      }),
    });
  }

  {
    const fontSize = Math.round(pageWidth * M.titleOfPage[mode]);
    blocks.push({
      role: "title",
      dropPriority: 0,
      gapBefore: 0.45,
      obj: makeText(copy.titulo.toUpperCase(), "title", {
        fontSize,
        fontFamily: "Montserrat",
        // 800 viene en public/fonts/Montserrat: es la ExtraBold de verdad, no una negrita
        // sintética — el mismo peso que usa "Mejorar titular".
        fontWeight: "800",
        fill: WHITE,
        width,
        charSpacing: -20,
        lineHeight: 1.02,
        shadow: textShadow(fontSize),
      }),
    });
  }

  if (copy.subtitulo) {
    const fontSize = Math.round(pageWidth * M.subtitleOfPage);
    blocks.push({
      role: "subtitle",
      dropPriority: 3,
      gapBefore: 0.55,
      obj: makeText(copy.subtitulo, "subtitle", {
        fontSize,
        fontFamily: "Inter",
        fontWeight: "400",
        fill: MUTED,
        width,
        lineHeight: 1.25,
        shadow: textShadow(fontSize, 0.8),
      }),
    });
  }

  if (copy.fecha) {
    const fontSize = Math.round(pageWidth * M.dateOfPage);
    blocks.push({
      role: "date",
      dropPriority: 0,
      gapBefore: 0.8,
      obj: makeText(copy.fecha, "date", {
        fontSize,
        fontFamily: "Montserrat",
        fontWeight: "700",
        fill: WHITE,
        width,
        charSpacing: 20,
        shadow: textShadow(fontSize),
      }),
    });
  }

  if (copy.lugar) {
    const fontSize = Math.round(pageWidth * M.placeOfPage);
    blocks.push({
      role: "place",
      dropPriority: 2,
      gapBefore: 0.35,
      obj: makeText(copy.lugar, "place", {
        fontSize,
        fontFamily: "Inter",
        fontWeight: "500",
        fill: MUTED,
        width,
        shadow: textShadow(fontSize, 0.8),
      }),
    });
  }

  if (copy.precio) {
    const fontSize = Math.round(pageWidth * M.priceOfPage);
    const text = makeText(copy.precio, "price", {
      fontSize,
      fontFamily: "Montserrat",
      fontWeight: "800",
      fill: ON_ACCENT,
      width,
      charSpacing: 100,
    });
    // Rect + Textbox como hermanos y no un `Group`: un grupo fija el sistema de
    // coordenadas de sus hijos al crearse, así que no se re-maqueta cuando el texto cambia
    // de medidas al llegar la fuente real (§9.13 bug B) — y además obligaría a desagrupar
    // para editar el texto. El rectángulo no recibe eventos, igual que el velo, para que
    // el clic llegue al texto que hay encima.
    const backdrop = new fabric.Rect({
      fill: ACCENT,
      selectable: false,
      evented: false,
      hoverCursor: "default",
    });
    (backdrop as any)._tplRole = "priceBg";
    blocks.push({ role: "price", obj: text, backdrop, dropPriority: 2, gapBefore: 0.9 });
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
      // Justo debajo de su texto, pase lo que pase con el orden de inserción.
      canvas.moveObjectTo(b.backdrop, canvas.getObjects().indexOf(b.obj));
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
  pageHeight: number
): void {
  if (mode === "poster") {
    applyBackgroundEffects(canvas, { blur: 0.3, brightness: -0.3, contrast: 0, sharpen: 0 });
    applyScrim(canvas, pageWidth, pageHeight, "solid", 0.25);
  } else {
    applyBackgroundEffects(canvas, { ...NO_EFFECTS, contrast: 0.08, brightness: -0.05 });
    // Degradado en vez de velo uniforme: aquí el texto va abajo, así que oscurecer la foto
    // entera apagaría justo la parte que se quiere enseñar.
    applyScrim(canvas, pageWidth, pageHeight, "bottom", 0.8);
  }
}

export interface ComposeOptions {
  pageWidth: number;
  pageHeight: number;
  /** Fuerza el modo. Si falta, se decide por la proporción de la imagen de fondo. */
  mode?: EventLayoutMode;
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
  clearEventTemplate(canvas);

  const bg = findBackgroundImage(canvas);
  const mode = opts.mode ?? (bg ? chooseLayoutMode(bg, pageWidth, pageHeight) : "bleed");

  if (bg) {
    applyModeBackground(canvas, mode, pageWidth, pageHeight);
  } else {
    // Sin foto no hay nada que oscurecer, y el lienzo nace blanco (`page-canvas.tsx`):
    // texto blanco sobre blanco sería un post en blanco. Un fondo oscuro deja la plantilla
    // legible y se ve enseguida que falta la imagen.
    canvas.backgroundColor = "#111114";
  }

  const blocks = buildBlocks(copy, pageWidth, mode);
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
