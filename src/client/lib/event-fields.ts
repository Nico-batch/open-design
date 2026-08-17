import type { EventFields } from "../types";

/**
 * De los campos crudos de un evento de Twenty al texto que se pinta en el post.
 *
 * Todo lo que tenga que ver con *cómo se dice* un dato vive aquí; `event-template.ts` solo
 * se ocupa de dónde se coloca. La separación importa porque las reglas de abajo (sobre todo
 * las de fecha) son las que más van a cambiar con el uso real, y ninguna de ellas necesita
 * saber nada de Fabric.
 */

/**
 * Los eventos son de la provincia de Alicante y el post se publica en español, así que la
 * zona horaria es fija y conocida — no la del navegador del operador, que sería un dato
 * accidental.
 *
 * Esto NO es cosmético: Twenty guarda las fechas en UTC, y en horario de verano peninsular
 * eso son dos horas de diferencia. El espectáculo cuya descripción dice "21:30 h" está
 * almacenado como `2026-08-22T19:30:00.000Z`; formatearlo en UTC publicaría la hora
 * equivocada en la imagen.
 */
const TZ = "Europe/Madrid";
const LOCALE = "es-ES";

/** Etiqueta legible de cada categoría. Un valor que no esté aquí no se pinta: es mejor
 *  omitir la etiqueta que estampar el identificador del enum en el post. */
export const CATEGORY_LABELS: Record<string, string> = {
  CONCIERTOS_Y_MUSICA: "Concierto",
  TEATRO: "Teatro",
  HUMOR_Y_COMEDIA: "Humor",
  FESTIVALES: "Festival",
  OCIO_NOCTURNO: "Ocio nocturno",
  FIESTAS_Y_TRADICIONES: "Fiestas",
  DEPORTE: "Deporte",
  CINE: "Cine",
  CULTURA_Y_EXPOSICIONES: "Cultura",
  GASTRONOMIA: "Gastronomía",
  INFANTIL_Y_FAMILIAR: "Infantil y familiar",
  MERCADOS_Y_FERIAS: "Mercados y ferias",
  CONFERENCIA_Y_CONGRESO_PROFESIONAL: "Congreso",
  MENTALISMO_Y_MAGIA: "Magia",
  DANZA: "Danza",
};

/** Los textos ya formateados. `null` = ese dato no existe en el registro, y el bloque
 *  correspondiente sencillamente no se crea (ver `composeEventPage`). */
export interface EventCopy {
  categoria: string | null;
  titulo: string;
  subtitulo: string | null;
  fecha: string | null;
  lugar: string | null;
  precio: string | null;
}

// ── Fechas ──────────────────────────────────────────────────────────

interface MadridMoment {
  /** "2026-08-22", comparable como cadena. */
  day: string;
  hour: number;
  year: number;
}

/** Descompone un instante en sus partes *en Madrid*, que es lo único que se puede comparar
 *  con seguridad: hacerlo con los getters locales de Date daría el día del operador. */
function madridMoment(iso: string): MadridMoment | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    year: Number(get("year")),
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** "Sábado 22 de agosto", con el año solo cuando hace falta desambiguar. */
function formatDay(iso: string, opts: { weekday: boolean; year: boolean }): string {
  const text = new Intl.DateTimeFormat(LOCALE, {
    timeZone: TZ,
    weekday: opts.weekday ? "long" : undefined,
    day: "numeric",
    month: "long",
    year: opts.year ? "numeric" : undefined,
  }).format(new Date(iso));
  // es-ES da "sábado, 22 de agosto"; la coma sobra en un titular.
  return capitalize(text.replace(",", ""));
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/**
 * Una madrugada no es un segundo día. Un evento de ocio nocturno tiene dos fechas naturales
 * distintas, pero leerlo como "del 7 al 8 de agosto" sería sencillamente falso para quien
 * va a ir: es una sola noche.
 *
 * El límite es 08:00 y no las 06:00 por los datos reales: las sesiones de discoteca de la
 * provincia cierran a las 07:00 hora de Madrid (`21:30Z → 05:00Z`), que con la conversión
 * queda justo por encima de un corte más estrecho. La duración máxima es la otra mitad de
 * la condición — sin ella, un festival de dos días que acabe de mañana pasaría por noche.
 */
const NIGHT_END_HOUR = 8;
const NIGHT_MAX_HOURS = 12;

/** Días naturales entre dos "YYYY-MM-DD" (ambos ya en Madrid). */
function daysBetween(fromDay: string, toDay: string): number {
  const a = Date.parse(`${fromDay}T00:00:00Z`);
  const b = Date.parse(`${toDay}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * La fecha tal como se pinta. Deliberadamente **no** mira qué día es hoy: si lo hiciera, el
 * mismo registro se compondría distinto según cuándo se abra el editor, y un borrador
 * guardado dejaría de coincidir con lo que se ve al reabrirlo.
 */
export function formatEventDate(
  inicio: string | null,
  fin: string | null,
  todoElDia: boolean
): string | null {
  if (!inicio) return null;
  const start = madridMoment(inicio);
  if (!start) return null;

  const end = fin ? madridMoment(fin) : null;

  const hours = end ? (Date.parse(fin!) - Date.parse(inicio)) / 3_600_000 : 0;
  const spansDays =
    end !== null &&
    end.day > start.day &&
    // ...salvo que sea la madrugada del día siguiente (ver NIGHT_END_HOUR).
    !(
      daysBetween(start.day, end.day) === 1 &&
      end.hour < NIGHT_END_HOUR &&
      hours > 0 &&
      hours <= NIGHT_MAX_HOURS
    );

  if (spansDays) {
    const showYear = start.year !== end!.year;
    const from = formatDay(inicio, { weekday: false, year: showYear });
    const to = formatDay(fin!, { weekday: false, year: showYear });
    // "Del 31 de julio al 2 de agosto" — sin horas: en un rango de varios días la hora de
    // inicio del primero engaña más de lo que informa.
    return `Del ${lowerFirst(from)} al ${lowerFirst(to)}`;
  }

  const day = formatDay(inicio, { weekday: true, year: false });
  // Sin hora si es de todo el día. Tampoco se pinta la hora de fin aunque exista: en un
  // post lo que se necesita saber es a qué hora hay que estar allí.
  return todoElDia ? day : `${day} · ${formatTime(inicio)} h`;
}

// ── Nombre → titular ────────────────────────────────────────────────

/**
 * Muchos nombres traen algo pegado detrás de un separador ("PARTIENDO LA PANA | Tributo a
 * Estopa", "Marisol Delgado – Espectáculo Flamenco"). El titular se queda solo con la parte
 * de delante: un titular con "|" dentro no se lee bien a cuerpo grande.
 *
 * Lo de detrás **ya no se usa como subtítulo**. Ese sale únicamente del campo `subtitulo`
 * del CRM — ver `buildEventCopy`.
 *
 * Los guiones exigen espacios alrededor: uno pegado casi siempre forma parte de una palabra
 * ("Low-Cost"), mientras que uno suelto separa de verdad.
 */
const TITLE_SEPARATOR = /\s*\|\s*|\s+[–—-]\s+/;
const MIN_PART = 3;

function titleFromName(name: string): string {
  const parts = name
    .split(TITLE_SEPARATOR)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return name.trim();
  const [titulo, ...rest] = parts;
  // Si cualquiera de las dos mitades es un fragmento, el separador no estaba separando
  // nada y el nombre se deja entero.
  if (titulo.length < MIN_PART || rest.join(" ").length < MIN_PART) return name.trim();
  return titulo;
}

// ── Todo junto ──────────────────────────────────────────────────────

export function buildEventCopy(fields: EventFields, name: string): EventCopy {
  // El sitio concreto primero y el municipio después: "Magma Club · Alicante" se lee como
  // una dirección, y cualquiera de los dos puede faltar.
  const lugar = [fields.direccion, fields.municipio].filter(Boolean).join(" · ") || null;

  return {
    categoria: fields.categoria ? CATEGORY_LABELS[fields.categoria] ?? null : null,
    titulo: titleFromName(name),
    // Una única fuente, a propósito. Antes se intentaba deducir del trozo que hubiera
    // detrás del separador del nombre o de la primera frase de `descripcion`, pero eso es
    // adivinar: la descripción está redactada para la ficha web, no para un post, y lo que
    // salía de ahí había que reescribirlo casi siempre. Si nadie ha escrito un subtítulo en
    // el CRM, no hay subtítulo — y el bloque sencillamente no se crea.
    subtitulo: fields.subtitulo,
    fecha: formatEventDate(fields.fechaDeInicio, fields.fechaDeFin, fields.todoElDia),
    lugar,
    // Solo se destaca lo gratuito: es el mayor gancho de un post de agenda. "De pago" no
    // aporta nada — el precio real no está en el CRM, así que decirlo solo ocuparía sitio.
    precio: fields.precio === "GRATIS" ? "GRATIS" : null,
  };
}
