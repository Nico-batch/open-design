import { COLOR_PRESETS } from "../lib/palette";

/**
 * Un selector de color con las muestras de marca debajo.
 *
 * Sustituye al bloque `input[type=color]` + campo hexadecimal que estaba repetido ocho veces
 * por el editor. La parte nueva son las muestras: poner el ámbar o el azul noche en una
 * palabra obligaba a teclear el hexadecimal de memoria, que es justo el gesto que hace que
 * nadie use la paleta de la marca.
 */

interface ColorFieldProps {
  /** El color actual, en hexadecimal. */
  value: string;
  onChange: (hex: string) => void;
  /**
   * Para los controles del panel de texto: `keepFocus` en el `input[type=color]` y en el
   * campo hexadecimal, de modo que abrir el diálogo del sistema no borre el resaltado de la
   * palabra seleccionada (§9.21). Las muestras lo hacen siempre, lo pase quien lo pase.
   */
  onMouseDown?: (e: Event) => void;
  /** Normalmente `onEnter(restoreTextFocus)`: devuelve el teclado al lienzo al confirmar. */
  onKeyDown?: (e: KeyboardEvent) => void;
  /** Texto del campo hexadecimal cuando la selección abarca varios colores. */
  placeholder?: string;
  /** Lo que enseña el campo hexadecimal; `value` sigue mandando en la muestra y el diálogo. */
  text?: string;
}

export function ColorField({
  value,
  onChange,
  onMouseDown,
  onKeyDown,
  placeholder,
  text,
}: ColorFieldProps) {
  // En minúsculas: un `#F4A825` tecleado a mano es el mismo ámbar y la muestra tiene que
  // reconocerse como activa igual.
  const current = (value || "").trim().toLowerCase();

  return (
    <div>
      <div class="flex items-center gap-2">
        <input
          type="color"
          class="w-8 h-8 rounded border border-zinc-700 cursor-pointer bg-transparent shrink-0"
          value={value}
          onMouseDown={onMouseDown}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        />
        <input
          type="text"
          class="flex-1 bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-200 px-2 py-1.5 outline-none focus:border-accent font-mono"
          value={text ?? value}
          placeholder={placeholder}
          onMouseDown={onMouseDown}
          onKeyDown={onKeyDown}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class="flex gap-1 mt-1.5">
        {COLOR_PRESETS.map((preset) => (
          <button
            key={preset.hex}
            type="button"
            title={`${preset.label} — ${preset.hex}`}
            class={`flex-1 h-5 rounded border cursor-pointer transition-all hover:scale-110 ${
              current === preset.hex ? "border-accent ring-1 ring-accent" : "border-zinc-600"
            }`}
            style={{ background: preset.hex }}
            // Siempre, no solo cuando el llamante pasa `onMouseDown`: sin esto, pulsar una
            // muestra saca al `Textbox` de edición y el color se aplicaría al cuadro entero
            // en vez de a la palabra seleccionada.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(preset.hex)}
          />
        ))}
      </div>
    </div>
  );
}
