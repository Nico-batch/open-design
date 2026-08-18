export interface Design {
  id: string;
  name: string;
  canvas_json: string;
  width: number;
  height: number;
  thumbnail_url: string | null;
  twenty_record_id: string | null;
  /** "news" | "event" — null en diseños creados antes del soporte multi-objeto (= news).
   *  Se normaliza con coerceTwentyObjectType (lib/twenty.ts) antes de usarlo. */
  twenty_object_type: string | null;
  created_at: string;
  updated_at: string;
}

/** Datos por defecto que el editor precarga de un registro de Twenty (News o Events):
 *  el título y la imagen de origen, esta última siempre vía nuestro propio proxy. */
export interface TwentyRecord {
  id: string;
  title: string | null;
  imageUrl: string | null;
  /**
   * Campos publicables del registro, distintos por objeto: `NewsFields` para una noticia y
   * `EventFields` para un evento. Quien los lee ya ha discriminado por `objectType` antes
   * (así se eligió la ruta de la que vienen), así que ahí se estrecha el tipo con un `as` —
   * una comprobación en runtime no añadiría nada que no supiéramos ya.
   */
  fields: EventFields | NewsFields | null;
}

/** Lo único que la plantilla de noticias necesita del CRM además del titular. */
export interface NewsFields {
  /** Uno de los cuatro valores del enum de sección; ver SECTION_LABELS en lib/news-fields.ts.
   *  Puede ser null: hay noticias sin categoría asignada. */
  categoria: string | null;
}

/**
 * Campos de un evento tal como los deja el servidor: ya normalizados, con las cadenas
 * vacías de Twenty convertidas a null (ver `blankToNull` en src/server/twenty.ts), así que
 * aquí "no hay dato" es siempre `null` y nunca `""`.
 */
export interface EventFields {
  /** Subtítulo escrito a mano en el CRM. Manda sobre cualquier otra fuente. */
  subtitulo: string | null;
  /** ISO 8601 en UTC — hay que formatearlo en Europe/Madrid (ver lib/event-fields.ts). */
  fechaDeInicio: string | null;
  fechaDeFin: string | null;
  todoElDia: boolean;
  municipio: string | null;
  direccion: string | null;
  /** "GRATIS" | "DE_PAGO" */
  precio: string | null;
  /** Uno de los 15 valores del enum de categoría; ver CATEGORY_LABELS. */
  categoria: string | null;
  destacado: boolean;
  patrocinado: boolean;
}

export interface Page {
  id: string;
  design_id: string;
  title: string;
  canvas_json: string;
  sort_order: number;
  created_at: string;
}

export interface DesignWithPages extends Design {
  pages: Page[];
}

export interface Template {
  id: string;
  name: string;
  category: string;
  canvas_json: string;
  width: number;
  height: number;
  thumbnail_url: string | null;
  sort_order: number;
}
