import { EditorContext } from "./context";
import { useCanvasState } from "./hooks/use-canvas";
import { useDesigns } from "./hooks/use-designs";
import { useRouter } from "./hooks/use-router";
import { Editor } from "./components/editor";
import { Home } from "./components/home";
import { api } from "./api";
import type { NewsRecord } from "./types";
import { useEffect, useRef } from "preact/hooks";

export function App() {
  const { path, navigate, designId, recordId } = useRouter();
  const canvasState = useCanvasState();
  const designState = useDesigns(canvasState.getCanvasJSONForPage);
  const openedRecordIdRef = useRef<string | null>(null);
  const populatedFromNewsRef = useRef<Set<string>>(new Set());

  // Load design from URL on initial load and when designId changes
  useEffect(() => {
    if (designId && !designState.loading) {
      if (designState.activeDesign?.id !== designId) {
        designState.loadDesign(designId);
      }
    }
  }, [designId, designState.loading]);

  // Entry point from Twenty: /edit?recordId=<News id>. Opens (or resumes) the design
  // linked to that record and navigates into the editor.
  useEffect(() => {
    if (!recordId || designId || designState.loading) return;
    if (openedRecordIdRef.current === recordId) return;
    openedRecordIdRef.current = recordId;
    designState.openFromNewsRecord(recordId).then((id) => {
      if (id) navigate(`/design/${id}`);
    });
  }, [recordId, designId, designState.loading]);

  // First time a News-linked design is opened (its page is still blank), preload the
  // source image as a cover background and the title as a heading. Only runs once per
  // design — after that, whatever the operator does in the canvas is what persists.
  useEffect(() => {
    const design = designState.activeDesign;
    const activePageId = canvasState.activeCanvasId;
    if (!design?.twenty_record_id || !activePageId || populatedFromNewsRef.current.has(design.id)) return;
    const page = designState.pages.find((p) => p.id === activePageId);
    if (!page) return;
    populatedFromNewsRef.current.add(design.id);
    if (page.canvas_json !== "{}") return; // already has content — don't touch it

    api<NewsRecord>("GET", `/api/news/${design.twenty_record_id}`)
      .then((news) => {
        if (news.imageUrl) canvasState.setBackground("image", news.imageUrl, "cover");
        if (news.title) canvasState.addText("heading", news.title);
      })
      .catch((e) => console.error("Failed to preload News data:", e));
  }, [designState.activeDesign, designState.pages, canvasState.activeCanvasId]);

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
      <div class="flex items-center justify-center h-full bg-[#F3F4F7]">
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
