import { useEditor } from "../context";
import { WORKSPACE_PADDING } from "../lib/workspace";

interface GuidesOverlayProps {
  width: number;
  height: number;
  pageId: string;
}

/**
 * Center guides drawn over the page — one vertical, one horizontal, dividing it into 4 —
 * paired with drag-to-center snapping (lib/snapping.ts) registered on the Fabric canvas.
 *
 * Deliberately a DOM layer and **not** Fabric objects. Anything added to the canvas would
 * have to be kept out of four different places at once: `canvas_json` (it is not part of
 * the design), the undo history (every toggle would become a step), the selection (a guide
 * is not something you click), and above all the export — `exportPNG`/`exportUploadBlob`
 * read the *live* canvas, which is exactly why the logo layer shows up in the output
 * (lib/logo.ts). A guide that shipped to Twenty inside the image would be a bad day. As a
 * sibling of the canvas element none of that can happen by construction. The snap itself
 * lives entirely in `lib/snapping.ts`, driven off Fabric's own `object:moving` event — it
 * never touches this overlay's DOM, it only reports back which axis is caught so this
 * component can highlight the matching line.
 *
 * Positioned over the page itself, not the workspace: the margin around it is scaffolding
 * for reaching off-page handles (lib/workspace.ts), and the center only means anything
 * within the page that actually gets exported.
 */
export function GuidesOverlay({ width, height, pageId }: GuidesOverlayProps) {
  const { zoom, snapAxes } = useEditor();

  // The whole canvas tree is CSS-scaled by `zoom` (see canvas-area.tsx), so a 1px line
  // would be painted at 0.58px at the default zoom — sub-pixel, and it fades to almost
  // nothing. Dividing by the zoom keeps every line one real pixel wide at any zoom, the
  // same inverse-scale trick the page headers already use.
  const thickness = 1 / zoom;
  const highlightThickness = 2 / zoom;

  // A single colour can't work: the page underneath may be white card, a bright photo or
  // a dark one. A pale core with a dark halo reads on all three — it's what camera
  // viewfinders do for the same reason.
  const lineStyle = {
    background: "rgba(255,255,255,0.7)",
    boxShadow: `0 0 0 ${thickness}px rgba(0,0,0,0.28)`,
  };
  // Same accent used for the page's active ring and Fabric's own control handles — reads
  // as "the app is telling you this locked in", not a third unrelated colour.
  const highlightStyle = {
    background: "#6366f1",
    boxShadow: `0 0 0 ${thickness}px rgba(0,0,0,0.28)`,
  };

  const onThisPage = snapAxes.pageId === pageId;
  const vThickness = onThisPage && snapAxes.x ? highlightThickness : thickness;
  const hThickness = onThisPage && snapAxes.y ? highlightThickness : thickness;

  return (
    <div
      class="absolute pointer-events-none"
      style={{ left: WORKSPACE_PADDING, top: WORKSPACE_PADDING, width, height }}
      aria-hidden="true"
    >
      <div
        class="absolute"
        style={{
          left: width / 2 - vThickness / 2,
          top: 0,
          width: vThickness,
          height,
          ...(vThickness === highlightThickness ? highlightStyle : lineStyle),
        }}
      />
      <div
        class="absolute"
        style={{
          left: 0,
          top: height / 2 - hThickness / 2,
          width,
          height: hThickness,
          ...(hThickness === highlightThickness ? highlightStyle : lineStyle),
        }}
      />
    </div>
  );
}
