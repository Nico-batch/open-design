import type {
  Fuente,
  ImageTarget,
  RegistroEditable,
  TwentyObjectType,
} from "./tipos.js";

// ── Directus ──────────────────────────────────────────────────────
//
// La fuente que sustituye a Twenty. Habla REST contra una única colección
// (`contenidos`, con `tipo = "noticia" | "evento"`) en vez de dos objetos de CRM, así que
// aquí no hay una tabla `OBJECTS` como en `twenty.ts`: solo la traducción `news`/`event` ↔
// `noticia`/`evento` y el nombre de campo del arte según el formato.
//
// El contrato entero (colecciones, roles, permisos) está documentado en
// `../DirectusCMS/README.md` y `../DirectusCMS/CLAUDE.md`, en el otro repositorio.

const DIRECTUS_URL = process.env.DIRECTUS_URL;
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN;
const DIRECTUS_ARTE_PUBLICO_FOLDER = process.env.DIRECTUS_ARTE_PUBLICO_FOLDER;

/** Cómo se llama cada tipo del editor en `contenidos.tipo`. */
const TIPOS: Record<TwentyObjectType, string> = {
  news: "noticia",
  event: "evento",
};

/** Campo de `contenidos` donde vive el arte de cada formato. */
const CAMPO_ARTE: Record<ImageTarget, "arte_post" | "arte_story"> = {
  feed: "arte_post",
  story: "arte_story",
};

function base(): string {
  if (!DIRECTUS_URL || !DIRECTUS_TOKEN) {
    throw new Error("DIRECTUS_URL/DIRECTUS_TOKEN no configurados en el servidor");
  }
  return DIRECTUS_URL.replace(/\/$/, "");
}

/**
 * Los mismos errores explicables que la fuente de Twenty, y por el mismo motivo: sin
 * timeout, un Directus lento deja la petición del navegador colgada hasta que la corta algún
 * proxy intermedio, y desde el cliente eso se ve exactamente igual que un fallo de red, sin
 * ninguna pista de la causa.
 */
async function pedir(ruta: string, init: RequestInit = {}, ms = 15000): Promise<Response> {
  try {
    return await fetch(`${base()}${ruta}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${DIRECTUS_TOKEN}` },
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new Error(`Directus no respondió a tiempo (timeout de ${ms / 1000}s)`);
    }
    throw new Error(`No se pudo conectar con Directus: ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface ContenidoDirectus {
  id: string;
  tipo: string;
  titulo: string | null;
  subtitulo: string | null;
  imagen: string | null;
  arte_post: string | null;
  arte_story: string | null;
  categoria: { nombre: string } | null;
  municipio: { nombre: string } | null;
  inicio: string | null;
  fin: string | null;
  todo_el_dia: boolean;
  direccion: string | null;
  precio: string | null;
  destacado: boolean;
  patrocinado: boolean;
}

const CAMPOS = [
  "id", "tipo", "titulo", "subtitulo", "imagen", "arte_post", "arte_story",
  "categoria.nombre", "municipio.nombre", "inicio", "fin", "todo_el_dia",
  "direccion", "precio", "destacado", "patrocinado",
].join(",");

/**
 * Directus no distingue "no tienes permiso" de "no existe" para un id concreto: las dos
 * cosas responden 403 (verificado contra la instancia real). El 404 se comprueba también
 * por si acaso, pero en la práctica es el 403 el que hay que tratar como "no encontrado".
 */
async function leerContenido(tipo: TwentyObjectType, id: string): Promise<ContenidoDirectus | null> {
  const res = await pedir(`/items/contenidos/${encodeURIComponent(id)}?fields=${CAMPOS}`);
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) {
    const cuerpo = await res.text().catch(() => "");
    throw new Error(`Directus respondió ${res.status}: ${cuerpo.slice(0, 200)}`);
  }
  const { data } = (await res.json()) as { data: ContenidoDirectus };

  // Si el enlace pide una noticia y el id es de un evento, componer la plantilla de noticia
  // sobre él sería peor que no abrir nada. La expectativa sobre el tipo la trae el editor,
  // en el `objectType` de la URL — igual que en la fuente de Twenty.
  if (data.tipo !== TIPOS[tipo]) return null;
  return data;
}

export const fuenteDirectus: Fuente = {
  nombre: "directus",

  async leerRegistro(tipo, id): Promise<RegistroEditable | null> {
    const c = await leerContenido(tipo, id);
    if (!c) return null;

    // Mismos nombres de campo que la fuente de Twenty (`fechaDeInicio`, `todoElDia`...),
    // aunque en Directus se llamen distinto (`inicio`, `todo_el_dia`...): las plantillas del
    // cliente (`event-fields.ts`) son agnósticas de la fuente y esperan ese vocabulario.
    const fields =
      tipo === "event"
        ? {
            subtitulo: c.subtitulo,
            fechaDeInicio: c.inicio,
            fechaDeFin: c.fin,
            todoElDia: c.todo_el_dia === true,
            municipio: c.municipio?.nombre ?? null,
            direccion: c.direccion,
            precio: c.precio,
            // Llega el nombre legible de la categoría («Conciertos y música»), no una clave
            // de enum: el catálogo de `categorias` en Directus se sincroniza desde la web
            // (ver DirectusCMS), no es el ENUM de 15 valores que tenía Twenty. Las
            // plantillas lo pintan tal cual gracias al fallback de `CATEGORY_LABELS`.
            categoria: c.categoria?.nombre ?? null,
            destacado: c.destacado === true,
            patrocinado: c.patrocinado === true,
          }
        : { categoria: c.categoria?.nombre ?? null };

    return {
      id: c.id,
      title: c.titulo?.trim() || null,
      imageUrl: c.imagen ? `${base()}/assets/${c.imagen}` : null,
      fields,
    };
  },

  async leerImagenOrigen(tipo, id) {
    const c = await leerContenido(tipo, id);
    if (!c?.imagen) return null;
    // La foto de origen no está en la carpeta pública `arte-publico`: hace falta la
    // cabecera, a diferencia de la URL firmada que ya trae Twenty.
    return pedir(`/assets/${c.imagen}`, {}, 30000);
  },

  /**
   * A diferencia de Twenty (un campo Links con una URL), en Directus el arte **es** un
   * fichero de la colección `directus_files`. Si ya había uno para este formato, se
   * reemplaza su binario (`PATCH /files/{uuid}`) en vez de subir uno nuevo: así la URL
   * pública no cambia, y si el arte se reedita después de programar la publicación, Meta
   * descarga la versión buena sin que nadie tenga que tocar la fila de `publicaciones`.
   */
  async guardarArte(tipo, id, bytes, mime, target: ImageTarget) {
    const campo = CAMPO_ARTE[target];
    const ext = mime === "image/png" ? "png" : "jpg";
    const uuidExistente = (await leerContenido(tipo, id))?.[campo] ?? null;

    let res: Response;
    if (uuidExistente) {
      const cuerpo = new FormData();
      cuerpo.append("file", new File([bytes], `${campo}.${ext}`, { type: mime }));
      res = await pedir(`/files/${uuidExistente}`, { method: "PATCH", body: cuerpo }, 60000);
    } else {
      if (!DIRECTUS_ARTE_PUBLICO_FOLDER) {
        throw new Error("DIRECTUS_ARTE_PUBLICO_FOLDER no configurado en el servidor");
      }
      const cuerpo = new FormData();
      cuerpo.append("folder", DIRECTUS_ARTE_PUBLICO_FOLDER);
      cuerpo.append("file", new File([bytes], `${campo}.${ext}`, { type: mime }));
      res = await pedir(`/files`, { method: "POST", body: cuerpo }, 60000);
    }
    if (!res.ok) {
      const cuerpoErr = await res.text().catch(() => "");
      console.error(`[directus ${tipo}/${id}] Directus rechazó el arte: ${res.status} ${cuerpoErr.slice(0, 300)}`);
      throw new Error(`Directus rechazó el arte (${res.status}): ${cuerpoErr.slice(0, 200)}`);
    }
    const { data } = (await res.json()) as { data: { id: string } };
    const archivoId = uuidExistente ?? data.id;

    // Solo hace falta enlazar `contenidos.<campo>` cuando el fichero es nuevo: al
    // reemplazar un binario existente (`PATCH /files/{uuid}`), el enlace ya estaba puesto.
    if (!uuidExistente) {
      const patch = await pedir(`/items/contenidos/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [campo]: archivoId }),
      });
      if (!patch.ok) {
        const cuerpoErr = await patch.text().catch(() => "");
        console.error(`[directus ${tipo}/${id}] fallo al enlazar el fichero en contenidos:`, cuerpoErr.slice(0, 300));
        throw new Error(`No se pudo enlazar el arte con el contenido (${patch.status})`);
      }
    }

    const url = `${base()}/assets/${archivoId}`;
    console.log(`[directus ${tipo}/${id}] arte «${campo}» aceptado → ${url}`);
    return { campo, url };
  },
};
