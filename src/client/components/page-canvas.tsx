import { useRef, useEffect } from "preact/hooks";
import * as fabric from "fabric";
import { useEditor } from "../context";
import { applyLogoToCanvas } from "../lib/logo";
import {
  findBackgroundImage,
  makeBackgroundInteractive,
  normalizeBackgroundSource,
} from "../lib/background";
import { buildEventCopy } from "../lib/event-fields";
import { findByRole, refreshPosterImage } from "../lib/event-template";
import { buildNewsCopy } from "../lib/news-fields";
import { hasNewsTemplate, relayoutNewsTemplate } from "../lib/news-template";
import { syncCanvasFonts } from "../lib/fonts";
import { applyWorkspaceGeometry, applyWorkspaceClip, workspaceSize, WORKSPACE_PADDING } from "../lib/workspace";
import { GuidesOverlay } from "./guides-overlay";
import { api } from "../api";
import { coerceTwentyObjectType } from "../lib/twenty";
import type { EventFields, NewsFields, Page, TwentyRecord } from "../types";

interface PageCanvasProps {
  page: Page;
  isActive: boolean;
  width: number;
  height: number;
  onActivate: () => void;
}

export function PageCanvas({ page, isActive, width, height, onActivate }: PageCanvasProps) {
  const editor = useEditor();
  const { registerCanvas, unregisterCanvas, activeDesign, pages, showGuides } = editor;
  // Reasignado en cada render (no dentro de un efecto), el mismo patrón que onActivateRef:
  // el efecto de montaje corre con deps [] y sus continuaciones asíncronas se ejecutan
  // mucho después, así que leer el contexto capturado daría callbacks de hace varios
  // renders — y con ellos el tamaño de página inicial.
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<fabric.Canvas | null>(null);
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  // Captured once at mount — this effect only ever runs on mount (empty deps below),
  // so later changes to these wouldn't be picked up anyway; that's fine, they're stable
  // for the lifetime of a single "open the editor" session.
  // El tamaño de la página llega un render *después* de que este canvas se monte: el
  // efecto que sincroniza `canvasWidth/Height` con el diseño (app.tsx) corre tras el
  // primer render, así que al montar todavía valen 1080×1080. Para un evento, que nace a
  // 1080×1350, usar el valor capturado recortaría la página a un cuadrado y calcularía el
  // `cover` del fondo contra la altura equivocada.
  const sizeRef = useRef({ width, height });
  sizeRef.current = { width, height };
  const twentyRecordIdRef = useRef(activeDesign?.twenty_record_id ?? null);
  const twentyObjectTypeRef = useRef(coerceTwentyObjectType(activeDesign?.twenty_object_type));
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

    // Arranque de la página, en un solo hilo secuencial.
    //
    // Todo esto tiene que ir en orden y esperándose de verdad: `loadFromJSON` sustituye el
    // contenido entero del lienzo (lo añadido antes se perdería), la plantilla de eventos
    // necesita el fondo ya cargado para saber si el cartel encaja en la página, y el texto
    // no se puede medir hasta que estén las fuentes. Antes esto eran dos ramas con
    // callbacks encadenados a medias, con el refresco de Twenty disparado y sin esperar.
    const bootstrap = async () => {
      const saved = !!(page.canvas_json && page.canvas_json !== "{}");

      if (saved) {
        await c.loadFromJSON(JSON.parse(page.canvas_json));
        // loadFromJSON borra el clipPath que puso applyWorkspaceGeometry: sin esto, un
        // diseño guardado se abriría pintando sobre toda el área de trabajo (§9.16).
        applyWorkspaceClip(c, sizeRef.current.width, sizeRef.current.height);
        // Las imágenes vuelven reconstruidas desde su `src`, es decir a resolución
        // completa otra vez, y el filtro las truncaría por encima de 4096 px (§9.18).
        normalizeBackgroundSource(c);
        // Los diseños guardados cuando el fondo era una capa bloqueada traen
        // `selectable: false` grabado en su JSON; desbloquearlos para poder reencuadrar.
        const bg = findBackgroundImage(c);
        if (bg) makeBackgroundInteractive(bg);
      }

      await applyLogoToCanvas(c, sizeRef.current.width, sizeRef.current.height);
      c.requestRenderAll();

      if (saved) {
        // El texto guardado se midió con la fuente que hubiera disponible cuando se creó;
        // re-medir ahora que podemos garantizar las caras reales (lib/fonts.ts).
        syncCanvasFonts(c);
        editorRef.current.syncEffectsFromCanvas(c);
      }

      // ── Datos de Twenty ──────────────────────────────────────────────
      const recordId = twentyRecordIdRef.current;
      if (!isPrimaryPageRef.current || !recordId) return;
      const objectType = twentyObjectTypeRef.current;

      const record = await api<TwentyRecord>("GET", `/api/twenty/${objectType}/${recordId}`);
      const { width: pageWidth, height: pageHeight } = sizeRef.current;

      // La imagen se re-pide en cada apertura porque la "Imagen" de Twenty puede haberse
      // sustituido después de guardar un borrador. `preserveFraming` evita que ese refresco
      // deshaga el reencuadre (y los filtros) que el operador ya hubiera ajustado.
      if (record.imageUrl) {
        await editorRef.current.applyBackgroundToCanvas(
          c,
          page.id,
          "image",
          record.imageUrl,
          "cover",
          { preserveFraming: true, pageWidth, pageHeight }
        );
        editorRef.current.syncEffectsFromCanvas(c);
        // La foto se re-pide en cada apertura, y `applyBackgroundToCanvas` la encaja contra
        // la página entera: con la plantilla de noticias vive en su banda superior, así que
        // hay que devolverla ahí o entraría metida por debajo de la franja.
        if (hasNewsTemplate(c)) relayoutNewsTemplate(c, pageWidth, pageHeight);
      }

      if (objectType === "event" && record.fields && record.title && !saved) {
        // Página en blanco de un evento: se compone la plantilla entera con los campos que
        // tenga el registro. `seal` deja el historial en una sola entrada — esto es el
        // estado inicial del documento, no un paso que tenga sentido deshacer.
        await editorRef.current.composeEventOnCanvas(
          c,
          page.id,
          buildEventCopy(record.fields as EventFields, record.title),
          { pageWidth, pageHeight, seal: true }
        );
        // Sin guardar, la página seguiría contando como "en blanco" (saveDesign ignora el
        // JSON "{}") y volvería a componerse en cada apertura, pisando lo que el operador
        // hubiera editado entretanto.
        editorRef.current.scheduleSave();
      } else if (objectType === "event" && findByRole(c, "poster")) {
        // Modo cartel ya compuesto: el cartel de encima también tiene que reflejar la foto
        // nueva, no solo el fondo desenfocado de detrás.
        await refreshPosterImage(c);
      } else if (objectType === "news" && !saved && record.title) {
        // Página en blanco de una noticia: se compone la plantilla (foto arriba, franja de
        // texto abajo). `seal` deja el historial en una sola entrada — es el estado inicial
        // del documento, y para volver al diseño de siempre está el botón del panel.
        await editorRef.current.composeNewsOnCanvas(
          c,
          page.id,
          buildNewsCopy(record.fields as NewsFields | null, record.title),
          { pageWidth, pageHeight, seal: true }
        );
        // Sin guardar, la página seguiría contando como "en blanco" (saveDesign ignora el
        // JSON "{}") y se recompondría en cada apertura, pisando lo que el operador hubiera
        // editado entretanto.
        editorRef.current.scheduleSave();
      } else if (!saved && record.title) {
        // Cualquier otro objeto del CRM: el comportamiento de siempre, titular suelto.
        editorRef.current.applyTextToCanvas(c, "heading", record.title);
      }
    };

    bootstrap().catch((e) => console.error("Fallo al preparar la página:", e));

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
      {showGuides && <GuidesOverlay width={width} height={height} pageId={page.id} />}
    </div>
  );
}
