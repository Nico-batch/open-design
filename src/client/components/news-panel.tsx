import { useState, useEffect, useCallback } from "preact/hooks";
import { RefreshCw, Check, Minus, Undo2, Wand2 } from "lucide-preact";
import { useEditor } from "../context";
import { api } from "../api";
import { buildNewsCopy, type NewsCopy } from "../lib/news-fields";
import {
  currentVariant,
  hasNewsTemplate,
  readNewsFigure,
  type NewsVariant,
} from "../lib/news-template";
import type { NewsFields, TwentyRecord } from "../types";

/**
 * Controles propios de un diseño que viene de una noticia del CRM.
 *
 * Además de los botones, enseña **qué campos ha encontrado** en el registro: es la superficie
 * de diagnóstico de la pregunta que se va a hacer siempre —"¿por qué no sale el chip?"— y la
 * contesta desde el editor, sin abrir Twenty en otra pestaña.
 */

const VARIANTS: { key: NewsVariant; label: string; hint: string; swatch: string }[] = [
  {
    key: "navy",
    label: "Navy",
    hint: "Franja azul noche con titular crema y chip ámbar. Es la variante por defecto y la que mejor funciona con una foto cualquiera.",
    swatch: "#0a2540",
  },
  {
    key: "cream",
    label: "Crema",
    hint: "Franja crema con titular azul noche. Para piezas de servicio o resúmenes. El ámbar desaparece: sobre crema no tiene contraste suficiente.",
    swatch: "#fbf7f0",
  },
];

export function NewsPanel() {
  const {
    activeDesign,
    pages,
    getCanvasForPage,
    composeNewsOnCanvas,
    revertNewsTemplate,
    setNewsVariantOnCanvas,
    setNewsFigureOnCanvas,
    canvasWidth,
    canvasHeight,
    setActiveCanvas,
    scheduleSave,
  } = useEditor();

  const [copy, setCopy] = useState<NewsCopy | null>(null);
  const [applied, setApplied] = useState(false);
  const [variant, setVariant] = useState<NewsVariant>("navy");
  const [figure, setFigure] = useState({ valor: "", unidad: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recordId = activeDesign?.twenty_record_id ?? null;
  const primaryPage = pages[0] ?? null;
  const pageSize = { pageWidth: canvasWidth, pageHeight: canvasHeight };

  /** Vuelve a pedir el registro: rehacer tiene que usar los datos actuales del CRM, no los
   *  que se leyeron al abrir el editor. */
  const fetchCopy = useCallback(
    async (dato?: { valor: string | null; unidad: string | null }): Promise<NewsCopy | null> => {
      if (!recordId) return null;
      const record = await api<TwentyRecord>("GET", `/api/twenty/news/${recordId}`);
      if (!record.title) return null;
      return buildNewsCopy(record.fields as NewsFields | null, record.title, dato);
    },
    [recordId]
  );

  /** Lee del lienzo lo que el lienzo ya sabe (variante y cifra), para no tener el mismo dato
   *  guardado en dos sitios que puedan contradecirse. */
  const syncFromCanvas = useCallback(() => {
    if (!primaryPage) return;
    const canvas = getCanvasForPage(primaryPage.id);
    if (!canvas) return;
    setApplied(hasNewsTemplate(canvas));
    setVariant(currentVariant(canvas));
    setFigure(readNewsFigure(canvas));
  }, [primaryPage, getCanvasForPage]);

  useEffect(() => {
    let cancelled = false;
    fetchCopy()
      .then((c) => {
        if (!cancelled) setCopy(c);
      })
      .catch(() => {
        /* la lista de campos es informativa; un fallo aquí no rompe los botones */
      });
    syncFromCanvas();
    return () => {
      cancelled = true;
    };
  }, [fetchCopy, syncFromCanvas]);

  /** Envuelve una acción sobre el lienzo principal: resuelve el canvas, marca el panel como
   *  ocupado, guarda y deja el error a la vista si algo falla. */
  const run = useCallback(
    async (action: (canvas: import("fabric").Canvas, pageId: string) => Promise<void> | void) => {
      if (!primaryPage) return;
      const canvas = getCanvasForPage(primaryPage.id);
      if (!canvas) return;
      setBusy(true);
      setError(null);
      try {
        await action(canvas, primaryPage.id);
        // La plantilla siempre se compone en la página principal, que no tiene por qué ser la
        // que el operador esté mirando — llevarle a ella para que vea el resultado.
        setActiveCanvas(primaryPage.id);
        syncFromCanvas();
        scheduleSave();
      } catch (e) {
        setError(e instanceof Error ? e.message : "No se pudo aplicar el cambio.");
      } finally {
        setBusy(false);
      }
    },
    [primaryPage, getCanvasForPage, setActiveCanvas, syncFromCanvas, scheduleSave]
  );

  const compose = useCallback(
    (opts?: { confirmFirst?: boolean; variant?: NewsVariant }) =>
      run(async (canvas, pageId) => {
        // Rehacer borra los bloques generados, incluidos los que el operador haya retocado a
        // mano (conservan la marca). Es la semántica correcta de "rehacer con los datos
        // actuales", pero no debe ocurrir de un clic despistado.
        if (
          opts?.confirmFirst &&
          hasNewsTemplate(canvas) &&
          !confirm(
            "Se rehará la plantilla con los datos actuales de Twenty. Se perderán los cambios hechos a mano sobre los textos generados. ¿Continuar?"
          )
        ) {
          return;
        }
        const fresh = await fetchCopy({ valor: figure.valor, unidad: figure.unidad });
        if (!fresh) throw new Error("El registro no tiene titular en Twenty.");
        setCopy(fresh);
        await composeNewsOnCanvas(canvas, pageId, fresh, {
          ...pageSize,
          variant: opts?.variant ?? variant,
        });
      }),
    [run, fetchCopy, composeNewsOnCanvas, figure, variant, canvasWidth, canvasHeight]
  );

  const revert = useCallback(
    () =>
      run(async (canvas, pageId) => {
        if (
          !confirm(
            "Se quitará la plantilla y la página volverá al diseño de siempre: la foto a sangre y el titular como cuadro de texto. ¿Continuar?"
          )
        ) {
          return;
        }
        const title = copy?.titular ?? (await fetchCopy())?.titular ?? "";
        await revertNewsTemplate(canvas, pageId, title, pageSize);
      }),
    [run, revertNewsTemplate, fetchCopy, copy, canvasWidth, canvasHeight]
  );

  /** La variante solo recolorea, no recompone: cambiar dos colores no debe costar los
   *  retoques manuales sobre los textos. */
  const chooseVariant = useCallback(
    (next: NewsVariant) => {
      if (next === variant) return;
      if (!applied) {
        void compose({ variant: next });
        return;
      }
      void run((canvas, pageId) => {
        setNewsVariantOnCanvas(canvas, pageId, next);
      });
    },
    [variant, applied, compose, run, setNewsVariantOnCanvas]
  );

  const commitFigure = useCallback(
    (next: { valor: string; unidad: string }) => {
      setFigure(next);
      if (!applied) return;
      void run((canvas, pageId) => {
        setNewsFigureOnCanvas(canvas, pageId, next.valor, next.unidad, pageSize);
      });
    },
    [applied, run, setNewsFigureOnCanvas, canvasWidth, canvasHeight]
  );

  /** `change` solo salta al perder el foco, y escribir una cifra y pulsar Enter es el gesto
   *  natural: se quita el foco a mano para que el evento se dispare igual. */
  const commitOnEnter = useCallback((e: KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    (e.target as HTMLInputElement).blur();
  }, []);

  const fields: { label: string; value: string | null }[] = [
    { label: "Titular", value: copy?.titular ?? null },
    { label: "Sección", value: copy?.seccion ?? null },
  ];

  const inputClass =
    "w-full px-2 py-1.5 rounded-md bg-zinc-800 border border-zinc-700 text-[11px] text-zinc-100 outline-none focus:border-accent";

  return (
    <div>
      <p class="text-zinc-400 text-[10px] mb-3 leading-snug">
        La página se compone sola: la foto arriba y una franja de color abajo con la sección, el
        titular y el pie. El titular nunca queda encima de la foto.
      </p>

      {applied ? (
        <div class="grid grid-cols-1 gap-1 mb-3">
          <button
            class="w-full flex items-center justify-center gap-1.5 py-2 rounded-md border border-accent/60 bg-accent/10 text-[11px] font-semibold text-accent cursor-pointer transition-all hover:bg-accent/20 disabled:opacity-50"
            title="Vuelve a leer el registro en Twenty y reconstruye los textos. No toca el encuadre de la foto ni lo que hayas añadido a mano."
            disabled={busy || !primaryPage}
            onClick={() => compose({ confirmFirst: true })}
          >
            {busy ? <span class="spinner !w-3 !h-3 !border-accent/30 !border-t-accent" /> : <RefreshCw size={13} />}
            {busy ? "Rehaciendo..." : "Rehacer plantilla"}
          </button>
          <button
            class="w-full flex items-center justify-center gap-1.5 py-2 rounded-md border border-zinc-700 text-[11px] text-zinc-300 cursor-pointer transition-all hover:text-zinc-50 hover:border-zinc-600 disabled:opacity-50"
            title="Quita la franja y todos los bloques generados: la foto vuelve a ocupar la página entera y el titular queda como un cuadro de texto suelto."
            disabled={busy || !primaryPage}
            onClick={revert}
          >
            <Undo2 size={13} />
            Volver al diseño normal
          </button>
        </div>
      ) : (
        <button
          class="w-full flex items-center justify-center gap-1.5 py-2 mb-3 rounded-md border border-accent/60 bg-accent/10 text-[11px] font-semibold text-accent cursor-pointer transition-all hover:bg-accent/20 disabled:opacity-50"
          title="Compone la plantilla de noticia con el titular y la sección del registro."
          disabled={busy || !primaryPage}
          onClick={() => compose()}
        >
          {busy ? <span class="spinner !w-3 !h-3 !border-accent/30 !border-t-accent" /> : <Wand2 size={13} />}
          {busy ? "Aplicando..." : "Aplicar plantilla"}
        </button>
      )}

      <p class="text-zinc-400 text-[11px] font-semibold mb-1">Variante</p>
      <div class="grid grid-cols-2 gap-1 mb-3">
        {VARIANTS.map((v) => (
          <button
            key={v.key}
            title={v.hint}
            disabled={busy || !primaryPage}
            class={`flex items-center justify-center gap-1.5 py-1.5 rounded-md border text-[10px] cursor-pointer transition-all disabled:opacity-50 ${
              variant === v.key
                ? "bg-accent/20 border-accent text-accent"
                : "bg-transparent border-zinc-700 text-zinc-400 hover:text-zinc-50"
            }`}
            onClick={() => chooseVariant(v.key)}
          >
            <span
              class="w-2.5 h-2.5 rounded-full border border-zinc-500 shrink-0"
              style={{ background: v.swatch }}
            />
            {v.label}
          </button>
        ))}
      </div>

      <p class="text-zinc-400 text-[11px] font-semibold mb-1">Dato destacado</p>
      <p class="text-zinc-500 text-[10px] mb-1.5 leading-snug">
        No existe como campo en Twenty. Si lo dejas vacío, el bloque no se crea y el titular
        sube a ocupar su sitio.
      </p>
      <div class="grid grid-cols-[1fr_1.4fr] gap-1 mb-3">
        <input
          class={inputClass}
          placeholder="1.477"
          value={figure.valor}
          disabled={busy || !applied}
          onChange={(e) =>
            commitFigure({ valor: (e.target as HTMLInputElement).value, unidad: figure.unidad })
          }
          onKeyDown={commitOnEnter}
        />
        <input
          class={inputClass}
          placeholder="negocios abiertos"
          value={figure.unidad}
          disabled={busy || !applied}
          onChange={(e) =>
            commitFigure({ valor: figure.valor, unidad: (e.target as HTMLInputElement).value })
          }
          onKeyDown={commitOnEnter}
        />
      </div>

      <p class="text-zinc-400 text-[11px] font-semibold mb-1">Campos del registro</p>
      <ul class="mb-2">
        {fields.map((f) => (
          <li key={f.label} class="flex items-start gap-1.5 py-0.5 text-[10px]">
            {f.value ? (
              <Check size={11} class="text-emerald-500 shrink-0 mt-0.5" />
            ) : (
              <Minus size={11} class="text-zinc-600 shrink-0 mt-0.5" />
            )}
            <span class={f.value ? "text-zinc-300" : "text-zinc-600"}>
              <span class="text-zinc-500">{f.label}: </span>
              {f.value ?? "vacío en Twenty"}
            </span>
          </li>
        ))}
      </ul>

      {error && (
        <div class="px-2.5 py-1.5 rounded-md bg-red-950 border border-red-900 text-[10px] text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
