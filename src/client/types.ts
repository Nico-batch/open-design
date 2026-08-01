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
