import { useRef, useEffect } from "preact/hooks";
import * as fabric from "fabric";
import { useEditor } from "../context";
import { applyLogoToCanvas } from "../lib/logo";
import { findBackgroundImage, makeBackgroundInteractive } from "../lib/background";
import { syncCanvasFonts } from "../lib/fonts";
import { applyWorkspaceGeometry, workspaceSize, WORKSPACE_PADDING } from "../lib/workspace";
import { api } from "../api";
import type { Page, NewsRecord } from "../types";

interface PageCanvasProps {
  page: Page;
  isActive: boolean;
  width: number;
  height: number;
  onActivate: () => void;
}

export function PageCanvas({ page, isActive, width, height, onActivate }: PageCanvasProps) {
  const {
    registerCanvas,
    unregisterCanvas,
    activeDesign,
    pages,
    applyBackgroundToCanvas,
    applyTextToCanvas,
    syncEffectsFromCanvas,
  } = useEditor();
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<fabric.Canvas | null>(null);
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  // Captured once at mount — this effect only ever runs on mount (empty deps below),
  // so later changes to these wouldn't be picked up anyway; that's fine, they're stable
  // for the lifetime of a single "open the editor" session.
  const twentyRecordIdRef = useRef(activeDesign?.twenty_record_id ?? null);
  const isPrimaryPageRef = useRef(pages[0]?.id === page.id);

  useEffect(() => {
    if (!canvasElRef.current || fabricRef.current) return;

    const c = new fabric.Canvas(canvasElRef.current, {
      width,
      height,
      backgroundColor: "#ffffff",
      preserveObjectStacking: true,
      selection: true,
      // Controls are drawn *after* the clip path is applied (see lib/workspace.ts), which
      // is what lets the handles of an oversized background stay visible in the margin.
      controlsAboveOverlay: true,
    });

    // Retina rendering + the margin the controls live in.
    applyWorkspaceGeometry(c, width, height);

    // Custom control appearance — applied per-object via object:added
    const CONTROL_STYLE = {
      transparentCorners: false,
      borderColor: "#6366f1",
      borderScaleFactor: 1.5,
      padding: 6,
      cornerSize: 14,
      cornerColor: "#ffffff",
      cornerStrokeColor: "#6366f1",
      cornerStyle: "circle" as const,
    };

    // Custom render for corner controls (white circles with accent stroke)
    const renderCircleCorner = (
      ctx: CanvasRenderingContext2D,
      left: number,
      top: number,
      _styleOverride: unknown,
      _fabricObject: fabric.FabricObject,
    ) => {
      const size = 14;
      ctx.save();
      ctx.translate(left, top);
      ctx.beginPath();
      ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#6366f1";
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };

    // Custom render for side controls (rounded pill handles)
    const renderPillControl = (horizontal: boolean) => {
      return (
        ctx: CanvasRenderingContext2D,
        left: number,
        top: number,
        _styleOverride: unknown,
        _fabricObject: fabric.FabricObject,
      ) => {
        const w = horizontal ? 28 : 8;
        const h = horizontal ? 8 : 28;
        ctx.save();
        ctx.translate(left, top);
        ctx.beginPath();
        ctx.roundRect(-w / 2, -h / 2, w, h, 4);
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#6366f1";
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      };
    };

    // Apply custom controls to an object
    const applyCustomControls = (obj: fabric.FabricObject) => {
      obj.set(CONTROL_STYLE);
      // Override corner renders
      if (obj.controls) {
        for (const key of ["tl", "tr", "bl", "br"]) {
          if (obj.controls[key]) {
            obj.controls[key].render = renderCircleCorner;
            obj.controls[key].sizeX = 18;
            obj.controls[key].sizeY = 18;
          }
        }
        for (const key of ["mt", "mb"]) {
          if (obj.controls[key]) {
            obj.controls[key].render = renderPillControl(true);
            obj.controls[key].sizeX = 32;
            obj.controls[key].sizeY = 12;
          }
        }
        for (const key of ["ml", "mr"]) {
          if (obj.controls[key]) {
            obj.controls[key].render = renderPillControl(false);
            obj.controls[key].sizeX = 12;
            obj.controls[key].sizeY = 32;
          }
        }
      }
    };

    // Apply to all existing objects
    c.getObjects().forEach(applyCustomControls);

    // Apply to any newly added objects
    c.on("object:added", (e) => {
      if (e.target) applyCustomControls(e.target);
    });

    // If this is the primary page of a design linked to a Twenty News record, refresh
    // the source image from Twenty every time the editor loads — the source "Imagen" in
    // Twenty can change after a draft was already saved (e.g. it didn't fit and got
    // swapped), so we shouldn't keep showing whatever was fetched the first time. Text
    // content the operator already wrote is left alone; only the background image is
    // replaced. Runs strictly *after* the saved JSON has finished loading below —
    // loadFromJSON replaces the whole canvas, so doing this any earlier would just get
    // wiped out once it resolves.
    const refreshFromTwenty = (isBlankPage: boolean) => {
      const twentyRecordId = twentyRecordIdRef.current;
      if (!isPrimaryPageRef.current || !twentyRecordId) return;
      api<NewsRecord>("GET", `/api/news/${twentyRecordId}`)
        .then((news) => {
          // preserveFraming: the image is re-fetched on every open, so re-fitting it
          // unconditionally would undo any manual repositioning the operator had saved.
          if (news.imageUrl) {
            const applied = applyBackgroundToCanvas(c, page.id, "image", news.imageUrl, "cover", {
              preserveFraming: true,
            });
            // The refresh swaps the background object, so re-read the effect values from
            // the replacement rather than from the one that was just discarded.
            Promise.resolve(applied).then(() => syncEffectsFromCanvas(c));
          }
          if (isBlankPage && news.title) applyTextToCanvas(c, "heading", news.title);
        })
        .catch((e) => console.error("Failed to refresh News image:", e));
    };

    // Load page content, then add the fixed logo layer on top
    if (page.canvas_json && page.canvas_json !== "{}") {
      try {
        c.loadFromJSON(JSON.parse(page.canvas_json)).then(async () => {
          // Designs saved while the background was still a locked layer restore with
          // `selectable: false` baked into their JSON — unlock those so the operator can
          // reframe them too, not just newly created ones.
          const bg = findBackgroundImage(c);
          if (bg) makeBackgroundInteractive(bg);
          await applyLogoToCanvas(c, width, height);
          c.requestRenderAll();
          // Saved text was measured against whatever font was available when it was
          // *created*; re-measure now that we can guarantee the real faces (lib/fonts.ts).
          syncCanvasFonts(c);
          // Restore the effects panel to whatever this design was saved with.
          syncEffectsFromCanvas(c);
          refreshFromTwenty(false);
        });
      } catch {
        // ignore parse errors
      }
    } else {
      applyLogoToCanvas(c, width, height).then(() => {
        c.requestRenderAll();
        refreshFromTwenty(true);
      });
    }

    // On mouse down, activate this canvas (use ref to avoid stale closure)
    c.on("mouse:down", () => onActivateRef.current());

    fabricRef.current = c;
    registerCanvas(page.id, c);

    return () => {
      unregisterCanvas(page.id);
      c.dispose();
      fabricRef.current = null;
    };
  }, []);

  const workspace = workspaceSize(width, height);

  return (
    // The wrapper is the whole workspace (page + margin) and must NOT clip, or the
    // off-page handles it exists to expose would be cut off again. The page itself is a
    // card sitting behind the canvas: the canvas is transparent outside the clip path, so
    // this is what gives the page its edge and shadow.
    <div class="relative" style={{ width: workspace.width, height: workspace.height }}>
      <div
        class={`absolute shadow-lg rounded-lg bg-white ${isActive ? "ring-2 ring-[#6366f1]" : ""}`}
        style={{ left: WORKSPACE_PADDING, top: WORKSPACE_PADDING, width, height }}
      />
      <div class="absolute inset-0">
        <canvas ref={canvasElRef} />
      </div>
    </div>
  );
}
