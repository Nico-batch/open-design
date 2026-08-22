import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { Design, Template, Page } from "./types";
import type { EventCopy } from "./lib/event-fields";
import type { EventLayoutMode, EventTheme } from "./lib/event-template";
import type { NewsCopy } from "./lib/news-fields";
import type { NewsVariant } from "./lib/news-template";
import type * as fabric from "fabric";
import type { BackgroundEffects, ScrimKind } from "./lib/effects";
import type { LayerInfo } from "./lib/layers";

export interface CanvasSize {
  label: string;
  width: number;
  height: number;
}

export const CANVAS_SIZES: CanvasSize[] = [
  { label: "Instagram Feed (Square)", width: 1080, height: 1080 },
  { label: "Instagram Feed (Portrait)", width: 1080, height: 1350 },
  { label: "Instagram Story", width: 1080, height: 1920 },
];

export interface EditorContextValue {
  // Canvas (multi-canvas)
  registerCanvas: (pageId: string, canvas: fabric.Canvas) => void;
  unregisterCanvas: (pageId: string) => void;
  setActiveCanvas: (pageId: string) => void;
  activeCanvasId: string | null;
  canvas: fabric.Canvas | null;
  selectedObject: fabric.FabricObject | null;
  selectionVersion: number;

  // Capas (lib/layers.ts). Todas operan sobre la página activa.
  /** Cambia al añadir, quitar, mover, ocultar o bloquear algo — dispara el re-render del panel. */
  layersVersion: number;
  /** Las capas de arriba abajo, sin el logo. */
  getLayers: () => LayerInfo[];
  selectLayer: (obj: fabric.FabricObject) => void;
  setLayerVisibility: (obj: fabric.FabricObject, visible: boolean) => void;
  setLayerLock: (obj: fabric.FabricObject, locked: boolean) => void;
  /** Sube (`+1`) o baja (`-1`) una capa en el sentido del panel. */
  shiftLayer: (obj: fabric.FabricObject, delta: number) => void;
  /** Soltar la fila `fromRow` sobre la posición `toRow` de la lista. */
  dropLayer: (fromRow: number, toRow: number) => void;
  removeLayer: (obj: fabric.FabricObject) => void;

  canvasWidth: number;
  canvasHeight: number;
  zoom: number;
  setZoomRaw: (z: number) => void;
  fitScale: number;
  setFitScale: (s: number) => void;
  /** Center guides over the page, with drag-to-center snapping — a view setting, not part of the design. */
  showGuides: boolean;
  toggleGuides: () => void;
  /** Which page (if any) currently has an axis snapped mid-drag — drives the highlight in guides-overlay.tsx. */
  snapAxes: { pageId: string | null; x: boolean; y: boolean };

  // Canvas actions
  addText: (preset: "heading" | "subheading" | "body", customText?: string) => void;
  applyTextToCanvas: (
    canvas: fabric.Canvas,
    preset: "heading" | "subheading" | "body",
    customText?: string
  ) => fabric.Textbox;
  addShape: (type: "rect" | "circle" | "line" | "triangle") => void;
  addImage: (url: string) => void;
  setBackground: (type: "color" | "gradient" | "image", value: string, fit?: "cover" | "contain") => void;
  applyBackgroundToCanvas: (
    canvas: fabric.Canvas,
    pageId: string,
    type: "color" | "gradient" | "image",
    value: string,
    fit?: "cover" | "contain",
    options?: { preserveFraming?: boolean; pageWidth?: number; pageHeight?: number }
  ) => Promise<void> | void;
  setBackgroundImageFit: (fit: "cover" | "contain") => void;
  setBackgroundScale: (scale: number) => void;

  // Legibility effects for text over photos (lib/effects.ts)
  backgroundEffects: BackgroundEffects;
  setBackgroundEffects: (effects: BackgroundEffects) => void;
  scrim: { kind: ScrimKind; opacity: number };
  setScrim: (kind: ScrimKind, opacity: number) => void;
  syncEffectsFromCanvas: (canvas: fabric.Canvas) => void;
  /** The "local news post" recipe — see lib/enhance.ts. Both return false if nothing to do. */
  enhancePhoto: () => boolean;
  enhanceHeadline: () => boolean;
  /** Compone la plantilla de un evento sobre un canvas concreto — ver lib/event-template.ts. */
  composeEventOnCanvas: (
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
  ) => Promise<EventLayoutMode | null>;
  /** Compone la plantilla de una noticia sobre un canvas concreto — ver lib/news-template.ts. */
  composeNewsOnCanvas: (
    canvas: fabric.Canvas,
    pageId: string,
    copy: NewsCopy,
    opts: { pageWidth: number; pageHeight: number; variant?: NewsVariant }
  ) => Promise<NewsVariant | null>;
  /** Quita la plantilla y devuelve la página al diseño de siempre (foto a sangre + titular). */
  revertNewsTemplate: (
    canvas: fabric.Canvas,
    pageId: string,
    title: string,
    opts: { pageWidth: number; pageHeight: number }
  ) => Promise<void>;
  /** Recolorea la plantilla sin recomponerla, así que no pierde los retoques manuales. */
  setNewsVariantOnCanvas: (canvas: fabric.Canvas, pageId: string, variant: NewsVariant) => void;
  /** Cuánto se desenfoca el fondo sobre el que va el texto de la plantilla de noticias. */
  setNewsBlurOnCanvas: (
    canvas: fabric.Canvas,
    pageId: string,
    blur: number,
    opts: { pageWidth: number; pageHeight: number }
  ) => void;
  /** La cifra destacada, que no sale del CRM: la escribe el operador. */
  setNewsFigureOnCanvas: (
    canvas: fabric.Canvas,
    pageId: string,
    valor: string,
    unidad: string,
    opts: { pageWidth: number; pageHeight: number }
  ) => void;
  getCanvasForPage: (pageId: string) => fabric.Canvas | null;
  getCanvasSize: () => { width: number; height: number };
  updateSelectedObject: (props: Record<string, unknown>) => void;
  /** Text formatting that respects a character selection — see lib/text-styles.ts. */
  applyTextStyle: (props: Record<string, unknown>) => void;
  clearTextStyle: () => void;
  /** Returns keyboard focus to the text box after a panel field has taken it. */
  restoreTextFocus: () => void;
  toggleBold: () => void;
  insertEmoji: (emoji: string) => void;
  deleteSelected: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  setCanvasSize: (width: number, height: number) => void;
  zoomToFit: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  exportPNG: () => void;
  exportUploadBlob: () => Promise<Blob | null>;
  getCanvasJSON: () => string;
  getCanvasJSONForPage: (pageId: string) => string;
  loadTemplate: (template: Template) => void;

  // Router
  navigate: (to: string) => void;

  // Designs
  designs: Design[];
  activeDesign: Design | null;
  createDesign: () => Promise<string | undefined>;
  createFromTemplate: (template: Template) => Promise<string | undefined>;
  loadDesign: (id: string) => Promise<void>;
  saveDesign: () => Promise<void>;
  /** Guardado diferido. Lo usa la composición automática de eventos para persistir la
   *  página recién compuesta: si no se guardara, seguiría contando como "en blanco" y se
   *  recompondría en cada apertura, pisando lo que el operador hubiera editado. */
  scheduleSave: () => void;
  /** Sube la imagen y devuelve su URL pública y el campo del registro donde se escribió
   *  ("imagenEditada" o "imagenStory", según el formato del lienzo). */
  publishToTwenty: (pngBlob: Blob) => Promise<{ url?: string; field?: string }>;
  deleteDesign: (id: string) => Promise<void>;
  renameDesign: (id: string, name: string) => Promise<void>;
  saving: boolean;

  // Pages
  pages: Page[];
  activePageId: string | null;
  activePage: Page | null;
  addPage: (afterPageId?: string) => Promise<void>;
  duplicatePage: (pageId: string) => Promise<void>;
  deletePage: (pageId: string) => Promise<void>;
  renamePage: (pageId: string, title: string) => Promise<void>;
  switchToPage: (pageId: string) => void;

  // Templates
  templates: Template[];

  // State
  loading: boolean;
}

export const EditorContext = createContext<EditorContextValue>(null!);

export function useEditor() {
  return useContext(EditorContext);
}
