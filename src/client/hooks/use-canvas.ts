import { useState, useCallback, useRef, useEffect } from "preact/hooks";
import * as fabric from "fabric";
import type { Template } from "../types";
import { applyLogoToCanvas, isLogoObject, withoutLogo } from "../lib/logo";
import {
  findBackgroundImage,
  makeBackgroundInteractive,
  downscaleOversizedSource,
  normalizeBackgroundSource,
} from "../lib/background";
import { syncCanvasFonts, containsEmoji } from "../lib/fonts";
import {
  textRange,
  isTextObject,
  splitTextStyleProps,
  summarizeTextStyle,
  changesMetrics,
  changesFontFace,
  STYLE_PROPERTIES,
  BLANK_STYLE,
} from "../lib/text-styles";
import { PHOTO_RECIPE, headlineRecipe, uppercaseText, centreOnPage } from "../lib/enhance";
import { applyWorkspaceGeometry, applyWorkspaceClip, pageExportCrop, scaleAboutPageCenter } from "../lib/workspace";
import {
  applyBackgroundEffects,
  applyScrim,
  readBackgroundEffects,
  readScrim,
  resizeScrim,
  NO_EFFECTS,
  type BackgroundEffects,
  type ScrimKind,
} from "../lib/effects";
import { installCenterSnapping, type SnapAxes, type SnapConfig } from "../lib/snapping";
import {
  composeEventTemplate,
  relayoutEventTemplate,
  type EventLayoutMode,
  type EventTheme,
} from "../lib/event-template";
import type { EventCopy } from "../lib/event-fields";

const MAX_HISTORY = 50;

// NOTE — why there is no `cloneWithPrototype` here any more:
//
// The selected object used to be *copied* into state on every property change (first with
// a `{ ...obj }` spread, later with a prototype-preserving clone) purely to hand Preact a
// new reference so the re-render wasn't bailed out. That copy is detached from the canvas,
// so from the second edit onwards the right sidebar was mutating a ghost: the first change
// after selecting something applied, every one after it silently did nothing. That is the
// "a veces no se edita el texto desde el panel derecho" bug.
//
// State now holds the *real* fabric object, and `selectionVersion` (bumped on every
// mutation) is what makes Preact re-render — so the panel always reads live values off the
// object that is actually on the canvas.

const TEXT_PRESETS = {
  heading: { text: "Add a heading", fontSize: 48, fontWeight: "700", fontFamily: "Montserrat" },
  subheading: { text: "Add a subheading", fontSize: 32, fontWeight: "500", fontFamily: "Inter" },
  body: { text: "Add body text", fontSize: 18, fontWeight: "400", fontFamily: "Inter" },
} as const;

const SHAPE_DEFAULTS = {
  fill: "#6366f1",
  stroke: "",
  strokeWidth: 0,
  opacity: 1,
};

interface CanvasHistory {
  entries: string[];
  index: number;
}

export function useCanvasState() {
  const canvasMapRef = useRef<Map<string, fabric.Canvas>>(new Map());
  const historyMapRef = useRef<Map<string, CanvasHistory>>(new Map());
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(null);
  const activeCanvasIdRef = useRef<string | null>(null);
  const [selectedObject, setSelectedObject] = useState<fabric.FabricObject | null>(null);
  // Bumped whenever the selected object is mutated, so consumers re-render and read the
  // live values off it (see the note at the top of this file).
  const [selectionVersion, setSelectionVersion] = useState(0);
  const refreshSelection = useCallback(() => setSelectionVersion((v) => v + 1), []);
  const [canvasWidth, setCanvasWidth] = useState(1080);
  const [canvasHeight, setCanvasHeight] = useState(1080);
  const [zoom, setZoom] = useState(0.58);
  const [fitScale, setFitScale] = useState(0.58);
  // Never saved with the design, never exported — a view setting, like the zoom. Also
  // gates the center-snap while dragging (lib/snapping.ts): the two are one feature, on
  // together, off together.
  const [showGuides, setShowGuides] = useState(false);
  // Live-mirrors showGuides/canvasWidth/canvasHeight/zoom for the snap handler registered
  // once per canvas in registerCanvas (a stable useCallback) — without this it would keep
  // reading whatever these were at registration time.
  const snapConfigRef = useRef<SnapConfig>({ enabled: false, pageWidth: 1080, pageHeight: 1080, zoom: 0.58 });
  // Which page is mid-drag and which axis(es) are currently snapped, so guides-overlay.tsx
  // can highlight only the line on the page actually being dragged.
  const [snapAxes, setSnapAxes] = useState<{ pageId: string | null } & SnapAxes>({
    pageId: null,
    x: false,
    y: false,
  });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const isRestoringRef = useRef<Set<string>>(new Set());
  const canvasSizeRef = useRef({ width: 1080, height: 1080 });
  // Páginas cuyo historial ya ha fijado alguien a propósito (ver `sealHistory`). El
  // snapshot inicial diferido de `registerCanvas` lo consulta antes de escribir, o
  // machacaría el estado ya compuesto con el lienzo vacío de hace 100 ms.
  const historySealedRef = useRef<Set<string>>(new Set());

  // Reassigned every render (not in an effect) — cheap, and guarantees the snap handler
  // never reads a stale value, the same pattern page-canvas.tsx uses for onActivateRef.
  snapConfigRef.current = { enabled: showGuides, pageWidth: canvasWidth, pageHeight: canvasHeight, zoom };
  // Mismo motivo, y además uno propio: `getCanvasSize` lo consume el guardado **diferido**
  // de useDesigns. Si leyera el estado a través de un useCallback, quien llama a
  // `scheduleSave()` justo después de cambiar de tamaño estaría usando todavía el callback
  // del render anterior, y a los 2 s se guardaría el tamaño viejo — que es exactamente lo
  // que pasaba: la página volvía a su formato original al recargar.
  canvasSizeRef.current = { width: canvasWidth, height: canvasHeight };

  const reportSnap = useCallback((pageId: string, axes: SnapAxes) => {
    setSnapAxes((prev) => {
      if (prev.pageId === pageId && prev.x === axes.x && prev.y === axes.y) return prev;
      // A page stops reporting once its own drag ends (mouse:up) — if a *different* page's
      // highlight is currently showing, a no-op report from this page shouldn't clear it.
      if (prev.pageId !== pageId && !axes.x && !axes.y) return prev;
      return { pageId, ...axes };
    });
  }, []);

  // Helper to get the active canvas
  const getActiveCanvas = useCallback((): fabric.Canvas | null => {
    const id = activeCanvasIdRef.current;
    if (!id) return null;
    return canvasMapRef.current.get(id) ?? null;
  }, []);

  // Update undo/redo state for active canvas
  const updateUndoRedoState = useCallback((pageId: string) => {
    if (pageId !== activeCanvasIdRef.current) return;
    const hist = historyMapRef.current.get(pageId);
    if (!hist) {
      setCanUndo(false);
      setCanRedo(false);
      return;
    }
    setCanUndo(hist.index > 0);
    setCanRedo(hist.index < hist.entries.length - 1);
  }, []);

  const saveHistory = useCallback((pageId: string) => {
    if (isRestoringRef.current.has(pageId)) return;
    const canvas = canvasMapRef.current.get(pageId);
    if (!canvas) return;
    const json = withoutLogo(canvas, () => JSON.stringify(canvas.toJSON()));
    let hist = historyMapRef.current.get(pageId);
    if (!hist) {
      hist = { entries: [], index: -1 };
      historyMapRef.current.set(pageId, hist);
    }
    // Truncate forward history
    hist.entries = hist.entries.slice(0, hist.index + 1);
    hist.entries.push(json);
    if (hist.entries.length > MAX_HISTORY) {
      hist.entries.shift();
    } else {
      hist.index = hist.entries.length - 1;
    }
    updateUndoRedoState(pageId);
  }, [updateUndoRedoState]);

  const registerCanvas = useCallback((pageId: string, canvas: fabric.Canvas) => {
    canvasMapRef.current.set(pageId, canvas);

    // Selection events
    canvas.on("selection:created", (e) => {
      if (activeCanvasIdRef.current === pageId) {
        setSelectedObject(e.selected?.[0] ?? null);
      }
    });
    canvas.on("selection:updated", (e) => {
      if (activeCanvasIdRef.current === pageId) {
        setSelectedObject(e.selected?.[0] ?? null);
      }
    });
    canvas.on("selection:cleared", () => {
      if (activeCanvasIdRef.current === pageId) {
        setSelectedObject(null);
      }
    });

    // History events — the logo layer is added/removed/repositioned programmatically
    // (see lib/logo.ts) and must never itself trigger a history save: besides being
    // noise in undo/redo, withoutLogo()'s own remove/add would otherwise re-enter
    // saveHistory (which calls withoutLogo) and blow the call stack.
    canvas.on("object:added", (e) => {
      if (!isLogoObject(e.target)) saveHistory(pageId);
    });
    canvas.on("object:modified", (e) => {
      if (!isLogoObject(e.target)) saveHistory(pageId);
    });
    canvas.on("object:removed", (e) => {
      if (!isLogoObject(e.target)) saveHistory(pageId);
    });

    // Typing an emoji is the one case where a font arrives *mid-edit*: the emoji font is
    // only fetched once there's an emoji on the canvas (it's ~2 MB), so the first one the
    // operator types gets measured against a placeholder and the line wraps with the
    // wrong width — the same trap as any other webfont (see lib/fonts.ts). Re-measure
    // once the face is really there.
    canvas.on("text:changed", (e) => {
      // Typing changes which characters are selected without firing
      // text:selection:changed (updateFromTextArea assigns the indices directly), so the
      // panel has to be nudged from here too or it would keep showing the style of the
      // characters that *used* to be selected.
      refreshSelection();
      const text = (e.target as fabric.FabricText | undefined)?.text;
      if (text && containsEmoji(text)) syncCanvasFonts(canvas);
    });

    // Per-character formatting: the right sidebar reads the style of whatever characters
    // are selected right now, so it has to re-render as the selection moves. These only
    // bump the counter — deliberately no reading of selectionStart/End here, because the
    // public setSelectionStart/End setters fire this event *before* assigning the new
    // value. The panel reads the live object when it renders, which Preact schedules
    // after the current call stack, so it always sees the settled indices.
    canvas.on("text:selection:changed", () => {
      if (activeCanvasIdRef.current === pageId) refreshSelection();
    });
    canvas.on("text:editing:entered", () => {
      if (activeCanvasIdRef.current === pageId) refreshSelection();
    });
    canvas.on("text:editing:exited", () => {
      if (activeCanvasIdRef.current === pageId) refreshSelection();
    });

    // Drag-to-center snap, gated by showGuides (see snapConfigRef above). object:modified
    // fires after the drag ends and already saves history above, so a snapped position is
    // captured for undo with no extra work.
    installCenterSnapping(canvas, () => snapConfigRef.current, (axes) => reportSnap(pageId, axes));

    // Initial history snapshot
    setTimeout(() => {
      if (historySealedRef.current.has(pageId)) return;
      const json = withoutLogo(canvas, () => JSON.stringify(canvas.toJSON()));
      historyMapRef.current.set(pageId, { entries: [json], index: 0 });
      updateUndoRedoState(pageId);
    }, 100);
  }, [saveHistory, updateUndoRedoState, refreshSelection, reportSnap]);

  /** El canvas de una página concreta. "Rehacer plantilla" siempre actúa sobre la página
   *  principal del diseño, que no tiene por qué ser la que el operador esté mirando. */
  const getCanvasForPage = useCallback(
    (pageId: string) => canvasMapRef.current.get(pageId) ?? null,
    []
  );

  const unregisterCanvas = useCallback((pageId: string) => {
    canvasMapRef.current.delete(pageId);
    historyMapRef.current.delete(pageId);
  }, []);

  const setActiveCanvas = useCallback((pageId: string) => {
    const prevId = activeCanvasIdRef.current;
    if (prevId === pageId) return;

    // Clear selection on previous canvas
    if (prevId) {
      const prevCanvas = canvasMapRef.current.get(prevId);
      if (prevCanvas) {
        prevCanvas.discardActiveObject();
        prevCanvas.requestRenderAll();
      }
    }

    activeCanvasIdRef.current = pageId;
    setActiveCanvasId(pageId);
    setSelectedObject(null);
    updateUndoRedoState(pageId);
  }, [updateUndoRedoState]);

  // ── Text ────────────────────────────────────────────────────────────

  // Canvas-parameterized so page-canvas.tsx can target a specific (not necessarily
  // "active") canvas right after it finishes loading its saved JSON — see
  // applyBackgroundToCanvas below for why that sequencing matters.
  const applyTextToCanvas = useCallback(
    (canvas: fabric.Canvas, preset: "heading" | "subheading" | "body", customText?: string) => {
      const cfg = TEXT_PRESETS[preset];
      const text = new fabric.Textbox(customText || cfg.text, {
        left: canvasWidth / 2 - 200,
        top: canvasHeight / 2 - 30,
        width: 400,
        fontSize: cfg.fontSize,
        fontWeight: cfg.fontWeight,
        fontFamily: cfg.fontFamily,
        fill: "#ffffff",
        textAlign: "center",
        editable: true,
      });
      canvas.add(text);
      canvas.setActiveObject(text);
      canvas.requestRenderAll();
      // The preset's font is almost certainly not fetched yet on a fresh page, so the
      // box would otherwise be sized from fallback metrics (see lib/fonts.ts).
      syncCanvasFonts(canvas);
    },
    [canvasWidth, canvasHeight]
  );

  const addText = useCallback(
    (preset: "heading" | "subheading" | "body", customText?: string) => {
      const canvas = getActiveCanvas();
      if (!canvas) return;
      applyTextToCanvas(canvas, preset, customText);
    },
    [getActiveCanvas, applyTextToCanvas]
  );

  // ── Shapes ──────────────────────────────────────────────────────────

  const addShape = useCallback(
    (type: "rect" | "circle" | "line" | "triangle") => {
      const canvas = getActiveCanvas();
      if (!canvas) return;
      let obj: fabric.FabricObject;
      const cx = canvasWidth / 2;
      const cy = canvasHeight / 2;

      switch (type) {
        case "rect":
          obj = new fabric.Rect({
            left: cx - 75,
            top: cy - 75,
            width: 150,
            height: 150,
            rx: 8,
            ry: 8,
            ...SHAPE_DEFAULTS,
          });
          break;
        case "circle":
          obj = new fabric.Circle({
            left: cx - 60,
            top: cy - 60,
            radius: 60,
            ...SHAPE_DEFAULTS,
          });
          break;
        case "triangle":
          obj = new fabric.Triangle({
            left: cx - 60,
            top: cy - 60,
            width: 120,
            height: 120,
            ...SHAPE_DEFAULTS,
          });
          break;
        case "line":
          obj = new fabric.Line([cx - 100, cy, cx + 100, cy], {
            stroke: "#6366f1",
            strokeWidth: 3,
            fill: "",
          });
          break;
        default:
          return;
      }
      canvas.add(obj);
      canvas.setActiveObject(obj);
      canvas.requestRenderAll();
    },
    [getActiveCanvas, canvasWidth, canvasHeight]
  );

  // ── Images ──────────────────────────────────────────────────────────

  const addImage = useCallback(
    async (url: string) => {
      const canvas = getActiveCanvas();
      if (!canvas) return;
      try {
        const img = await fabric.FabricImage.fromURL(url, { crossOrigin: "anonymous" });
        const scale = Math.min(
          (canvasWidth * 0.6) / (img.width || 1),
          (canvasHeight * 0.6) / (img.height || 1),
          1
        );
        img.set({
          left: canvasWidth / 2 - ((img.width || 0) * scale) / 2,
          top: canvasHeight / 2 - ((img.height || 0) * scale) / 2,
          scaleX: scale,
          scaleY: scale,
        });
        canvas.add(img);
        canvas.setActiveObject(img);
        canvas.requestRenderAll();
      } catch (e) {
        console.error("Failed to load image:", e);
      }
    },
    [getActiveCanvas, canvasWidth, canvasHeight]
  );

  // ── Background ──────────────────────────────────────────────────────

  // Scales+centers a background image to fill (cover) or fit inside (contain) the
  // canvas, instead of the old independent scaleX/scaleY stretch.
  const fitBackgroundImage = (
    img: fabric.FabricImage,
    width: number,
    height: number,
    fit: "cover" | "contain"
  ) => {
    const imgWidth = img.width || 1;
    const imgHeight = img.height || 1;
    const scale =
      fit === "cover" ? Math.max(width / imgWidth, height / imgHeight) : Math.min(width / imgWidth, height / imgHeight);
    img.set({
      scaleX: scale,
      scaleY: scale,
      left: (width - imgWidth * scale) / 2,
      top: (height - imgHeight * scale) / 2,
    });
  };

  // Canvas-parameterized so page-canvas.tsx can refresh the source image on a specific
  // page right after its saved JSON finishes loading (loadFromJSON replaces the whole
  // canvas content, so anything added before it resolves would just get wiped — this
  // must run strictly after, not through the "whichever canvas is active" indirection
  // that setBackground below uses, which has no such ordering guarantee).
  const applyBackgroundToCanvas = useCallback(
    (
      canvas: fabric.Canvas,
      pageId: string,
      type: "color" | "gradient" | "image",
      value: string,
      fit: "cover" | "contain" = "cover",
      options?: { preserveFraming?: boolean; pageWidth?: number; pageHeight?: number }
    ) => {
      // El tamaño puede venir dado por el llamante en vez de leerse del estado del hook.
      // page-canvas.tsx captura este callback una sola vez (efecto con deps []) y lo usa
      // dentro de continuaciones asíncronas, así que para un diseño que no mide 1080×1080
      // —los eventos nacen a 1080×1350— leer el estado daría el tamaño *inicial* y el
      // `cover` se calcularía contra un cuadrado, dejando una franja muerta abajo.
      const pageW = options?.pageWidth ?? canvasWidth;
      const pageH = options?.pageHeight ?? canvasHeight;
      if (type === "color" || type === "gradient") {
        canvas.backgroundColor = value;
        canvas.requestRenderAll();
        saveHistory(pageId);
      } else if (type === "image") {
        return fabric.FabricImage.fromURL(value, { crossOrigin: "anonymous" }).then((img) => {
          // Camera-sized photos have to be brought under the filter pipeline's texture
          // limit before anything else touches them, or blur/darken silently blank out
          // whatever sticks past 4096 px — see lib/background.ts.
          downscaleOversizedSource(img);

          // findBackgroundImage (not a raw `_isBgImage` lookup) so a background restored
          // from a design saved before the marker was serialized is still recognised and
          // replaced, instead of leaving a stale copy underneath.
          const previous = findBackgroundImage(canvas);

          // The Twenty refresh runs on *every* open (§9.4), so re-fitting unconditionally
          // would throw away the operator's manual framing every time they reopened a
          // draft — making a movable background pointless. Keep their transform when the
          // incoming image has the same natural size as the one being replaced (same
          // photo re-fetched, or a swap where the old transform is still geometrically
          // meaningful); fall back to a clean fit when the dimensions differ, since then
          // the old position/scale describes a different picture. An explicit upload from
          // the sidebar doesn't pass preserveFraming, so it always gets a fresh fit.
          const canKeepFraming =
            options?.preserveFraming &&
            previous &&
            previous.width === img.width &&
            previous.height === img.height;

          if (canKeepFraming) {
            img.set({
              left: previous.left,
              top: previous.top,
              scaleX: previous.scaleX,
              scaleY: previous.scaleY,
            });
            (img as any)._bgFit = (previous as any)._bgFit ?? fit;
            // Same reasoning as the framing: the blur/darken the operator dialled in for
            // legibility is their work, and the automatic refresh replacing the image
            // object must not silently throw it away.
            if (previous.filters?.length) {
              img.filters = previous.filters;
              img.applyFilters();
            }
          } else {
            fitBackgroundImage(img, pageW, pageH, fit);
            (img as any)._bgFit = fit;
          }

          // Movable/resizable so the operator can reframe it — see lib/background.ts.
          makeBackgroundInteractive(img);
          if (previous) canvas.remove(previous);
          (img as any)._isBgImage = true;
          img.setCoords();
          canvas.add(img);
          canvas.sendObjectToBack(img);
          canvas.requestRenderAll();
          saveHistory(pageId);
        });
      }
    },
    [canvasWidth, canvasHeight, saveHistory]
  );

  const setBackground = useCallback(
    (type: "color" | "gradient" | "image", value: string, fit: "cover" | "contain" = "cover") => {
      const canvas = getActiveCanvas();
      const pageId = activeCanvasIdRef.current;
      if (!canvas || !pageId) return;
      applyBackgroundToCanvas(canvas, pageId, type, value, fit);
    },
    [getActiveCanvas, applyBackgroundToCanvas]
  );

  // Re-fits the current background image (if any) without re-uploading it. Doubles as the
  // "reset framing" escape hatch now that the background can be dragged around by hand.
  const setBackgroundImageFit = useCallback(
    (fit: "cover" | "contain") => {
      const canvas = getActiveCanvas();
      const pageId = activeCanvasIdRef.current;
      if (!canvas || !pageId) return;
      const bgObj = findBackgroundImage(canvas);
      if (!bgObj) return;
      fitBackgroundImage(bgObj, canvasWidth, canvasHeight, fit);
      (bgObj as any)._bgFit = fit;
      bgObj.setCoords();
      canvas.requestRenderAll();
      saveHistory(pageId);
    },
    [getActiveCanvas, canvasWidth, canvasHeight, saveHistory]
  );

  // Resizes the background from the panel. Needed as well as the on-canvas handles: a
  // photo wide enough to cover the page can extend past even the workspace margin, which
  // puts its corner handles out of reach (see lib/workspace.ts).
  const setBackgroundScale = useCallback(
    (scale: number) => {
      const canvas = getActiveCanvas();
      const pageId = activeCanvasIdRef.current;
      if (!canvas || !pageId) return;
      const bgObj = findBackgroundImage(canvas);
      if (!bgObj) return;
      scaleAboutPageCenter(bgObj, scale, canvasWidth, canvasHeight);
      canvas.requestRenderAll();
      saveHistory(pageId);
      refreshSelection();
    },
    [getActiveCanvas, canvasWidth, canvasHeight, saveHistory, refreshSelection]
  );

  // ── Background effects (text legibility over photos) ────────────────

  const [backgroundEffects, setBackgroundEffectsState] = useState<BackgroundEffects>(NO_EFFECTS);
  const [scrim, setScrimState] = useState<{ kind: ScrimKind; opacity: number }>({
    kind: "none",
    opacity: 0.4,
  });

  /** Re-reads the effect values off the canvas, so the panel reflects a loaded design. */
  const syncEffectsFromCanvas = useCallback(
    (canvas: fabric.Canvas) => {
      setBackgroundEffectsState(readBackgroundEffects(canvas));
      setScrimState(readScrim(canvas));
    },
    []
  );

  const setBackgroundEffects = useCallback(
    (effects: BackgroundEffects) => {
      const canvas = getActiveCanvas();
      const pageId = activeCanvasIdRef.current;
      if (!canvas || !pageId) return;
      setBackgroundEffectsState(effects);
      if (applyBackgroundEffects(canvas, effects)) saveHistory(pageId);
    },
    [getActiveCanvas, saveHistory]
  );

  const setScrim = useCallback(
    (kind: ScrimKind, opacity: number) => {
      const canvas = getActiveCanvas();
      const pageId = activeCanvasIdRef.current;
      if (!canvas || !pageId) return;
      setScrimState({ kind, opacity });
      // Se conserva el tono que hubiera puesto el tema de la plantilla: tocar la
      // intensidad del velo desde el panel Bg no debe devolverlo a oscuro y arruinar un
      // diseño de tinta oscura.
      applyScrim(canvas, canvasWidth, canvasHeight, kind, opacity, readScrim(canvas).tone);
      saveHistory(pageId);
    },
    [getActiveCanvas, canvasWidth, canvasHeight, saveHistory]
  );

  // ── "Mejorar": the local-news recipe, applied deterministically ─────
  // See lib/enhance.ts for why this is filters and type settings rather than a round trip
  // through an image model.

  /** Photo half: sharpen, contrast, a light darkening and an even veil. */
  const enhancePhoto = useCallback(() => {
    const canvas = getActiveCanvas();
    const pageId = activeCanvasIdRef.current;
    if (!canvas || !pageId) return false;
    if (!findBackgroundImage(canvas)) return false;

    const { scrimKind, scrimOpacity, ...effects } = PHOTO_RECIPE;
    setBackgroundEffectsState(effects);
    applyBackgroundEffects(canvas, effects);
    setScrimState({ kind: scrimKind, opacity: scrimOpacity });
    applyScrim(canvas, canvasWidth, canvasHeight, scrimKind, scrimOpacity);
    saveHistory(pageId);
    return true;
  }, [getActiveCanvas, canvasWidth, canvasHeight, saveHistory]);

  /** Type half: heavy white sans, uppercase, tightened, shadowed and centred on the page. */
  const enhanceHeadline = useCallback(() => {
    const canvas = getActiveCanvas();
    const pageId = activeCanvasIdRef.current;
    if (!canvas || !pageId || !isTextObject(selectedObject)) return false;
    const obj = selectedObject;

    const { props, width } = headlineRecipe(canvasWidth);
    const upper = uppercaseText(obj.text ?? "");
    // Always the whole box, never the selected word: this is a layout preset, and applying
    // it to a range would leave the rest of the headline in the old face and size.
    obj.set({ ...props, width } as Partial<fabric.FabricObject>);
    if (upper) obj.set({ text: upper } as Partial<fabric.FabricObject>);
    obj.dirty = true;
    // Re-measure before centring: the new size and width change how the text wraps, and the
    // vertical centre depends on the height that comes out of that.
    obj.initDimensions();
    centreOnPage(obj, canvasWidth, canvasHeight);
    canvas.requestRenderAll();
    saveHistory(pageId);
    refreshSelection();

    // Montserrat 800 has almost certainly never been fetched, so what was just measured is
    // the fallback's metrics (lib/fonts.ts). Re-centre once the real face lands.
    syncCanvasFonts(canvas).then(() => {
      obj.initDimensions();
      centreOnPage(obj, canvasWidth, canvasHeight);
      canvas.requestRenderAll();
      refreshSelection();
    });
    return true;
  }, [getActiveCanvas, selectedObject, canvasWidth, canvasHeight, saveHistory, refreshSelection]);

  // ── Plantilla de eventos ────────────────────────────────────────────

  /**
   * Compone (o recompone) la plantilla de un evento sobre un canvas concreto.
   *
   * Parametrizado por canvas y no por "el canvas activo" por el mismo motivo que
   * `applyBackgroundToCanvas` (ver arriba): page-canvas.tsx tiene que encadenarlo
   * justo después de que el fondo termine de cargar, y esa indirección no da ninguna
   * garantía de orden. El tamaño de página también se pasa explícito — el estado del
   * hook puede ir un render por detrás cuando el diseño no mide 1080×1080.
   *
   * `seal` distingue los dos usos: la composición automática es el *estado inicial* del
   * documento, así que deja el historial con una sola entrada (deshacer hasta una página
   * en blanco no es un estado útil); "Rehacer plantilla" es una acción del operador y deja
   * una entrada más, de modo que Ctrl+Z devuelve exactamente lo que había antes del clic.
   */
  const composeEventOnCanvas = useCallback(
    async (
      canvas: fabric.Canvas,
      pageId: string,
      copy: EventCopy,
      opts: {
        pageWidth: number;
        pageHeight: number;
        mode?: EventLayoutMode;
        theme?: EventTheme;
        seal?: boolean;
      }
    ): Promise<EventLayoutMode | null> => {
      // Una composición añade y quita cerca de diez objetos; sin esto cada uno sería un
      // paso de deshacer y Ctrl+Z iría desmontando la plantilla pieza a pieza.
      isRestoringRef.current.add(pageId);
      let mode: EventLayoutMode | null = null;
      try {
        mode = await composeEventTemplate(canvas, copy, {
          pageWidth: opts.pageWidth,
          pageHeight: opts.pageHeight,
          mode: opts.mode,
          theme: opts.theme,
        });
      } catch (e) {
        console.error("No se pudo componer la plantilla del evento:", e);
      } finally {
        isRestoringRef.current.delete(pageId);
        if (opts.seal) {
          historySealedRef.current.add(pageId);
          const json = withoutLogo(canvas, () => JSON.stringify(canvas.toJSON()));
          historyMapRef.current.set(pageId, { entries: [json], index: 0 });
        } else {
          saveHistory(pageId);
        }
        updateUndoRedoState(pageId);
      }
      // El modo fija el desenfoque y el velo del fondo; sin esto los deslizadores del panel
      // Bg seguirían enseñando los valores anteriores y mentirían sobre lo que hay puesto.
      syncEffectsFromCanvas(canvas);
      return mode;
    },
    [saveHistory, updateUndoRedoState, syncEffectsFromCanvas]
  );

  // ── Object manipulation ─────────────────────────────────────────────

  const updateSelectedObject = useCallback(
    (props: Record<string, unknown>) => {
      const canvas = getActiveCanvas();
      const pageId = activeCanvasIdRef.current;
      if (!canvas || !selectedObject || !pageId) return;

      selectedObject.set(props as Partial<fabric.FabricObject>);
      // Fabric re-measures text itself for layout properties, but the *controls* keep the
      // coordinates they were drawn with until setCoords() runs — that's what left the
      // selection box lagging a size behind the glyphs after every change.
      selectedObject.setCoords();
      canvas.requestRenderAll();
      saveHistory(pageId);
      refreshSelection();

      // Switching to a font that hasn't been fetched yet measures against the fallback
      // (see lib/fonts.ts), so re-measure once the real face is in.
      if ("fontFamily" in props || "fontWeight" in props) {
        syncCanvasFonts(canvas).then(() => {
          selectedObject.setCoords();
          canvas.requestRenderAll();
          refreshSelection();
        });
      }
    },
    [getActiveCanvas, selectedObject, saveHistory, refreshSelection]
  );

  /**
   * The single way text formatting gets written, and the reason a word can be styled on
   * its own instead of the whole box.
   *
   * With characters selected while editing, the properties Fabric can hold per character
   * go to just those characters (`setSelectionStyles`); anything else in the same call —
   * `paintFirst` and friends from the outline controls — still lands on the object,
   * because Fabric has nowhere else to put it. With no selection it falls through to
   * `updateSelectedObject`, so every control keeps its old whole-box behaviour when
   * nothing is highlighted. See lib/text-styles.ts for the rules.
   *
   * Note that a whole-box write deliberately does *not* wipe existing per-character
   * overrides: Fabric renders the character value over the object one, so a word coloured
   * by hand stays that colour. Clearing it is what `clearTextStyle` is for.
   */
  const applyTextStyle = useCallback(
    (props: Record<string, unknown>) => {
      const canvas = getActiveCanvas();
      const pageId = activeCanvasIdRef.current;
      if (!canvas || !pageId || !selectedObject) return;

      const range = textRange(selectedObject);
      if (!range || !isTextObject(selectedObject)) {
        updateSelectedObject(props);
        return;
      }
      const obj = selectedObject;

      const [perChar, onObject] = splitTextStyleProps(props);
      if (Object.keys(onObject).length > 0) obj.set(onObject as Partial<fabric.FabricObject>);
      if (Object.keys(perChar).length > 0) {
        obj.setSelectionStyles(perChar, range.start, range.end);
      }

      const keys = Object.keys(props);
      // setSelectionStyles mutates the styles map straight through, without going near
      // set(), so it never marks the object dirty — and a cached object is re-blitted from
      // the bitmap it was last drawn into. The word kept its old colour on screen until
      // something else happened to invalidate the cache, which made it look as though only
      // size and font worked (those call initDimensions, which does invalidate it).
      obj.dirty = true;
      // Same order, and for the same reason, as everywhere else in this hook: Fabric
      // re-measures on its own but the controls keep the coordinates they were drawn with
      // until setCoords() runs, which is what left the selection box a size behind.
      if (changesMetrics(keys)) obj.initDimensions();
      obj.setCoords();
      canvas.requestRenderAll();
      // Clicking a panel control blurs Fabric's hidden textarea, which stops the caret
      // animation and wipes the highlight off the upper canvas. Editing itself survives
      // (blur() only aborts that animation), so repainting brings the highlighted word
      // back and the operator can keep formatting the same selection.
      obj.renderCursorOrSelection();
      saveHistory(pageId);
      refreshSelection();

      if (changesFontFace(keys)) {
        // A weight or family that was never fetched measures against the fallback (see
        // lib/fonts.ts). collectUsedFaces already walks per-character styles, so a
        // per-range font change is picked up without any extra work here.
        syncCanvasFonts(canvas).then(() => {
          obj.setCoords();
          canvas.requestRenderAll();
          obj.renderCursorOrSelection();
          refreshSelection();
        });
      }
    },
    [getActiveCanvas, selectedObject, saveHistory, refreshSelection, updateSelectedObject]
  );

  /**
   * Drops per-character overrides so the text falls back to the box's own values: from the
   * selected characters if there are any, from the whole box otherwise. The escape hatch
   * for "I coloured a word and now I want it back to normal".
   */
  const clearTextStyle = useCallback(() => {
    const canvas = getActiveCanvas();
    const pageId = activeCanvasIdRef.current;
    if (!canvas || !pageId || !isTextObject(selectedObject)) return;
    const obj = selectedObject;
    const range = textRange(obj);

    if (range) {
      // Writing `undefined` deletes the override rather than storing one — Fabric filters
      // the merged declaration through pickBy(v => v !== undefined). See lib/text-styles.ts.
      obj.setSelectionStyles(BLANK_STYLE, range.start, range.end);
    } else {
      for (const prop of STYLE_PROPERTIES) obj.removeStyle(prop);
    }

    // removeStyle doesn't set the _forceClearCache flag that setSelectionStyles does, so
    // the re-measure has to be explicit on both paths — as does invalidating the object's
    // cached bitmap, which neither of them touches.
    obj.dirty = true;
    obj.initDimensions();
    obj.setCoords();
    canvas.requestRenderAll();
    obj.renderCursorOrSelection();
    saveHistory(pageId);
    refreshSelection();

    syncCanvasFonts(canvas).then(() => {
      obj.setCoords();
      canvas.requestRenderAll();
      refreshSelection();
    });
  }, [getActiveCanvas, selectedObject, saveHistory, refreshSelection]);

  /**
   * Hands keyboard focus back to the text box after a panel field that needed it is done
   * with it — Fabric does the same on canvas click. Editing survives the field taking
   * focus, so the styling works either way, but without this the arrow keys would keep
   * going to the field and the operator couldn't extend the selection to the next word
   * without clicking the canvas again.
   *
   * Only safe to call once the field has committed (change/blur), never on every
   * keystroke: pulling focus mid-input would make the field impossible to type in.
   */
  const restoreTextFocus = useCallback(() => {
    if (isTextObject(selectedObject) && selectedObject.isEditing) {
      // preventScroll is not optional here. Fabric parks its hidden textarea at the text's
      // position on the page, which for a zoomed-in design sits outside the viewport, and
      // a plain focus() scrolls the whole document to reveal it. That fires while the
      // pointer is still down on whatever control triggered this, so the button slides out
      // from under the cursor and never receives its click — pressing Save right after
      // editing a colour silently did nothing.
      selectedObject.hiddenTextarea?.focus({ preventScroll: true });
    }
  }, [selectedObject]);

  // Toggles bold. The branching lives in applyTextStyle now; what's left here is the only
  // bold-specific part — deciding which way to flip when the selection is mixed. The rule
  // is the usual one: unless every selected character is already bold, make them all bold.
  const toggleBold = useCallback(() => {
    if (!isTextObject(selectedObject)) return;
    const weight = summarizeTextStyle(selectedObject, textRange(selectedObject)).fontWeight;
    const allBold = !weight.mixed && (weight.value === "700" || weight.value === 700 || weight.value === "bold");
    applyTextStyle({ fontWeight: allBold ? "400" : "700" });
  }, [selectedObject, applyTextStyle]);

  // Inserts an emoji into the selected text: at the cursor (replacing the selected range)
  // if the box is being edited, appended otherwise. The picker exists because the OS
  // keyboard shortcut for emoji is not something every operator knows, and because on the
  // canvas there is nowhere else to paste one from.
  const insertEmoji = useCallback(
    (emoji: string) => {
      const canvas = getActiveCanvas();
      const pageId = activeCanvasIdRef.current;
      if (!canvas || !pageId || !selectedObject) return;
      if (!(selectedObject instanceof fabric.Textbox || selectedObject instanceof fabric.IText)) return;
      const obj = selectedObject as fabric.IText;

      if (obj.isEditing) {
        const start = obj.selectionStart ?? obj._text.length;
        const end = obj.selectionEnd ?? start;
        obj.insertChars(emoji, undefined, start, end);
        // Move the caret past what was inserted, counting GRAPHEMES: an emoji is several
        // code units, and using the raw string length would drop the caret in the middle
        // of one. Then re-sync Fabric's hidden textarea, or the next keystroke would be
        // applied against the stale text it still holds.
        const inserted = obj.graphemeSplit(emoji).length;
        obj.selectionStart = obj.selectionEnd = Math.min(start + inserted, obj._text.length);
        if (obj.hiddenTextarea) obj.hiddenTextarea.value = obj.text;
        obj._updateTextarea();
      } else {
        obj.set({ text: (obj.text ?? "") + emoji } as any);
        obj.initDimensions?.();
      }

      obj.setCoords();
      canvas.requestRenderAll();
      saveHistory(pageId);
      refreshSelection();

      // First emoji on the canvas = the emoji font is only being fetched now, so what was
      // just measured is a placeholder's width (see lib/fonts.ts).
      syncCanvasFonts(canvas).then(() => {
        obj.setCoords();
        canvas.requestRenderAll();
        refreshSelection();
      });
    },
    [getActiveCanvas, selectedObject, saveHistory, refreshSelection]
  );

  const deleteSelected = useCallback(() => {
    const canvas = getActiveCanvas();
    if (!canvas) return;
    const active = canvas.getActiveObjects();
    if (active.length === 0) return;
    active.forEach((obj) => canvas.remove(obj));
    canvas.discardActiveObject();
    canvas.requestRenderAll();
  }, [getActiveCanvas]);

  // ── Undo / Redo ─────────────────────────────────────────────────────

  const restoreFromHistory = useCallback(
    (index: number) => {
      const pageId = activeCanvasIdRef.current;
      const canvas = getActiveCanvas();
      if (!canvas || !pageId) return;
      const hist = historyMapRef.current.get(pageId);
      if (!hist || index < 0 || index >= hist.entries.length) return;
      isRestoringRef.current.add(pageId);
      hist.index = index;
      const json = hist.entries[index];
      canvas.loadFromJSON(JSON.parse(json)).then(async () => {
        // loadFromJSON wipes the clip path (see applyWorkspaceClip) — without this, undo
        // left the design painting across the whole workspace and the page disappeared.
        applyWorkspaceClip(canvas, canvasWidth, canvasHeight);
        // The background is rebuilt from its saved URL, i.e. at full resolution again.
        normalizeBackgroundSource(canvas);
        await applyLogoToCanvas(canvas, canvasWidth, canvasHeight);
        canvas.requestRenderAll();
        syncCanvasFonts(canvas);
        isRestoringRef.current.delete(pageId);
        updateUndoRedoState(pageId);
      });
    },
    [getActiveCanvas, updateUndoRedoState, canvasWidth, canvasHeight]
  );

  const undo = useCallback(() => {
    const pageId = activeCanvasIdRef.current;
    if (!pageId) return;
    const hist = historyMapRef.current.get(pageId);
    if (!hist) return;
    restoreFromHistory(hist.index - 1);
  }, [restoreFromHistory]);

  const redo = useCallback(() => {
    const pageId = activeCanvasIdRef.current;
    if (!pageId) return;
    const hist = historyMapRef.current.get(pageId);
    if (!hist) return;
    restoreFromHistory(hist.index + 1);
  }, [restoreFromHistory]);

  // ── Canvas size ─────────────────────────────────────────────────────

  const setCanvasSize = useCallback(
    (width: number, height: number) => {
      setCanvasWidth(width);
      setCanvasHeight(height);
      // Resize all canvases (page + workspace margin, and re-clip to the new page size)
      for (const canvas of canvasMapRef.current.values()) {
        applyWorkspaceGeometry(canvas, width, height);
        applyLogoToCanvas(canvas, width, height);
        // The scrim covers the page, so it has to follow the page's new size.
        resizeScrim(canvas, width, height);
        // El fondo estaba encajado contra la página anterior: al pasar de cuadrado a
        // historia se quedaría cubriendo poco más de la mitad. Se reencaja con el mismo
        // modo (cover/contain) que tuviera. Sí, esto descarta un reencuadre manual — pero
        // ese encuadre describía una página que ya no existe.
        const bg = findBackgroundImage(canvas);
        if (bg) {
          fitBackgroundImage(bg, width, height, ((bg as any)._bgFit as "cover" | "contain") ?? "cover");
          bg.setCoords();
        }
        // Y la plantilla de eventos se re-apila contra el nuevo borde inferior.
        relayoutEventTemplate(canvas, width, height);
        canvas.requestRenderAll();
      }
    },
    []
  );

  /** El tamaño vigente, para que `useDesigns` pueda persistirlo con el diseño. Lee de un
   *  ref, no del estado, para no quedarse un render por detrás (ver arriba). */
  const getCanvasSize = useCallback(() => canvasSizeRef.current, []);

  // ── Zoom ────────────────────────────────────────────────────────────

  const zoomToFit = useCallback(() => {
    setZoom(fitScale);
  }, [fitScale]);

  const zoomIn = useCallback(() => {
    setZoom((z) => Math.min(z * 1.2, 3));
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((z) => Math.max(z / 1.2, 0.05));
  }, []);

  // ── Export ──────────────────────────────────────────────────────────

  // Renders the active canvas at 2x straight to a Blob.
  //
  // Deliberately uses Fabric's own `toBlob` instead of the old
  // `toDataURL()` + `fetch(dataURL)` round-trip: fetching a `data:` URL counts as a
  // connection under CSP `connect-src`, and our own policy (Fase 3, §10.3) only allows
  // `'self' ws: wss:`. So in production that fetch was blocked by the browser and
  // rejected with a bare `TypeError: Failed to fetch` — the request never even left the
  // page, which is why the server logs showed no trace of it at all. It never reproduced
  // in dev because there the HTML is served by Vite on :5173, without our CSP header
  // (see §10.3) — anything CSP-related has to be tested against a production build.
  //
  // Going straight to a Blob also avoids holding a base64 copy of the whole 2x image in
  // memory, which for a photo-heavy design is several MB of string on top of the bitmap.
  const exportBlob = useCallback(
    async (options?: { format?: "png" | "jpeg"; quality?: number }): Promise<Blob | null> => {
      const canvas = getActiveCanvas();
      if (!canvas) return null;
      const activeObj = canvas.getActiveObject();
      canvas.discardActiveObject();
      canvas.requestRenderAll();

      try {
        return await canvas.toBlob({
          format: options?.format ?? "png",
          multiplier: 2,
          quality: options?.quality ?? 1,
          // The canvas is bigger than the page now (workspace margin, see lib/workspace.ts)
          // — crop back to exactly the page so the export is unchanged by that.
          ...pageExportCrop(canvasWidth, canvasHeight),
        });
      } finally {
        if (activeObj) {
          canvas.setActiveObject(activeObj);
          canvas.requestRenderAll();
        }
      }
    },
    [getActiveCanvas, canvasWidth, canvasHeight]
  );

  const exportPNG = useCallback(async () => {
    const blob = await exportBlob({ format: "png" });
    if (!blob) return;
    // Same reasoning as above: a blob: URL for the download link instead of a multi-MB
    // data: URL. Revoked on a delay so the browser has started the download first.
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = "design.png";
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, [exportBlob]);

  // JPEG, not PNG: this feeds "Guardar en Twenty", and the canvas background is always
  // opaque (color or a cover/contain-fit image), so there's no transparency to lose.
  // A 2x PNG export of a photo-heavy design can run 5-10+ MB; the same design as JPEG is
  // typically a fraction of that with no visible quality loss — much less likely to trip
  // upload size caps, proxy limits, or the container's memory budget in production.
  const exportUploadBlob = useCallback(
    (): Promise<Blob | null> => exportBlob({ format: "jpeg", quality: 0.92 }),
    [exportBlob]
  );

  // ── Serialization ───────────────────────────────────────────────────

  const getCanvasJSON = useCallback(() => {
    const canvas = getActiveCanvas();
    if (!canvas) return "{}";
    return withoutLogo(canvas, () => JSON.stringify(canvas.toJSON()));
  }, [getActiveCanvas]);

  const getCanvasJSONForPage = useCallback((pageId: string) => {
    const canvas = canvasMapRef.current.get(pageId);
    if (!canvas) return "{}";
    return withoutLogo(canvas, () => JSON.stringify(canvas.toJSON()));
  }, []);

  const loadTemplate = useCallback(
    (template: Template) => {
      setCanvasWidth(template.width);
      setCanvasHeight(template.height);
      // Template loading — resize all canvases to new dimensions
      const dpr = window.devicePixelRatio || 1;
      for (const canvas of canvasMapRef.current.values()) {
        canvas.setDimensions(
          { width: template.width * dpr, height: template.height * dpr },
          { cssOnly: false }
        );
        canvas.setDimensions({ width: template.width, height: template.height }, { cssOnly: true });
        canvas.setViewportTransform([dpr, 0, 0, dpr, 0, 0]);
      }
      // Load template JSON onto active canvas
      const canvas = getActiveCanvas();
      const pageId = activeCanvasIdRef.current;
      if (canvas && pageId) {
        isRestoringRef.current.add(pageId);
        canvas.loadFromJSON(JSON.parse(template.canvas_json)).then(async () => {
          applyWorkspaceClip(canvas, template.width, template.height);
          normalizeBackgroundSource(canvas);
          await applyLogoToCanvas(canvas, template.width, template.height);
          canvas.requestRenderAll();
          syncCanvasFonts(canvas);
          isRestoringRef.current.delete(pageId);
          historyMapRef.current.set(pageId, {
            entries: [withoutLogo(canvas, () => JSON.stringify(canvas.toJSON()))],
            index: 0,
          });
          updateUndoRedoState(pageId);
        });
      }
    },
    [getActiveCanvas, updateUndoRedoState]
  );

  // ── Keyboard shortcuts ──────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (meta && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        redo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && !isTextEditing()) {
        e.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo, deleteSelected]);

  function isTextEditing(): boolean {
    const canvas = getActiveCanvas();
    if (!canvas) return false;
    const obj = canvas.getActiveObject();
    return obj instanceof fabric.Textbox && obj.isEditing === true;
  }

  return {
    // Canvas map management
    registerCanvas,
    unregisterCanvas,
    setActiveCanvas,
    activeCanvasId,
    canvasMap: canvasMapRef,
    // For backward compat (right-sidebar uses canvas directly)
    get canvas() {
      return getActiveCanvas();
    },
    selectedObject,
    // Consumers don't read this directly — it exists so a mutation of the (stable)
    // selected object still produces a state change and re-renders the panels.
    selectionVersion,
    canvasWidth,
    canvasHeight,
    zoom,
    setZoomRaw: setZoom,
    fitScale,
    setFitScale,
    showGuides,
    toggleGuides: () => setShowGuides((v) => !v),
    snapAxes,
    addText,
    applyTextToCanvas,
    addShape,
    addImage,
    setBackground,
    applyBackgroundToCanvas,
    setBackgroundImageFit,
    setBackgroundScale,
    backgroundEffects,
    setBackgroundEffects,
    scrim,
    setScrim,
    syncEffectsFromCanvas,
    enhancePhoto,
    enhanceHeadline,
    composeEventOnCanvas,
    getCanvasForPage,
    getCanvasSize,
    updateSelectedObject,
    applyTextStyle,
    clearTextStyle,
    restoreTextFocus,
    toggleBold,
    insertEmoji,
    deleteSelected,
    undo,
    redo,
    canUndo,
    canRedo,
    setCanvasSize,
    zoomToFit,
    zoomIn,
    zoomOut,
    exportPNG,
    exportUploadBlob,
    getCanvasJSON,
    getCanvasJSONForPage,
    loadTemplate,
  };
}
