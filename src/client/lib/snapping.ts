import * as fabric from "fabric";

/**
 * Center-snapping while dragging an object, tied to the same toggle as the center guides
 * overlay (guides-overlay.tsx) — the two are meant to read as one feature: see the line, get
 * pulled to it. Held Ctrl (or Cmd, for parity with the Ctrl/Cmd zoom shortcut in
 * canvas-area.tsx) disables the pull for that drag, for placing something close to center
 * without fighting the magnet.
 */

/** Catch radius in *screen* pixels — converted to design units with the live zoom. */
const SNAP_SCREEN_PX = 8;

export interface SnapAxes {
  x: boolean;
  y: boolean;
}

export interface SnapConfig {
  enabled: boolean;
  pageWidth: number;
  pageHeight: number;
  zoom: number;
}

const NO_SNAP: SnapAxes = { x: false, y: false };

/**
 * Registers the drag-to-center snap on `canvas`. `getConfig` is read on every move tick
 * (rather than captured once) so a single stable registration — made once per Fabric canvas,
 * same as the rest of `registerCanvas` in use-canvas.ts — stays correct as `showGuides`/zoom/
 * page size change later.
 */
export function installCenterSnapping(
  canvas: fabric.Canvas,
  getConfig: () => SnapConfig,
  onSnapChange: (axes: SnapAxes) => void
): void {
  canvas.on("object:moving", (opt) => {
    const cfg = getConfig();
    if (!cfg.enabled) {
      onSnapChange(NO_SNAP);
      return;
    }

    // Read straight off the native event on every tick — no keydown/keyup listener to
    // register or clean up, and it can't get stuck "on" if focus leaves the window while
    // Ctrl is held.
    const ev = opt.e as MouseEvent | undefined;
    if (ev?.ctrlKey || ev?.metaKey) {
      onSnapChange(NO_SNAP);
      return;
    }

    const target = opt.target;
    if (!target) {
      onSnapChange(NO_SNAP);
      return;
    }

    const tolerance = SNAP_SCREEN_PX / cfg.zoom;
    const pageCenterX = cfg.pageWidth / 2;
    const pageCenterY = cfg.pageHeight / 2;

    // getCenterPoint/setPositionByOrigin work the same for a plain object, a rotated one,
    // or an ActiveSelection (multi-drag) — arithmetic on left/top would need to special-case
    // each of those against its own origin.
    const center = target.getCenterPoint();
    const snappedX = Math.abs(center.x - pageCenterX) <= tolerance;
    const snappedY = Math.abs(center.y - pageCenterY) <= tolerance;

    if (snappedX || snappedY) {
      target.setPositionByOrigin(
        new fabric.Point(snappedX ? pageCenterX : center.x, snappedY ? pageCenterY : center.y),
        "center",
        "center"
      );
      target.setCoords();
    }

    onSnapChange({ x: snappedX, y: snappedY });
  });

  canvas.on("mouse:up", () => onSnapChange(NO_SNAP));
}
