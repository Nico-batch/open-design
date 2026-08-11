import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { Design, Template, Page } from "./types";
import type * as fabric from "fabric";
import type { BackgroundEffects, ScrimKind } from "./lib/effects";

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
  canvasWidth: number;
  canvasHeight: number;
  zoom: number;
  setZoomRaw: (z: number) => void;
  fitScale: number;
  setFitScale: (s: number) => void;
  /** Rule-of-thirds guides over the page — a view setting, not part of the design. */
  showGuides: boolean;
  toggleGuides: () => void;

  // Canvas actions
  addText: (preset: "heading" | "subheading" | "body", customText?: string) => void;
  applyTextToCanvas: (canvas: fabric.Canvas, preset: "heading" | "subheading" | "body", customText?: string) => void;
  addShape: (type: "rect" | "circle" | "line" | "triangle") => void;
  addImage: (url: string) => void;
  setBackground: (type: "color" | "gradient" | "image", value: string, fit?: "cover" | "contain") => void;
  applyBackgroundToCanvas: (
    canvas: fabric.Canvas,
    pageId: string,
    type: "color" | "gradient" | "image",
    value: string,
    fit?: "cover" | "contain",
    options?: { preserveFraming?: boolean }
  ) => Promise<void> | void;
  setBackgroundImageFit: (fit: "cover" | "contain") => void;
  setBackgroundScale: (scale: number) => void;

  // Legibility effects for text over photos (lib/effects.ts)
  backgroundEffects: BackgroundEffects;
  setBackgroundEffects: (effects: BackgroundEffects) => void;
  scrim: { kind: ScrimKind; opacity: number };
  setScrim: (kind: ScrimKind, opacity: number) => void;
  syncEffectsFromCanvas: (canvas: fabric.Canvas) => void;
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
  publishToTwenty: (pngBlob: Blob) => Promise<string | undefined>;
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
