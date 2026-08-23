// Objetos de Twenty a los que sirve el editor. Espejo de la tabla OBJECTS del servidor
// (src/server/twenty.ts), que es donde viven los nombres reales de la API de GraphQL —
// aquí solo se necesita saber qué tipos son válidos y cuál es el de por defecto.

export const TWENTY_OBJECT_TYPES = ["news", "event"] as const;
export type TwentyObjectType = (typeof TWENTY_OBJECT_TYPES)[number];

/** Los diseños creados antes del soporte multi-objeto no tienen tipo guardado, y los
 *  enlaces de Twenty que ya existen apuntan a `?recordId=` sin `objectType`: en ambos
 *  casos son noticias. */
export const DEFAULT_TWENTY_OBJECT_TYPE: TwentyObjectType = "news";

export function coerceTwentyObjectType(value: unknown): TwentyObjectType {
  return typeof value === "string" && (TWENTY_OBJECT_TYPES as readonly string[]).includes(value)
    ? (value as TwentyObjectType)
    : DEFAULT_TWENTY_OBJECT_TYPE;
}

// ── Formato de publicación ───────────────────────────────────────────
//
// El enlace de la ficha declara qué pieza se está editando (`?format=post|story`), y esa
// decisión se guarda en el diseño: post y story del mismo registro son dos borradores
// independientes, con su propio tamaño y su propia maqueta, y cada uno escribe en un campo
// distinto del CRM (`imagenEditada` / `imagenStory`).

export const PUBLICATION_FORMATS = ["post", "story"] as const;
export type PublicationFormat = (typeof PUBLICATION_FORMATS)[number];

/** Los diseños creados antes de distinguir formato no lo tienen guardado, y los enlaces de
 *  Twenty que ya existen apuntan a `?recordId=` sin `format`: en ambos casos son posts. */
export const DEFAULT_PUBLICATION_FORMAT: PublicationFormat = "post";

export function coercePublicationFormat(value: unknown): PublicationFormat {
  return typeof value === "string" && (PUBLICATION_FORMATS as readonly string[]).includes(value)
    ? (value as PublicationFormat)
    : DEFAULT_PUBLICATION_FORMAT;
}
