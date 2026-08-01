const TWENTY_API_URL = process.env.TWENTY_API_URL;
const TWENTY_TOKEN = process.env.TWENTY_TOKEN;

async function twentyGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  if (!TWENTY_API_URL || !TWENTY_TOKEN) {
    throw new Error("TWENTY_API_URL/TWENTY_TOKEN no configurados en el servidor");
  }
  let res: Response;
  try {
    res = await fetch(`${TWENTY_API_URL}/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TWENTY_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      // Sin esto, una Twenty lenta/caída deja la request del navegador colgada
      // indefinidamente (nuestro handler nunca responde) en vez de fallar rápido con un
      // 502 explicable — un timeout intermedio (proxy de Vite en dev, Traefik en prod)
      // acabaría cortando la conexión igualmente, pero como un fallo de red genérico
      // ("Failed to fetch" en el cliente) sin ninguna pista de la causa real.
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new Error("Twenty no respondió a tiempo (timeout de 15s)");
    }
    throw new Error(`No se pudo conectar con Twenty: ${e instanceof Error ? e.message : String(e)}`);
  }
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Twenty GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  return json.data as T;
}

// ── Objetos de Twenty soportados ────────────────────────────────────
//
// El editor sirve a más de un objeto del CRM: una noticia (News) y un evento (Events).
// Los dos comparten exactamente la misma mecánica — un campo Files "Imagen" del que sale
// la foto de origen y un campo Links "Imagen Editada" donde se escribe la URL pública del
// resultado —, así que lo único que cambia entre ellos son los nombres de la API de
// GraphQL y de qué campo sale el título por defecto. Eso es lo que describe esta tabla;
// el resto del código (rutas, cliente) es genérico y solo pasa el tipo por parámetro.
//
// Los nombres de abajo están confirmados por introspección contra la instancia real:
// el objeto personalizado "Events" se expone como `eventCustom`/`updateEventCustom`
// (Twenty le añade el sufijo `Custom` porque `Event` choca con un nombre del núcleo) —
// NO como `event`, que no existe. Su título es `name` (String), mientras que el de News
// es `title` (RichText, se lee el subcampo `markdown`).

export const TWENTY_OBJECT_TYPES = ["news", "event"] as const;
export type TwentyObjectType = (typeof TWENTY_OBJECT_TYPES)[number];

export function isTwentyObjectType(value: unknown): value is TwentyObjectType {
  return typeof value === "string" && (TWENTY_OBJECT_TYPES as readonly string[]).includes(value);
}

interface TwentyObjectDef {
  /** Campo raíz singular de la query (`news(filter: ...)`). */
  queryField: string;
  /** Mutación de actualización (`updateNews(id:, data:)`). */
  updateMutation: string;
  /** Trozo de selección GraphQL del campo del que sale el título por defecto. */
  titleSelection: string;
  /** Cómo leer ese campo de la respuesta. */
  readTitle: (node: Record<string, any>) => string | null;
}

const OBJECTS: Record<TwentyObjectType, TwentyObjectDef> = {
  news: {
    queryField: "news",
    updateMutation: "updateNews",
    titleSelection: "title { markdown }",
    readTitle: (node) => node.title?.markdown?.trim() || null,
  },
  event: {
    queryField: "eventCustom",
    updateMutation: "updateEventCustom",
    titleSelection: "name",
    readTitle: (node) => (typeof node.name === "string" ? node.name.trim() || null : null),
  },
};

export interface TwentyRecord {
  id: string;
  title: string | null;
  imageUrl: string | null;
}

/** Lee el registro: su título por defecto y la URL (firmada, de corta duración) de la
 *  imagen de origen. Esa URL nunca se manda al cliente — se proxea (ver index.ts). */
export async function fetchRecord(type: TwentyObjectType, id: string): Promise<TwentyRecord | null> {
  const def = OBJECTS[type];
  const data = await twentyGraphQL<{
    record: {
      id: string;
      imagen: Array<{ url: string | null }> | null;
    } | null;
  }>(
    `query GetTwentyRecord($id: UUID!) {
      record: ${def.queryField}(filter: { id: { eq: $id } }) {
        id
        ${def.titleSelection}
        imagen { url }
      }
    }`,
    { id }
  );

  if (!data.record) return null;
  return {
    id: data.record.id,
    title: def.readTitle(data.record as Record<string, any>),
    imageUrl: data.record.imagen?.[0]?.url || null,
  };
}

/** Escribe la URL pública del PNG/JPEG exportado en el campo Links "Imagen Editada". */
export async function setRecordEditedImage(
  type: TwentyObjectType,
  id: string,
  publicUrl: string,
  label: string
): Promise<void> {
  const def = OBJECTS[type];
  await twentyGraphQL(
    `mutation SetImagenEditada($id: UUID!, $url: String!, $label: String!) {
      ${def.updateMutation}(id: $id, data: { imagenEditada: { primaryLinkUrl: $url, primaryLinkLabel: $label } }) {
        id
      }
    }`,
    { id, url: publicUrl, label }
  );
}
