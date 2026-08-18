import * as fabric from "fabric";

// Brand logo (faro/lighthouse, blanco, fondo transparente). To replace, drop the new
// file at public/logo.png (or update this path) — no other changes needed. Needs a real
// alpha channel (RGBA) — a flat JPG here would show an opaque box behind the logo on top
// of whatever background image is underneath.
export const LOGO_URL = "/logo.png";

const MAX_WIDTH_RATIO = 0.18;
const MAX_WIDTH_PX = 220;
const PADDING_RATIO = 0.04;
const MIN_PADDING_PX = 20;

let cachedImg: fabric.FabricImage | null = null;
let loading: Promise<fabric.FabricImage> | null = null;
let cachedBounds: OpaqueBounds | null = null;

/** El rectángulo que de verdad ocupa el dibujo dentro del PNG, en píxeles naturales. */
interface OpaqueBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Mide la parte no transparente del logo.
 *
 * Hace falta porque `public/logo.png` es un lienzo de 500×500 en el que el faro ocupa unos
 * 197×324 descentrados: pedir "66 px de alto" al objeto dejaría el faro en 43 px y pegado al
 * borde equivocado, y el margen de 48 px del diseño no sería el que se ve. Se mide en vez de
 * anotar los números a mano para que siga siendo cierto lo que promete el comentario de
 * `LOGO_URL`: cambiar el logo es sustituir el archivo, sin tocar código.
 *
 * Una sola vez por sesión, sobre un lienzo de 500×500. La imagen es del mismo origen, así que
 * `getImageData` no está bloqueado; si algún día lo estuviera, se cae a la caja completa.
 */
function measureOpaqueBounds(img: fabric.FabricImage): OpaqueBounds {
  const width = img.width || 1;
  const height = img.height || 1;
  const full: OpaqueBounds = { x: 0, y: 0, width, height };
  try {
    const el = img.getElement() as CanvasImageSource;
    const buffer = document.createElement("canvas");
    buffer.width = width;
    buffer.height = height;
    const ctx = buffer.getContext("2d");
    if (!ctx) return full;
    ctx.drawImage(el, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Un umbral y no `> 0`: los bordes suavizados del PNG dejan un halo de alfa casi
        // nulo que ensancharía la caja sin aportar nada visible.
        if (data[(y * width + x) * 4 + 3] > 16) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return full;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  } catch {
    return full;
  }
}

function loadLogoImage(): Promise<fabric.FabricImage> {
  if (cachedImg) return Promise.resolve(cachedImg);
  if (loading) return loading;
  loading = fabric.FabricImage.fromURL(LOGO_URL, { crossOrigin: "anonymous" }).then((img) => {
    cachedImg = img;
    cachedBounds = measureOpaqueBounds(img);
    return img;
  });
  return loading;
}

export function isLogoObject(obj: fabric.FabricObject | undefined | null): boolean {
  return !!obj && (obj as any)._isLogo === true;
}

/**
 * Devuelve el logo al frente.
 *
 * Hace falta porque `canvas.add()` apila encima: cualquier cosa que se añada *después* de
 * la capa del logo —como los bloques de la plantilla de eventos, que se componen una vez
 * el logo ya está puesto— quedaría tapándolo. Más barato que volver a llamar a
 * `applyLogoToCanvas`, que reconstruye la imagen entera.
 */
export function bringLogoToFront(canvas: fabric.Canvas): void {
  const logo = canvas.getObjects().find(isLogoObject);
  if (logo) canvas.bringObjectToFront(logo);
}

/**
 * La plantilla de noticias quiere la marca **arriba a la izquierda**, a 48 px de los dos
 * bordes y con 66 px de alto (medidas de la guía sobre una página de 1080 de ancho).
 *
 * La colocación se **deduce** de si el lienzo tiene la franja de esa plantilla, y no se
 * guarda en ningún sitio, porque la capa del logo no se persiste (`withoutLogo` la saca de
 * todo lo que se serializa) y `applyLogoToCanvas` la reconstruye desde cero al abrir la
 * página y en cada cambio de tamaño — cualquier ajuste hecho "a mano" se perdería. La franja
 * sí viaja en el `canvas_json`, así que deducirlo de ella sobrevive a recargar.
 *
 * Se lee la propiedad a pelo en vez de importar `news-template.ts`: ese módulo importa este
 * para `bringLogoToFront`, y sería un ciclo.
 */
const NEWS_REF_WIDTH = 1080;
const NEWS_LOGO_HEIGHT = 66;
const NEWS_LOGO_INSET = 48;

function hasNewsBand(canvas: fabric.Canvas): boolean {
  return canvas.getObjects().some((o) => (o as any)._nwRole === "band");
}

function positionLogo(obj: fabric.FabricObject, canvas: fabric.Canvas, canvasWidth: number) {
  const naturalWidth = (obj.width || 1) as number;
  const naturalHeight = (obj.height || 1) as number;

  if (hasNewsBand(canvas)) {
    const s = canvasWidth / NEWS_REF_WIDTH;
    const bounds = cachedBounds ?? { x: 0, y: 0, width: naturalWidth, height: naturalHeight };
    // 66 px del **faro**, no de la caja del PNG, y el margen medido desde el dibujo: el
    // objeto se desplaza por el hueco transparente que lleva encima y a la izquierda.
    const scale = (NEWS_LOGO_HEIGHT * s) / bounds.height;
    obj.set({
      scaleX: scale,
      scaleY: scale,
      left: NEWS_LOGO_INSET * s - bounds.x * scale,
      top: NEWS_LOGO_INSET * s - bounds.y * scale,
      // "Si la zona de la foto es muy clara, añadir sombra proyectada suave únicamente al
      // logotipo". Se pone siempre en vez de medir la luminancia de esa esquina: es posible
      // (el lienzo no está *tainted*, para eso existe el proxy de imágenes) pero añade un
      // caso que se puede equivocar, y una sombra suave bajo una marca crema sobre foto
      // oscura no se ve. Nunca al texto, que la guía lo prohíbe.
      shadow: new fabric.Shadow({
        color: "rgba(0,0,0,0.35)",
        blur: Math.round(18 * s),
        offsetX: 0,
        offsetY: Math.round(3 * s),
      }),
    });
    return;
  }

  const targetWidth = Math.min(canvasWidth * MAX_WIDTH_RATIO, MAX_WIDTH_PX);
  const scale = targetWidth / naturalWidth;
  const padding = Math.max(canvasWidth * PADDING_RATIO, MIN_PADDING_PX);

  obj.set({
    scaleX: scale,
    scaleY: scale,
    left: canvasWidth - padding - targetWidth,
    top: padding,
    shadow: null,
  });
}

/** (Re)adds the fixed, locked logo layer to `canvas`. Top-right by default; top-left and
 *  smaller when the page carries the news template (see positionLogo). */
export async function applyLogoToCanvas(
  canvas: fabric.Canvas,
  canvasWidth: number,
  canvasHeight: number
): Promise<void> {
  const existing = canvas.getObjects().find(isLogoObject);
  if (existing) canvas.remove(existing);

  const source = await loadLogoImage();
  const logo = await source.clone();
  logo.set({
    selectable: false,
    evented: false,
    hasControls: false,
    hasBorders: false,
    lockMovementX: true,
    lockMovementY: true,
    hoverCursor: "default",
    excludeFromExport: false,
  });
  (logo as any)._isLogo = true;
  positionLogo(logo, canvas, canvasWidth);
  void canvasHeight; // reserved for future vertical constraints

  canvas.add(logo);
  canvas.bringObjectToFront(logo);
  canvas.requestRenderAll();
}

/** Removes the logo layer (if present), runs `fn`, then restores it. Use around any
 *  serialization that must not persist the logo (saves, undo/redo history). */
export function withoutLogo<T>(canvas: fabric.Canvas, fn: () => T): T {
  const logo = canvas.getObjects().find(isLogoObject);
  if (logo) canvas.remove(logo);
  try {
    return fn();
  } finally {
    if (logo) {
      canvas.add(logo);
      canvas.bringObjectToFront(logo);
    }
  }
}
