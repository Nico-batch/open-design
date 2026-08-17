import { EditorContext } from "./context";
import { useCanvasState } from "./hooks/use-canvas";
import { useDesigns } from "./hooks/use-designs";
import { useRouter } from "./hooks/use-router";
import { Editor } from "./components/editor";
import { Home } from "./components/home";
import { useEffect, useRef } from "preact/hooks";

export function App() {
  const { path, navigate, designId, recordId, objectType } = useRouter();
  const canvasState = useCanvasState();
  const designState = useDesigns(canvasState.getCanvasJSONForPage, canvasState.getCanvasSize);
  const openedRecordIdRef = useRef<string | null>(null);

  // Load design from URL on initial load and when designId changes
  useEffect(() => {
    if (designId && !designState.loading) {
      if (designState.activeDesign?.id !== designId) {
        designState.loadDesign(designId);
      }
    }
  }, [designId, designState.loading]);

  // Entry point from Twenty: /edit?recordId=<id>&objectType=news|event. Opens (or
  // resumes) the design linked to that record and navigates into the editor. The guard
  // ref keys on the pair, not just the id: the same uuid could in theory come from either
  // object, and they're different drafts.
  useEffect(() => {
    if (!recordId || designId || designState.loading) return;
    const key = `${objectType}/${recordId}`;
    if (openedRecordIdRef.current === key) return;
    openedRecordIdRef.current = key;
    designState.openFromTwentyRecord(recordId, objectType).then((id) => {
      if (id) navigate(`/design/${id}`);
    });
  }, [recordId, objectType, designId, designState.loading]);

  // Preloading the source image (and, on a blank page, the default title heading) from
  // Twenty now happens in page-canvas.tsx, right after each page's own canvas finishes
  // loading — see the comment there for why it has to be sequenced that way. It also
  // refreshes the image on every load now (not just the first time), since the source
  // "Imagen" in Twenty can change after a draft was already saved.

  // Sync canvas size to the loaded design's dimensions
  useEffect(() => {
    if (designState.activeDesign) {
      const { width, height } = designState.activeDesign;
      if (width && height && (width !== canvasState.canvasWidth || height !== canvasState.canvasHeight)) {
        canvasState.setCanvasSize(width, height);
      }
    }
  }, [designState.activeDesign]);

  // Auto-activate first page when pages load and canvases are registered
  useEffect(() => {
    if (designState.pages.length > 0 && !canvasState.activeCanvasId) {
      canvasState.setActiveCanvas(designState.pages[0].id);
    }
  }, [designState.pages, canvasState.activeCanvasId]);

  if (designState.loading || (recordId && !designId)) {
    return (
      <div class="flex items-center justify-center h-full bg-zinc-950">
        <div class="text-center">
          <div class="spinner !w-6 !h-6 !border-accent/30 !border-t-accent mb-3 mx-auto" />
          <p class="text-zinc-400 text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  // Home / gallery view
  if (!designId) {
    return (
      <Home
        designs={designState.designs}
        templates={designState.templates}
        navigate={navigate}
        createDesign={designState.createDesign}
        deleteDesign={designState.deleteDesign}
        renameDesign={designState.renameDesign}
        createFromTemplate={designState.createFromTemplate}
      />
    );
  }

  // Editor view
  const contextValue = {
    ...canvasState,
    ...designState,
    // activeCanvasId is the source of truth for which page is active
    activePageId: canvasState.activeCanvasId ?? designState.activePageId,
    navigate,
  };

  return (
    <EditorContext.Provider value={contextValue}>
      <Editor />
    </EditorContext.Provider>
  );
}
