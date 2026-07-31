import { useState, useCallback, useRef, useEffect } from "preact/hooks";
import * as fabric from "fabric";
import type { Template } from "../types";
import { applyLogoToCanvas, isLogoObject, withoutLogo } from "../lib/logo";

const MAX_HISTORY = 50;

// A plain `{ ...obj }` spread drops the prototype, so `instanceof fabric.Textbox` (used
// by right-sidebar.tsx to pick which properties panel to show) breaks on the very next
// render. This clones enough to give Preact a new reference (so the state update isn't
// bailed out) while keeping the object `instanceof`-correct.
function cloneWithPrototype<T extends object>(obj: T): T {
  return Object.assign(Object.create(Object.getPrototypeOf(obj)), obj);
}

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
  const [canvasWidth, setCanvasWidth] = useState(1080);
  const [canvasHeight, setCanvasHeight] = useState(1080);
  const [zoom, setZoom] = useState(0.58);
  const [fitScale, setFitScale] = useState(0.58);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const isRestoringRef = useRef<Set<string>>(new Set());

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

    // Initial history snapshot
    setTimeout(() => {
      const json = withoutLogo(canvas, () => JSON.stringify(canvas.toJSON()));
      historyMapRef.current.set(pageId, { entries: [json], index: 0 });
      updateUndoRedoState(pageId);
    }, 100);
  }, [saveHistory, updateUndoRedoState]);

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

  const addText = useCallback(
    (preset: "heading" | "subheading" | "body", customText?: string) => {
      const canvas = getActiveCanvas();
      if (!canvas) return;
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
    },
    [getActiveCanvas, canvasWidth, canvasHeight]
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

  const setBackground = useCallback(
    (type: "color" | "gradient" | "image", value: string, fit: "cover" | "contain" = "cover") => {
      const canvas = getActiveCanvas();
      const pageId = activeCanvasIdRef.current;
      if (!canvas || !pageId) return;
      if (type === "color" || type === "gradient") {
        canvas.backgroundColor = value;
        canvas.requestRenderAll();
        saveHistory(pageId);
      } else if (type === "image") {
        fabric.FabricImage.fromURL(value, { crossOrigin: "anonymous" }).then((img) => {
          fitBackgroundImage(img, canvasWidth, canvasHeight, fit);
          img.set({ selectable: false, evented: false });
          const objects = canvas.getObjects();
          const bgObj = objects.find((o) => (o as any)._isBgImage);
          if (bgObj) canvas.remove(bgObj);
          (img as any)._isBgImage = true;
          (img as any)._bgFit = fit;
          canvas.add(img);
          canvas.sendObjectToBack(img);
          canvas.requestRenderAll();
          saveHistory(pageId);
        });
      }
    },
    [getActiveCanvas, canvasWidth, canvasHeight, saveHistory]
  );

  // Re-fits the current background image (if any) without re-uploading it.
  const setBackgroundImageFit = useCallback(
    (fit: "cover" | "contain") => {
      const canvas = getActiveCanvas();
      const pageId = activeCanvasIdRef.current;
      if (!canvas || !pageId) return;
      const bgObj = canvas.getObjects().find((o) => (o as any)._isBgImage) as fabric.FabricImage | undefined;
      if (!bgObj) return;
      fitBackgroundImage(bgObj, canvasWidth, canvasHeight, fit);
      (bgObj as any)._bgFit = fit;
      canvas.requestRenderAll();
      saveHistory(pageId);
    },
    [getActiveCanvas, canvasWidth, canvasHeight, saveHistory]
  );

  // ── Object manipulation ─────────────────────────────────────────────

  const updateSelectedObject = useCallback(
    (props: Record<string, unknown>) => {
      const canvas = getActiveCanvas();
      const pageId = activeCanvasIdRef.current;
      if (!canvas || !selectedObject || !pageId) return;
      selectedObject.set(props as Partial<fabric.FabricObject>);
      canvas.requestRenderAll();
      saveHistory(pageId);
      setSelectedObject(cloneWithPrototype(selectedObject));
    },
    [getActiveCanvas, selectedObject, saveHistory]
  );

  // Toggles bold. If the object is being edited with a text range selected, applies
  // per-character styles to just that range (Fabric's setSelectionStyles); otherwise
  // toggles the whole object's fontWeight, same as the other text properties.
  const toggleBold = useCallback(() => {
    const canvas = getActiveCanvas();
    const pageId = activeCanvasIdRef.current;
    if (!canvas || !pageId || !selectedObject) return;
    if (!(selectedObject instanceof fabric.Textbox || selectedObject instanceof fabric.IText)) return;
    const obj = selectedObject as fabric.IText;

    const start = obj.selectionStart;
    const end = obj.selectionEnd;
    const hasRangeSelected = obj.isEditing && typeof start === "number" && typeof end === "number" && start !== end;

    if (hasRangeSelected) {
      const styles = obj.getSelectionStyles(start, end, true);
      const allBold = styles.length > 0 && styles.every((s) => s.fontWeight === "700" || s.fontWeight === 700);
      obj.setSelectionStyles({ fontWeight: allBold ? "400" : "700" }, start, end);
      obj.initDimensions?.();
    } else {
      const isBold = (obj as any).fontWeight === "700" || (obj as any).fontWeight === "bold";
      obj.set({ fontWeight: isBold ? "400" : "700" } as any);
    }
    canvas.requestRenderAll();
    saveHistory(pageId);
    setSelectedObject(cloneWithPrototype(obj as fabric.FabricObject));
  }, [getActiveCanvas, selectedObject, saveHistory]);

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
        await applyLogoToCanvas(canvas, canvasWidth, canvasHeight);
        canvas.requestRenderAll();
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
      // Resize all canvases
      const dpr = window.devicePixelRatio || 1;
      for (const canvas of canvasMapRef.current.values()) {
        canvas.setDimensions({ width: width * dpr, height: height * dpr }, { cssOnly: false });
        canvas.setDimensions({ width, height }, { cssOnly: true });
        canvas.setViewportTransform([dpr, 0, 0, dpr, 0, 0]);
        applyLogoToCanvas(canvas, width, height);
        canvas.requestRenderAll();
      }
    },
    []
  );

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

  const withExportDataURL = useCallback(
    <T,>(fn: (dataURL: string) => T): T | undefined => {
      const canvas = getActiveCanvas();
      if (!canvas) return undefined;
      const activeObj = canvas.getActiveObject();
      canvas.discardActiveObject();
      canvas.requestRenderAll();

      const dataURL = canvas.toDataURL({ format: "png", multiplier: 2, quality: 1 });
      const result = fn(dataURL);

      if (activeObj) {
        canvas.setActiveObject(activeObj);
        canvas.requestRenderAll();
      }
      return result;
    },
    [getActiveCanvas]
  );

  const exportPNG = useCallback(() => {
    withExportDataURL((dataURL) => {
      const link = document.createElement("a");
      link.download = "design.png";
      link.href = dataURL;
      link.click();
    });
  }, [withExportDataURL]);

  const exportPNGBlob = useCallback(async (): Promise<Blob | null> => {
    const dataURL = withExportDataURL((d) => d);
    if (!dataURL) return null;
    const res = await fetch(dataURL);
    return res.blob();
  }, [withExportDataURL]);

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
          await applyLogoToCanvas(canvas, template.width, template.height);
          canvas.requestRenderAll();
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
    canvasWidth,
    canvasHeight,
    zoom,
    setZoomRaw: setZoom,
    fitScale,
    setFitScale,
    addText,
    addShape,
    addImage,
    setBackground,
    setBackgroundImageFit,
    updateSelectedObject,
    toggleBold,
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
    exportPNGBlob,
    getCanvasJSON,
    getCanvasJSONForPage,
    loadTemplate,
  };
}
