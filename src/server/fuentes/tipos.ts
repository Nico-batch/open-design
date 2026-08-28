// ── La fuente: de dónde salen los registros y a dónde vuelve el arte ─────────
//
// Este editor sirve a dos sistemas: Twenty CRM, que es de donde viene, y Directus, el CMS
// que va a sustituirlo. No hay fork: hay dos implementaciones de la interfaz de abajo y una
// variable de entorno (`FUENTE`) que elige cuál corre. Todo lo demás del servidor —rutas,
// designs, pages, uploads— y **todo** el cliente son agnósticos y solo pasan
// `objectType`/`format` de largo.
//
// El vocabulario de la URL sigue siendo el de Twenty (`news`/`event`) en las dos fuentes a
// propósito: la de Directus lo traduce a `noticia`/`evento` por dentro (los valores de
// `contenidos.tipo`). Un solo vocabulario en la URL es lo que evita bifurcar plantillas,
// tamaños por defecto y tipos del cliente.

export const TWENTY_OBJECT_TYPES = ["news", "event"] as const;
export type TwentyObjectType = (typeof TWENTY_OBJECT_TYPES)[number];

export function isTwentyObjectType(value: unknown): value is TwentyObjectType {
  return typeof value === "string" && (TWENTY_OBJECT_TYPES as readonly string[]).includes(value);
}

// ── Formato de publicación ──────────────────────────────────────────
//
// De cada registro se maquetan dos piezas distintas: el post del feed y la story vertical.
// Cuál se está editando lo declara el enlace de la ficha (`?format=post|story`) y se guarda
// con el diseño, así que son dos borradores independientes del mismo registro. Espejo de
// `src/client/lib/twenty.ts`.

export const PUBLICATION_FORMATS = ["post", "story"] as const;
export type PublicationFormat = (typeof PUBLICATION_FORMATS)[number];

/** Los enlaces de las fichas que ya existen apuntan a `?recordId=` sin `format`, y los
 *  diseños creados antes de esta distinción no lo tienen guardado: en ambos casos son posts. */
export const DEFAULT_PUBLICATION_FORMAT: PublicationFormat = "post";

export function coercePublicationFormat(value: unknown): PublicationFormat {
  return typeof value === "string" && (PUBLICATION_FORMATS as readonly string[]).includes(value)
    ? (value as PublicationFormat)
    : DEFAULT_PUBLICATION_FORMAT;
}

/** A qué pieza del registro corresponde el arte exportado. */
export type ImageTarget = "feed" | "story";

export function isImageTarget(value: unknown): value is ImageTarget {
  return value === "feed" || value === "story";
}

/** Datos por defecto con los que el editor precarga un registro. */
export interface RegistroEditable {
  id: string;
  title: string | null;
  /** URL de origen de la imagen, **tal como la ve el servidor**: puede llevar un token
   *  firmado o exigir una cabecera. Nunca sale hacia el navegador; se proxea. */
  imageUrl: string | null;
  /** Campos publicables del registro (la sección en una noticia, la ficha entera en un
   *  evento), o null si el objeto no declara ninguno. */
  fields: Record<string, unknown> | null;
}

export interface Fuente {
  /** Cómo se llama, para el health check y para lo que el operador ve en el toolbar. */
  readonly nombre: "twenty" | "directus";

  leerRegistro(tipo: TwentyObjectType, id: string): Promise<RegistroEditable | null>;

  /**
   * Los bytes de la imagen de origen, ya pedidos al sistema de turno.
   *
   * Devuelve la `Response` cruda para que la ruta haga el streaming sin materializar la
   * imagen en memoria. Existe como método de la fuente —y no como un `fetch` en la ruta
   * sobre `imageUrl`— porque cada sistema autoriza a su manera: Twenty firma la URL,
   * Directus exige una cabecera.
   */
  leerImagenOrigen(tipo: TwentyObjectType, id: string): Promise<Response | null>;

  /**
   * Deja el arte exportado donde corresponda y devuelve **dónde** ha quedado.
   *
   * `campo` es lo que el editor le enseña al operador: el nombre del campo del CRM en la
   * fuente `twenty`, el campo de `contenidos` (`arte_post`/`arte_story`) en la de `directus`.
   */
  guardarArte(
    tipo: TwentyObjectType,
    id: string,
    bytes: ArrayBuffer,
    mime: string,
    target: ImageTarget,
  ): Promise<{ campo: string; url: string }>;
}
