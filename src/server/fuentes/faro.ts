import type {
  Fuente,
  ImageTarget,
  RegistroEditable,
  TwentyObjectType,
} from "./tipos.js";

// ── La app editorial (`faro-redaccion`) ─────────────────────────────
//
// La otra fuente. Habla HTTP en vez de GraphQL, y su vocabulario es el del dominio en
// español, así que **todo el trabajo de este fichero es la traducción**: `news` ↔ `noticia`,
// `inicio` ↔ `fechaDeInicio`. Fuera de aquí, el editor no sabe que existe.
//
// El contrato entero está en `../DOCUMENTACION.md` §5.4.

const FARO_API_URL = process.env.FARO_API_URL;
const FARO_API_KEY = process.env.FARO_API_KEY;

/** Cómo se llama cada objeto del editor en la app. */
const TIPOS: Record<TwentyObjectType, string> = {
  news: "noticia",
  event: "evento",
};

function base(): string {
  if (!FARO_API_URL || !FARO_API_KEY) {
    throw new Error("FARO_API_URL/FARO_API_KEY no configurados en el servidor");
  }
  return FARO_API_URL.replace(/\/$/, "");
}

/**
 * Los mismos errores explicables que la fuente de Twenty, y por el mismo motivo: sin
 * timeout, una app lenta deja la petición del navegador colgada hasta que la corta algún
 * proxy intermedio, y desde el cliente eso se ve exactamente igual que un fallo de red, sin
 * ninguna pista de la causa.
 */
async function pedir(ruta: string, init: RequestInit = {}, ms = 15000): Promise<Response> {
  try {
    return await fetch(`${base()}${ruta}`, {
      ...init,
      headers: { ...(init.headers ?? {}), "X-Faro-Key": FARO_API_KEY! },
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new Error(`Faro Redacción no respondió a tiempo (timeout de ${ms / 1000}s)`);
    }
    throw new Error(
      `No se pudo conectar con Faro Redacción: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

interface PiezaFaro {
  id: string;
  tipo: string;
  titulo: string | null;
  imagenUrl: string | null;
  campos: Record<string, any> | null;
}

async function leerPieza(tipo: TwentyObjectType, id: string): Promise<PiezaFaro | null> {
  const res = await pedir(`/api/editor/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const cuerpo = await res.text().catch(() => "");
    throw new Error(`Faro Redacción respondió ${res.status}: ${cuerpo.slice(0, 200)}`);
  }
  const pieza = (await res.json()) as PiezaFaro;

  // Si el enlace pide una noticia y el id es de un evento, componer la plantilla de noticia
  // sobre él sería peor que no abrir nada. La app no lo comprueba —no tiene por qué: la
  // expectativa sobre el tipo la trae el editor, en el `objectType` de la URL.
  if (pieza.tipo !== TIPOS[tipo]) return null;
  return pieza;
}

/**
 * La URL del arte que sirve la app viene absoluta y firmada, con el dominio público
 * (`APP_URL`). La firma cubre la ruta del fichero y su caducidad, **no el host**, así que se
 * puede reapuntar a `FARO_API_URL` sin invalidarla: es lo que permite que, si algún día
 * `FARO_API_URL` es el nombre interno del servicio en la red de Docker, la imagen no salga a
 * internet para volver a entrar.
 */
function rutaDelArte(absoluta: string): string {
  try {
    const u = new URL(absoluta);
    return `${u.pathname}${u.search}`;
  } catch {
    return absoluta;
  }
}

export const fuenteFaro: Fuente = {
  nombre: "faro",

  async leerRegistro(tipo, id): Promise<RegistroEditable | null> {
    const pieza = await leerPieza(tipo, id);
    if (!pieza) return null;

    const c = pieza.campos ?? {};
    const fields =
      tipo === "event"
        ? {
            subtitulo: c.subtitulo ?? null,
            // La app manda instantes en UTC, que es justo lo que esperan las plantillas:
            // las descomponen en hora de Madrid por su cuenta, igual que las de Twenty.
            fechaDeInicio: c.inicio ?? null,
            fechaDeFin: c.fin ?? null,
            todoElDia: c.todoElDia === true,
            municipio: c.municipio ?? null,
            direccion: c.direccion ?? null,
            precio: c.precio ?? null,
            // Llega el nombre legible («Conciertos y música»), no una clave de enum: el
            // catálogo de la web no coincide con el que tenía Twenty. Las plantillas lo
            // pintan tal cual gracias al fallback de `CATEGORY_LABELS`/`SECTION_LABELS`.
            categoria: c.categoria ?? null,
            destacado: c.destacado === true,
            patrocinado: c.patrocinado === true,
          }
        : { categoria: c.categoria ?? null };

    return {
      id: pieza.id,
      title: pieza.titulo?.trim() || null,
      imageUrl: pieza.imagenUrl ? `${base()}${rutaDelArte(pieza.imagenUrl)}` : null,
      fields,
    };
  },

  async leerImagenOrigen(tipo, id) {
    const pieza = await leerPieza(tipo, id);
    if (!pieza?.imagenUrl) return null;
    // La URL ya va firmada; la cabecera se manda igualmente porque `/api/arte` la acepta y
    // así una firma recién caducada no rompe la apertura del editor.
    return pedir(rutaDelArte(pieza.imagenUrl), {}, 30000);
  },

  /**
   * El arte no se queda aquí: viajan los bytes.
   *
   * Es la diferencia de fondo con la fuente de Twenty, y es deliberada. El arte vive en un
   * único sitio —el volumen de la app—, que es quien lo sirve firmado a Meta; esta instancia
   * del editor no necesita `PUBLIC_BASE_URL` ni tener ningún origen público abierto.
   */
  async guardarArte(tipo, id, bytes, mime, target: ImageTarget) {
    const formato = target === "story" ? "story" : "feed";
    const ext = mime === "image/png" ? "png" : "jpg";

    const cuerpo = new FormData();
    cuerpo.append("fichero", new File([bytes], `arte-${formato}.${ext}`, { type: mime }));
    cuerpo.append("formato", formato);

    const res = await pedir(
      `/api/editor/${encodeURIComponent(id)}/arte`,
      { method: "POST", body: cuerpo },
      60000
    );
    if (!res.ok) {
      const cuerpoErr = await res.text().catch(() => "");
      // El cuerpo del error viaja entero hasta el operador: la app distingue «formato que no
      // se maqueta aquí» de «más de 8 MB» de «el contenido no existe», y perder eso deja un
      // 502 genérico donde había una explicación.
      console.error(`[faro ${tipo}/${id}] la app rechazó el arte: ${res.status} ${cuerpoErr.slice(0, 300)}`);
      throw new Error(`Faro Redacción rechazó el arte (${res.status}): ${cuerpoErr.slice(0, 200)}`);
    }
    const { url } = (await res.json()) as { url: string };
    console.log(`[faro ${tipo}/${id}] arte «${formato}» aceptado → ${url}`);
    return { campo: formato, url };
  },
};
