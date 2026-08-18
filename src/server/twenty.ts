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
  /**
   * Selección GraphQL extra con los campos publicables del objeto, más allá del titular y
   * la imagen. Sigue siendo opcional: un objeto que solo necesite esos dos no lo define y
   * su respuesta no lleva `fields`.
   */
  fieldsSelection?: string;
  /** Cómo convertir esos campos al payload plano que consume el cliente. */
  readFields?: (node: Record<string, any>) => Record<string, unknown>;
  /**
   * Campo Links donde se escribe la versión vertical (1080×1920). Opcional: News no tiene
   * `imagenStory` en esta instancia —comprobado por MCP— y una historia suya cae al campo
   * de siempre en vez de fallar.
   */
  storyImageField?: string;
}

/** Campo Links por defecto donde va la imagen exportada. */
const FEED_IMAGE_FIELD = "imagenEditada";

/** A qué campo del registro va la imagen, según el formato que se haya exportado. */
export type ImageTarget = "feed" | "story";

export function isImageTarget(value: unknown): value is ImageTarget {
  return value === "feed" || value === "story";
}

/**
 * Twenty devuelve los campos de texto vacíos como cadena vacía, no como null — verificado
 * sobre la instancia real: `organizador`, `direccion`, `correoContacto` y los Links llegan
 * como `""` cuando nadie los ha rellenado. Normalizarlo aquí, en el único sitio por el que
 * pasan, evita que cada bloque de la plantilla tenga que repetir la comprobación (y que se
 * cuele un bloque vacío en el diseño porque alguien comprobó `!= null` y no `!== ""`).
 */
function blankToNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const OBJECTS: Record<TwentyObjectType, TwentyObjectDef> = {
  news: {
    queryField: "news",
    updateMutation: "updateNews",
    titleSelection: "title { markdown }",
    readTitle: (node) => node.title?.markdown?.trim() || null,
    // La plantilla de noticias solo necesita el titular (que ya viene arriba) y la sección.
    // `categoria` es un enum de cuatro valores —ACTUALIDAD, DEPORTE, CULTURA, EDUCACION—
    // comprobado por introspección; ojo, **no existe "Sucesos"**, así que el rojo de la
    // guía de marca no tiene ningún valor al que aplicarse. Puede llegar null.
    fieldsSelection: "categoria",
    readFields: (node) => ({ categoria: blankToNull(node.categoria) }),
  },
  event: {
    queryField: "eventCustom",
    updateMutation: "updateEventCustom",
    titleSelection: "name",
    readTitle: (node) => (typeof node.name === "string" ? node.name.trim() || null : null),
    // Los campos que de verdad se publican en un post de agenda. Quedan fuera a propósito:
    // `organizador` y `correoContacto` (vacíos en los 39 registros inspeccionados),
    // `urlWeb`/`fuente`/`enlaceEvento`/`webId` (no van en la imagen) y `comentarios` (notas
    // internas de la redacción).
    fieldsSelection: `
      subtitulo
      fechaDeInicio
      fechaDeFin
      todoElDia
      municipio
      direccion
      precio
      categoria
      destacado
      patrocinado
    `,
    storyImageField: "imagenStory",
    readFields: (node) => ({
      subtitulo: blankToNull(node.subtitulo),
      fechaDeInicio: blankToNull(node.fechaDeInicio),
      fechaDeFin: blankToNull(node.fechaDeFin),
      todoElDia: node.todoElDia === true,
      municipio: blankToNull(node.municipio),
      direccion: blankToNull(node.direccion),
      precio: blankToNull(node.precio),
      categoria: blankToNull(node.categoria),
      destacado: node.destacado === true,
      patrocinado: node.patrocinado === true,
    }),
  },
};

export interface TwentyRecord {
  id: string;
  title: string | null;
  imageUrl: string | null;
  /** Campos publicables del registro (la sección en una noticia, la ficha entera en un
   *  evento), o null si el objeto no declara ninguno. */
  fields: Record<string, unknown> | null;
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
        ${def.fieldsSelection ?? ""}
      }
    }`,
    { id }
  );

  if (!data.record) return null;
  const node = data.record as Record<string, any>;
  return {
    id: data.record.id,
    title: def.readTitle(node),
    imageUrl: data.record.imagen?.[0]?.url || null,
    fields: def.readFields ? def.readFields(node) : null,
  };
}

/**
 * Escribe la URL pública de la imagen exportada en el campo Links que corresponda, y
 * devuelve **cuál** ha sido.
 *
 * El formato vertical va a un campo distinto (`imagenStory`) porque es otra pieza, no otra
 * versión de la misma: la historia y el post del feed se publican por separado. Si se pide
 * el destino de historia para un objeto que no lo tiene, se cae al campo de siempre en vez
 * de fallar — el que llama recibe el nombre real y puede decirlo, que es mejor que perder
 * el trabajo por un campo que falta en el CRM.
 */
export async function setRecordEditedImage(
  type: TwentyObjectType,
  id: string,
  publicUrl: string,
  label: string,
  target: ImageTarget = "feed"
): Promise<string> {
  const def = OBJECTS[type];
  const field = (target === "story" && def.storyImageField) || FEED_IMAGE_FIELD;
  await twentyGraphQL(
    // El nombre del campo se interpola en la query porque GraphQL no admite claves de
    // `data` como variable. Sale de la tabla OBJECTS de este mismo fichero, nunca de la
    // request, así que no hay forma de inyectar nada desde fuera.
    `mutation SetImagenEditada($id: UUID!, $url: String!, $label: String!) {
      ${def.updateMutation}(id: $id, data: { ${field}: { primaryLinkUrl: $url, primaryLinkLabel: $label } }) {
        id
      }
    }`,
    { id, url: publicUrl, label }
  );
  return field;
}
