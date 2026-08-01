import { useEffect, useRef, useState } from "preact/hooks";
import { Smile } from "lucide-preact";
import { EMOJI_FONT_FAMILY } from "../lib/fonts";

/**
 * Curated set rather than the full Unicode catalogue: this is a picker for headlines on
 * social posts, not a chat keyboard, and a few dozen well-chosen ones are quicker to scan
 * than thousands. The operator can still type any other emoji with the system picker
 * (Win + . on Windows) — this is the shortcut, not the only way in.
 */
const GROUPS: Array<{ label: string; emojis: string[] }> = [
  {
    label: "Caras",
    emojis: ["😀", "😃", "😄", "😁", "😉", "😍", "🥰", "😎", "🤩", "🥳", "😯", "😱", "🤔", "😴", "😢", "😡"],
  },
  {
    label: "Gestos",
    emojis: ["👍", "👏", "🙌", "🙏", "💪", "🤝", "👇", "👉", "👈", "☝️", "✌️", "🫶", "❤️", "🧡", "💛", "💚", "💙", "💜", "🔥", "✨"],
  },
  {
    label: "Eventos",
    emojis: ["🎉", "🎊", "🎈", "🎁", "🎂", "🥂", "🍻", "🎶", "🎵", "🎤", "🎸", "🎬", "🎭", "🎪", "🎨", "📸", "🏆", "🥇", "⚽", "🏀"],
  },
  {
    label: "Lugares y tiempo",
    emojis: ["📍", "🗓️", "⏰", "🌊", "🏖️", "⛱️", "🌅", "🌇", "☀️", "🌤️", "🌧️", "⛈️", "❄️", "🌡️", "🚗", "🚌", "🚆", "✈️", "🏛️", "⛪"],
  },
  {
    label: "Avisos",
    emojis: ["⚠️", "❗", "❓", "✅", "❌", "🚨", "📢", "📣", "🔔", "ℹ️", "🆕", "🔴", "🟢", "🔵", "⭐", "💡", "📌", "🔗", "📝", "🗞️"],
  },
  {
    label: "Comida",
    emojis: ["🍽️", "🍕", "🍔", "🥘", "🥗", "🍤", "🍮", "🍦", "☕", "🍷", "🍺", "🍾", "🥖", "🧀", "🍊", "🍉"],
  },
  {
    label: "Banderas",
    emojis: ["🇪🇸", "🇪🇺", "🇬🇧", "🇫🇷", "🇮🇹", "🇩🇪", "🇵🇹", "🏳️‍🌈", "🏁", "🚩"],
  },
];

interface EmojiPickerProps {
  onPick: (emoji: string) => void;
}

export function EmojiPicker({ onPick }: EmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div class="relative" ref={rootRef}>
      <button
        class={`w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md border text-[11px] cursor-pointer transition-all ${
          open
            ? "bg-accent/20 border-accent text-accent"
            : "bg-transparent border-zinc-700 text-zinc-400 hover:text-zinc-50"
        }`}
        title="Insertar emoji en el texto"
        // Sin esto el botón roba el foco al cuadro de texto en edición, Fabric cierra la
        // edición y el emoji acabaría al final en vez de donde está el cursor.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <Smile size={14} />
        Emoji
      </button>

      {open && (
        <div
          class="absolute right-0 z-30 mt-1 w-[248px] max-h-[300px] overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-800 shadow-xl p-2"
          onMouseDown={(e) => e.preventDefault()}
        >
          {GROUPS.map((group) => (
            <div key={group.label} class="mb-2 last:mb-0">
              <div class="text-[10px] uppercase tracking-wider text-zinc-500 px-1 mb-1">
                {group.label}
              </div>
              <div class="grid grid-cols-8 gap-0.5">
                {group.emojis.map((emoji) => (
                  <button
                    key={emoji}
                    class="h-7 w-7 flex items-center justify-center rounded bg-transparent border-none cursor-pointer text-[17px] leading-none hover:bg-zinc-700 transition-colors"
                    // Se pinta con la MISMA fuente que el lienzo, para que lo que se elige
                    // aquí sea exactamente lo que aparece en el diseño — con la del
                    // sistema, en Windows una bandera se vería aquí como las letras del país.
                    style={{ fontFamily: `"${EMOJI_FONT_FAMILY}", sans-serif` }}
                    title={emoji}
                    onClick={() => {
                      onPick(emoji);
                      setOpen(false);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
