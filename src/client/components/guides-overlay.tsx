import { useEditor } from "../context";
import { WORKSPACE_PADDING } from "../lib/workspace";

interface GuidesOverlayProps {
  width: number;
  height: number;
}

/**
 * Rule-of-thirds guides drawn over the page.
 *
 * Deliberately a DOM layer and **not** Fabric objects. Anything added to the canvas would
 * have to be kept out of four different places at once: `canvas_json` (it is not part of
 * the design), the undo history (every toggle would become a step), the selection (a guide
 * is not something you click), and above all the export — `exportPNG`/`exportUploadBlob`
 * read the *live* canvas, which is exactly why the logo layer shows up in the output
 * (lib/logo.ts). A guide that shipped to Twenty inside the image would be a bad day. As a
 * sibling of the canvas element none of that can happen by construction.
 *
 * Positioned over the page itself, not the workspace: the margin around it is scaffolding
 * for reaching off-page handles (lib/workspace.ts), and thirds only mean anything within
 * the page that actually gets exported.
 */
export function GuidesOverlay({ width, height }: GuidesOverlayProps) {
  const { zoom } = useEditor();

  // The whole canvas tree is CSS-scaled by `zoom` (see canvas-area.tsx), so a 1px line
  // would be painted at 0.58px at the default zoom — sub-pixel, and it fades to almost
  // nothing. Dividing by the zoom keeps every line one real pixel wide at any zoom, the
  // same inverse-scale trick the page headers already use.
  const thickness = 1 / zoom;

  // A single colour can't work: the page underneath may be white card, a bright photo or
  // a dark one. A pale core with a dark halo reads on all three — it's what camera
  // viewfinders do for the same reason.
  const lineStyle = {
    background: "rgba(255,255,255,0.7)",
    boxShadow: `0 0 0 ${thickness}px rgba(0,0,0,0.28)`,
  };

  return (
    <div
      class="absolute pointer-events-none"
      style={{ left: WORKSPACE_PADDING, top: WORKSPACE_PADDING, width, height }}
      aria-hidden="true"
    >
      {[1 / 3, 2 / 3].map((f) => (
        <div
          key={`v${f}`}
          class="absolute"
          style={{ left: width * f, top: 0, width: thickness, height, ...lineStyle }}
        />
      ))}
      {[1 / 3, 2 / 3].map((f) => (
        <div
          key={`h${f}`}
          class="absolute"
          style={{ left: 0, top: height * f, width, height: thickness, ...lineStyle }}
        />
      ))}
    </div>
  );
}
