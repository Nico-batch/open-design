import * as fabric from "fabric";
import { isLogoObject, bringLogoToFront } from "./logo";
import { isBackgroundImage } from "./background";
import { isScrim } from "./effects";
import { nwRole, type NwRole } from "./news-template";
import { tplRole, type TplRole } from "./event-template";

/**
 * El modelo del panel de capas: qué hay en la página, cómo se llama cada cosa, y las tres
 * operaciones que no son un simple `set` — ocultar, bloquear y reordenar.
 *
 * El componente (`components/layers-panel.tsx`) solo pinta esto; todo lo que hay que saber de
 * Fabric vive aquí.
 */

// ── El candado ──────────────────────────────────────────────────────

/**
 * Marca persistida de "esta capa está bloqueada".
 *
 * Hace falta una propiedad propia porque **Fabric no serializa ninguna de las cuatro
 * propiedades que hacen efectivo un bloqueo** —`selectable`, `evented`, `hasControls`,
 * `hoverCursor`—; ese es literalmente el bug de §9.31, que devolvía clicable todo el chrome de
 * la plantilla al reabrir un borrador. `_locked` sí viaja en el `canvas_json`, y
 * `applyLockState` lo vuelve a traducir a esas cuatro después de cada `loadFromJSON`.
 *
 * (`visible`, en cambio, **sí** es una propiedad estándar de Fabric y se serializa sola, así
 * que el ojo del panel no necesita nada de esto.)
 */
export const LOCKED_PROP = "_locked";

// El `concat` de `toObject` es
// `propertiesToInclude.concat(FabricObject.customProperties, this.constructor.customProperties)`,
// de modo que la lista de la **clase base** se añade siempre, pase lo que pase con la de la
// subclase. Con registrarla ahí quedan cubiertas todas las clases de una vez — a diferencia de
// `_nwRole`/`_tplRole`, que se registran clase por clase porque el problema allí era el
// contrario: una subclase con array propio *tapa* el heredado, no el de la base.
//
// Aun así se repite en las clases que declaran array propio (`background.ts` y `effects.ts`
// los sobrescriben con literales, `news-template.ts` les añade lo suyo): cuesta una línea y
// deja de depender de un detalle interno de Fabric. Los imports de arriba garantizan que esos
// módulos ya se han evaluado — un módulo importado corre antes que quien lo importa.
for (const klass of [
  (fabric as unknown as { BaseFabricObject?: { customProperties?: string[] } }).BaseFabricObject,
  fabric.FabricObject as unknown as { customProperties?: string[] },
  fabric.Textbox as unknown as { customProperties?: string[] },
  fabric.Rect as unknown as { customProperties?: string[] },
  fabric.FabricImage as unknown as { customProperties?: string[] },
]) {
  if (!klass) continue;
  if (!klass.customProperties?.includes(LOCKED_PROP)) {
    klass.customProperties = [...(klass.customProperties ?? []), LOCKED_PROP];
  }
}

export function isLayerLocked(obj: fabric.FabricObject): boolean {
  return (obj as any)[LOCKED_PROP] === true;
}

/**
 * Bloquea o desbloquea una capa.
 *
 * Al bloquear hay que soltar la selección si era ella: dejar seleccionado un objeto que ya no
 * responde al ratón deja el panel derecho gobernando algo que no se puede tocar en el lienzo,
 * y sus tiradores dibujados sobre un objeto inerte.
 */
export function setLayerLocked(
  canvas: fabric.Canvas,
  obj: fabric.FabricObject,
  locked: boolean
): void {
  (obj as any)[LOCKED_PROP] = locked;
  if (locked) {
    obj.set({ selectable: false, evented: false, hasControls: false, hoverCursor: "default" });
    if (canvas.getActiveObject() === obj) canvas.discardActiveObject();
  } else {
    obj.set({ selectable: true, evented: true, hasControls: true, hoverCursor: undefined });
  }
  obj.setCoords();
  canvas.requestRenderAll();
}

/**
 * Re-aplica los candados guardados después de un `loadFromJSON`.
 *
 * Mismo patrón y mismo motivo que `applyWorkspaceClip` (§9.16), `normalizeBackgroundSource`
 * (§9.18) y `normalizeNewsTemplate` (§9.31): `loadFromJSON` devuelve el lienzo a su estado
 * *serializado*, no al que tenía en memoria, así que todo lo que no viaja en el JSON hay que
 * rehacerlo a mano — y por eso se llama desde las **tres** rutas que reconstruyen un lienzo
 * (abrir la página, deshacer/rehacer, aplicar una plantilla).
 *
 * Solo toca lo que lleva marca explícita: un objeto sin `_locked` se queda con lo que le haya
 * dejado `normalizeNewsTemplate` o el propio Fabric.
 */
export function applyLockState(canvas: fabric.Canvas): void {
  for (const obj of canvas.getObjects()) {
    const locked = (obj as any)[LOCKED_PROP];
    if (typeof locked !== "boolean") continue;
    setLayerLocked(canvas, obj, locked);
  }
}

// ── El ojo ──────────────────────────────────────────────────────────

/**
 * Oculta o muestra una capa.
 *
 * Ojo con lo que significa: `visible: false` es invisible **también en la exportación**, no una
 * capa "en pausa". Es el comportamiento estándar de un panel de capas, pero conviene tenerlo
 * presente antes de pulsar "Guardar en Twenty".
 */
export function setLayerVisible(
  canvas: fabric.Canvas,
  obj: fabric.FabricObject,
  visible: boolean
): void {
  obj.set({ visible });
  obj.dirty = true;
  if (!visible && canvas.getActiveObject() === obj) canvas.discardActiveObject();
  canvas.requestRenderAll();
}

// ── Nombres ─────────────────────────────────────────────────────────

/** Familia de la capa: decide el icono y poco más. */
export type LayerKind = "photo" | "glass" | "scrim" | "text" | "image" | "shape";

const NEWS_NAMES: Record<NwRole, string> = {
  glass: "Desenfoque",
  // Desde §9.30 no pinta nada: es solo el ancla de la maquetación (y la señal por la que el
  // logo se coloca). Llamarla "franja" haría buscar en el lienzo un bloque que no existe.
  band: "Zona de texto",
  chipBg: "Sección (fondo)",
  chip: "Sección",
  figure: "Cifra",
  unit: "Unidad",
  headline: "Titular",
  rule: "Línea",
  account: "Pie",
};

const EVENT_NAMES: Record<TplRole, string> = {
  poster: "Cartel",
  category: "Categoría",
  title: "Título",
  subtitle: "Subtítulo",
  date: "Fecha",
  place: "Lugar",
  price: "Precio",
  priceBg: "Fondo del precio",
};

// Claves en minúscula: el getter `type` de Fabric v6 devuelve `this.constructor.type` pasado
// por `toLowerCase()`, aunque la constante de cada clase esté capitalizada ('Rect', 'Circle').
const SHAPE_NAMES: Record<string, string> = {
  rect: "Rectángulo",
  circle: "Círculo",
  triangle: "Triángulo",
  line: "Línea",
  path: "Trazado",
  group: "Grupo",
};

/** Cuántos caracteres del texto se usan como nombre de la capa antes de recortar. */
const TEXT_NAME_MAX = 26;

/**
 * Cómo se llama una capa en el panel.
 *
 * El orden importa: las marcas de plantilla van **antes** que el tipo de objeto, porque
 * "Titular" dice mucho más que "Texto" y "Desenfoque" mucho más que "Imagen" — y son
 * justamente las capas que el operador no ha puesto él y por tanto no reconocería.
 */
export function describeLayer(obj: fabric.FabricObject): { name: string; kind: LayerKind } {
  const nw = nwRole(obj);
  if (nw) {
    const chrome = nw === "band" || nw === "rule" || nw === "chipBg";
    return { name: NEWS_NAMES[nw], kind: nw === "glass" ? "glass" : chrome ? "shape" : "text" };
  }
  const tpl = tplRole(obj);
  if (tpl) {
    const kind: LayerKind = tpl === "poster" ? "image" : tpl === "priceBg" ? "shape" : "text";
    return { name: EVENT_NAMES[tpl], kind };
  }
  if (isBackgroundImage(obj)) return { name: "Foto de fondo", kind: "photo" };
  if (isScrim(obj)) return { name: "Velo", kind: "scrim" };

  if (obj instanceof fabric.Textbox || obj instanceof fabric.IText) {
    const text = (obj.text ?? "").replace(/\s+/g, " ").trim();
    const short = text.length > TEXT_NAME_MAX ? text.slice(0, TEXT_NAME_MAX) + "…" : text;
    return { name: short || "Texto vacío", kind: "text" };
  }
  if (obj instanceof fabric.FabricImage) return { name: "Imagen", kind: "image" };
  return { name: SHAPE_NAMES[obj.type] ?? "Forma", kind: "shape" };
}

// ── La lista ────────────────────────────────────────────────────────

export interface LayerInfo {
  obj: fabric.FabricObject;
  name: string;
  kind: LayerKind;
  locked: boolean;
  visible: boolean;
  /** Generada por una plantilla, no puesta a mano. Solo para matizarla en la interfaz. */
  fromTemplate: boolean;
}

/**
 * Las capas de la página, **de arriba abajo** (la primera de la lista es la que tapa al
 * resto), que es como las lee cualquiera que haya usado un editor antes.
 *
 * El logo queda fuera a propósito: no se persiste —`withoutLogo` lo saca de todo lo que se
 * serializa— y `applyLogoToCanvas` lo reconstruye desde cero al abrir la página y en cada
 * cambio de tamaño, así que ofrecerlo como capa editable sería ofrecer cambios que se tiran.
 */
export function listLayers(canvas: fabric.Canvas): LayerInfo[] {
  const layers: LayerInfo[] = [];
  for (const obj of canvas.getObjects()) {
    if (isLogoObject(obj)) continue;
    const { name, kind } = describeLayer(obj);
    layers.push({
      obj,
      name,
      kind,
      locked: isLayerLocked(obj),
      visible: obj.visible !== false,
      fromTemplate: nwRole(obj) !== null || tplRole(obj) !== null,
    });
  }
  return layers.reverse();
}

// ── Reordenar ───────────────────────────────────────────────────────

/**
 * Coloca la capa en un índice **del lienzo** (0 = al fondo), acotado al rango válido.
 *
 * Devuelve si de verdad se movió algo, para que quien llama no escriba una entrada de
 * historial por un arrastre que acabó donde empezó.
 */
export function moveLayerTo(
  canvas: fabric.Canvas,
  obj: fabric.FabricObject,
  index: number
): boolean {
  const objects = canvas.getObjects();
  const from = objects.indexOf(obj);
  if (from < 0) return false;
  const to = Math.max(0, Math.min(objects.length - 1, index));
  if (to === from) return false;
  canvas.moveObjectTo(obj, to);
  // Cualquier reordenación puede dejar el logo tapado: `canvas.add` lo apila encima al
  // crearlo, pero `moveObjectTo` sí puede colar algo por delante.
  bringLogoToFront(canvas);
  canvas.requestRenderAll();
  return true;
}

/**
 * Sube (`delta > 0`) o baja (`delta < 0`) una capa, **en el sentido del panel**.
 *
 * Los índices del lienzo van al revés que la lista (0 es el fondo), de ahí que subir en el
 * panel sea sumar en el lienzo… lo cual coincide, pero merece decirse en voz alta porque el
 * arrastre de abajo sí necesita invertirlos.
 */
export function moveLayer(canvas: fabric.Canvas, obj: fabric.FabricObject, delta: number): boolean {
  const from = canvas.getObjects().indexOf(obj);
  if (from < 0) return false;
  return moveLayerTo(canvas, obj, from + delta);
}

/**
 * Traduce un arrastre del panel a un movimiento en el lienzo: la fila `fromRow` se suelta en
 * la posición `toRow` de la lista, las dos contadas de arriba abajo y `toRow` entendida como
 * "delante de esta fila" (por eso puede valer `length`, que es soltar al final).
 *
 * La resta de uno al arrastrar hacia abajo es la corrección de siempre: al sacar la fila de su
 * sitio, todo lo que había debajo del hueco sube una posición.
 */
export function reorderByRow(canvas: fabric.Canvas, fromRow: number, toRow: number): boolean {
  if (fromRow < 0 || toRow < 0) return false;
  const layers = listLayers(canvas);
  const obj = layers[fromRow]?.obj;
  if (!obj) return false;
  const target = toRow > fromRow ? toRow - 1 : toRow;
  if (target === fromRow) return false;
  // De índice de fila (0 = arriba del todo) a índice de lienzo (0 = al fondo).
  return moveLayerTo(canvas, obj, layers.length - 1 - target);
}
