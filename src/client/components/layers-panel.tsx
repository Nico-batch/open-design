import { useState, useMemo } from "preact/hooks";
import {
  Type,
  Image as ImageIcon,
  Square,
  Droplets,
  Layers as LayersIcon,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  ChevronUp,
  ChevronDown,
  Trash2,
  GripVertical,
} from "lucide-preact";
import { useEditor } from "../context";
import type { LayerKind } from "../lib/layers";

/**
 * La pila de objetos de la página, de arriba abajo.
 *
 * Resuelve tres cosas que hasta ahora no tenían salida desde la interfaz: seleccionar algo que
 * está tapado por otra cosa (con la plantilla de noticias puesta, el cristal desenfocado cubre
 * la fotografía entera), **ocultar** una capa un momento para ver lo que hay debajo, y
 * reordenar sin depender de en qué orden se añadieron los objetos.
 *
 * Todo el conocimiento de Fabric está en `lib/layers.ts`; esto solo pinta y enruta clics.
 */

const ICONS: Record<LayerKind, typeof Type> = {
  photo: ImageIcon,
  image: ImageIcon,
  glass: Droplets,
  scrim: Droplets,
  text: Type,
  shape: Square,
};

export function LayersPanel() {
  const {
    layersVersion,
    getLayers,
    selectLayer,
    setLayerVisibility,
    setLayerLock,
    shiftLayer,
    dropLayer,
    removeLayer,
    selectedObject,
    selectionVersion,
    activeCanvasId,
  } = useEditor();

  // La fila que se está arrastrando y el hueco donde caería. `null` = no hay arrastre.
  const [dragRow, setDragRow] = useState<number | null>(null);
  const [dropRow, setDropRow] = useState<number | null>(null);

  // Los objetos de Fabric se mutan en el sitio, así que la lista se recalcula cuando alguno de
  // los dos contadores cambia — no cuando cambia una referencia, que nunca cambia.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layers = useMemo(() => getLayers(), [getLayers, layersVersion, selectionVersion, activeCanvasId]);

  if (layers.length === 0) {
    return (
      <div>
        <p class="text-zinc-400 text-[11px] leading-snug">
          La página está vacía. Todo lo que añadas —textos, formas, imágenes, la foto de
          fondo— aparecerá aquí, de arriba abajo según lo que tape a lo demás.
        </p>
      </div>
    );
  }

  /** El botón redondo de la derecha de cada fila. */
  const iconButton = (
    title: string,
    active: boolean,
    disabled: boolean,
    onClick: () => void,
    children: preact.ComponentChildren,
    danger = false
  ) => (
    <button
      class={`p-0.5 rounded bg-transparent border-none transition-all disabled:opacity-25 disabled:cursor-default ${
        danger
          ? "text-zinc-500 cursor-pointer hover:text-red-400 hover:bg-red-500/10"
          : active
            ? "text-accent cursor-pointer hover:bg-zinc-700"
            : "text-zinc-500 cursor-pointer hover:text-zinc-100 hover:bg-zinc-700"
      }`}
      title={title}
      disabled={disabled}
      // Sin esto, pulsar un botón de la fila saca al `Textbox` que se estuviera editando de
      // su sesión de edición (el mismo motivo que el `keepFocus` del panel derecho, §9.21).
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );

  /** Suelta la fila arrastrada donde marque el indicador. */
  const commitDrop = (e: DragEvent) => {
    e.preventDefault();
    if (dragRow !== null && dropRow !== null) dropLayer(dragRow, dropRow);
    setDragRow(null);
    setDropRow(null);
  };

  return (
    <div>
      <p class="text-zinc-400 text-[10px] mb-3 leading-snug">
        De arriba abajo, según qué tapa a qué. Arrastra una fila por su nombre para
        reordenar, o usa las flechas. El ojo la oculta —también en la imagen exportada— y el
        candado la deja fija en el lienzo.
      </p>

      <ul
        class="flex flex-col gap-0.5"
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => setDropRow(null)}
        // Entre fila y fila hay un par de píxeles de separación, y soltar justo ahí no llegaba
        // a ninguna fila: el arrastre se perdía sin decir nada. Aquí se recoge esa suelta y se
        // aplica el último hueco marcado, que es donde el indicador estaba enseñando que iba.
        onDrop={commitDrop}
      >
        {layers.map((layer, row) => {
          const Icon = ICONS[layer.kind];
          const isSelected = selectedObject === layer.obj;
          return (
            <li
              key={row}
              draggable
              onDragStart={(e) => {
                setDragRow(row);
                // Sin `setData` Firefox no inicia el arrastre.
                e.dataTransfer?.setData("text/plain", String(row));
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => {
                setDragRow(null);
                setDropRow(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                // La mitad de arriba de la fila inserta antes de ella; la de abajo, después.
                const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setDropRow(e.clientY < box.top + box.height / 2 ? row : row + 1);
              }}
              onDrop={commitDrop}
              class={`group flex items-center gap-1 pl-0.5 pr-0.5 py-1 rounded-md border transition-all ${
                isSelected
                  ? "bg-accent/15 border-accent"
                  : "bg-zinc-800 border-zinc-800 hover:border-zinc-600"
              } ${dragRow === row ? "opacity-40" : ""} ${
                dropRow === row ? "border-t-accent" : dropRow === row + 1 ? "border-b-accent" : ""
              }`}
            >
              <GripVertical size={10} class="text-zinc-600 shrink-0 cursor-grab" />

              {/* Deliberadamente un <div role="button"> y no un <button>: **Chromium no
                  arranca un arrastre desde un elemento de formulario**, ni siquiera con
                  `draggable={false}`, así que con un botón aquí la fila solo se podía
                  arrastrar por los pocos píxeles del asa. Con un div, todo el lado del
                  nombre —que es la mitad de la fila— sirve para arrastrar, y el rol y el
                  `tabIndex` conservan el teclado. */}
              <div
                role="button"
                tabIndex={layer.locked ? -1 : 0}
                class="flex-1 min-w-0 flex items-center gap-1 text-left cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-accent rounded"
                title={layer.locked ? `${layer.name} — bloqueada` : `Seleccionar «${layer.name}»`}
                // Sin `preventDefault` aquí, a diferencia de los botones de la derecha:
                // cancelar el `mousedown` cancela también el arrastre que el navegador iba a
                // iniciar, y esta es justo la zona por la que se agarra la fila. Tampoco hace
                // falta: elegir otra capa debe sacar del texto que se estuviera editando.
                onClick={() => !layer.locked && selectLayer(layer.obj)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  if (!layer.locked) selectLayer(layer.obj);
                }}
              >
                <Icon size={12} class={`shrink-0 ${isSelected ? "text-accent" : "text-zinc-500"}`} />
                <span
                  class={`truncate text-[11px] ${
                    !layer.visible
                      ? "text-zinc-600 line-through"
                      : isSelected
                        ? "text-accent"
                        : layer.fromTemplate
                          ? "text-zinc-400"
                          : "text-zinc-200"
                  }`}
                >
                  {layer.name}
                </span>
              </div>

              <div class="flex items-center shrink-0">
                {iconButton("Subir una posición", false, row === 0, () => shiftLayer(layer.obj, 1), (
                  <ChevronUp size={11} />
                ))}
                {iconButton(
                  "Bajar una posición",
                  false,
                  row === layers.length - 1,
                  () => shiftLayer(layer.obj, -1),
                  <ChevronDown size={11} />
                )}
                {iconButton(
                  layer.visible ? "Ocultar (también en la exportación)" : "Mostrar",
                  !layer.visible,
                  false,
                  () => setLayerVisibility(layer.obj, !layer.visible),
                  layer.visible ? <Eye size={11} /> : <EyeOff size={11} />
                )}
                {iconButton(
                  layer.locked ? "Desbloquear" : "Bloquear: deja de responder al ratón",
                  layer.locked,
                  false,
                  () => setLayerLock(layer.obj, !layer.locked),
                  layer.locked ? <Lock size={11} /> : <Unlock size={11} />
                )}
                {iconButton(
                  "Eliminar",
                  false,
                  layer.locked,
                  () => removeLayer(layer.obj),
                  <Trash2 size={11} />,
                  true
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <p class="text-zinc-500 text-[10px] mt-3 leading-snug flex gap-1.5">
        <LayersIcon size={11} class="shrink-0 mt-0.5" />
        <span>
          Las capas en gris las genera una plantilla. Reordenarlas entre sí no sobrevive a un
          cambio de formato, que vuelve a maquetar la plantilla entera.
        </span>
      </p>
    </div>
  );
}
