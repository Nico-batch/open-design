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
