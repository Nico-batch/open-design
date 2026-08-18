import { useState, useEffect, useCallback } from "preact/hooks";
import { RefreshCw, Check, Minus } from "lucide-preact";
import { useEditor } from "../context";
import { api } from "../api";
import { buildEventCopy, type EventCopy } from "../lib/event-fields";
import {
  currentLayoutMode,
  currentTheme,
  hasEventTemplate,
  type EventLayoutMode,
  type EventTheme,
} from "../lib/event-template";
import type { EventFields, TwentyRecord } from "../types";

/**
 * Controles propios de un diseño que viene de un evento del CRM.
 *
 * Además de los botones, enseña **qué campos ha encontrado** en el registro. Esa lista es
 * la superficie de diagnóstico de la pregunta que se va a hacer siempre —"¿por qué no sale
 * la fecha?"— y contesta desde el propio editor, sin abrir Twenty en otra pestaña: si el
 * campo aparece tachado, es que está vacío en el CRM.
 */

const MODES: { key: EventLayoutMode; label: string; hint: string }[] = [
  {
    key: "poster",
    label: "Cartel entero",
    hint: "El cartel se ve completo sobre un fondo hecho con la misma imagen, desenfocada. Para carteles verticales que ya llevan el título impreso.",
  },
  {
    key: "bleed",
    label: "A sangre",
    hint: "La imagen ocupa toda la página con un degradado oscuro abajo. Para fotos que encajan bien en el formato.",
  },
];

const THEMES: { key: EventTheme; label: string; hint: string; swatch: string }[] = [
  {
    key: "light",
    label: "Tinta clara",
    hint: "Texto crema sobre foto oscura, con el ámbar de marca en la categoría y en la etiqueta de precio. Oscurece la foto para ganar contraste.",
    swatch: "#fbf7f0",
  },
  {
    key: "dark",
    label: "Tinta oscura",
    hint: "Texto azul noche sobre foto clara, con halo crema en vez de sombra. Aclara la foto en lugar de oscurecerla.",
    swatch: "#0a2540",
  },
];

export function EventPanel() {
  const {
    activeDesign,
    pages,
    getCanvasForPage,
    composeEventOnCanvas,
    canvasWidth,
    canvasHeight,
    setActiveCanvas,
    scheduleSave,
  } = useEditor();

  const [copy, setCopy] = useState<EventCopy | null>(null);
  const [mode, setMode] = useState<EventLayoutMode | null>(null);
  const [theme, setTheme] = useState<EventTheme>("light");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recordId = activeDesign?.twenty_record_id ?? null;
  const primaryPage = pages[0] ?? null;

  /** Vuelve a pedir el registro: "rehacer" tiene que usar los datos actuales del CRM, no
   *  los que se leyeron cuando se abrió el editor. */
  const fetchCopy = useCallback(async (): Promise<EventCopy | null> => {
    if (!recordId) return null;
    const record = await api<TwentyRecord>("GET", `/api/twenty/event/${recordId}`);
    if (!record.fields || !record.title) return null;
    // El tipo ya está discriminado por la ruta de la que viene (`/api/twenty/event/...`).
    return buildEventCopy(record.fields as EventFields, record.title);
  }, [recordId]);

  useEffect(() => {
    let cancelled = false;
    fetchCopy()
      .then((c) => {
        if (!cancelled) setCopy(c);
      })
      .catch(() => {
        /* la lista de campos es informativa; un fallo aquí no rompe los botones */
      });
    if (primaryPage) {
      const canvas = getCanvasForPage(primaryPage.id);
      if (canvas) {
        setMode(currentLayoutMode(canvas));
        setTheme(currentTheme(canvas));
      }
    }
    return () => {
      cancelled = true;
    };
  }, [fetchCopy, primaryPage?.id]);

  const regenerate = useCallback(
    async (forced?: EventLayoutMode, forcedTheme?: EventTheme) => {
      if (!primaryPage) return;
      const canvas = getCanvasForPage(primaryPage.id);
      if (!canvas) return;

      // Rehacer borra los bloques generados, incluidos los que el operador haya retocado a
      // mano (conservan la marca). Es la semántica correcta de "rehacer con los datos
      // actuales", pero no debe ocurrir de un clic despistado.
      if (hasEventTemplate(canvas) && !confirm("Se rehará la plantilla con los datos actuales de Twenty. Se perderán los cambios hechos a mano sobre los textos generados. ¿Continuar?")) {
        return;
      }

      setBusy(true);
      setError(null);
      try {
        const fresh = await fetchCopy();
        if (!fresh) throw new Error("El registro no tiene nombre o no devuelve campos.");
        setCopy(fresh);
        // Sin `forced`/`forcedTheme` se conserva lo que ya hubiera puesto: "Rehacer" trae
        // los datos nuevos de Twenty, no devuelve el diseño a los valores por defecto.
        const nextTheme = forcedTheme ?? theme;
        const applied = await composeEventOnCanvas(canvas, primaryPage.id, fresh, {
          pageWidth: canvasWidth,
          pageHeight: canvasHeight,
          mode: forced ?? mode ?? undefined,
          theme: nextTheme,
        });
        setMode(applied);
        setTheme(nextTheme);
        // La plantilla siempre se compone en la página principal, que no tiene por qué ser
        // la que el operador esté mirando — llevarle a ella para que vea el resultado.
        setActiveCanvas(primaryPage.id);
        scheduleSave();
      } catch (e) {
        setError(e instanceof Error ? e.message : "No se pudo rehacer la plantilla.");
      } finally {
        setBusy(false);
      }
    },
    [
      primaryPage,
      getCanvasForPage,
      fetchCopy,
      composeEventOnCanvas,
      canvasWidth,
      canvasHeight,
      setActiveCanvas,
      scheduleSave,
      mode,
      theme,
    ]
  );

  const fields: { label: string; value: string | null }[] = [
    { label: "Título", value: copy?.titulo ?? null },
    { label: "Subtítulo", value: copy?.subtitulo ?? null },
    { label: "Categoría", value: copy?.categoria ?? null },
    { label: "Fecha", value: copy?.fecha ?? null },
    { label: "Lugar", value: copy?.lugar ?? null },
    { label: "Precio", value: copy?.precio ?? null },
  ];

  return (
    <div>
      <p class="text-zinc-400 text-[10px] mb-3 leading-snug">
        La página se compone sola con los campos del evento. Los que estén vacíos en Twenty
        se omiten y el resto sube para ocupar su sitio.
      </p>

      <button
        class="w-full flex items-center justify-center gap-1.5 py-2 mb-3 rounded-md border border-accent/60 bg-accent/10 text-[11px] font-semibold text-accent cursor-pointer transition-all hover:bg-accent/20 disabled:opacity-50"
        title="Vuelve a leer el registro en Twenty y reconstruye los textos. No toca el encuadre de la foto ni lo que hayas añadido a mano."
        disabled={busy || !primaryPage}
        onClick={() => regenerate()}
      >
        {busy ? <span class="spinner !w-3 !h-3 !border-accent/30 !border-t-accent" /> : <RefreshCw size={13} />}
        {busy ? "Rehaciendo..." : "Rehacer plantilla"}
      </button>

      <p class="text-zinc-400 text-[11px] font-semibold mb-1">Composición</p>
      <div class="grid grid-cols-2 gap-1 mb-3">
        {MODES.map((m) => (
          <button
            key={m.key}
            title={m.hint}
            disabled={busy || !primaryPage}
            class={`py-1.5 rounded-md border text-[10px] cursor-pointer transition-all disabled:opacity-50 ${
              mode === m.key
                ? "bg-accent/20 border-accent text-accent"
                : "bg-transparent border-zinc-700 text-zinc-400 hover:text-zinc-50"
            }`}
            onClick={() => regenerate(m.key, undefined)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <p class="text-zinc-400 text-[11px] font-semibold mb-1">Color del texto</p>
      <div class="grid grid-cols-2 gap-1 mb-3">
        {THEMES.map((t) => (
          <button
            key={t.key}
            title={t.hint}
            disabled={busy || !primaryPage}
            class={`flex items-center justify-center gap-1.5 py-1.5 rounded-md border text-[10px] cursor-pointer transition-all disabled:opacity-50 ${
              theme === t.key
                ? "bg-accent/20 border-accent text-accent"
                : "bg-transparent border-zinc-700 text-zinc-400 hover:text-zinc-50"
            }`}
            onClick={() => regenerate(undefined, t.key)}
          >
            <span
              class="w-2.5 h-2.5 rounded-full border border-zinc-500 shrink-0"
              style={{ background: t.swatch }}
            />
            {t.label}
          </button>
        ))}
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
