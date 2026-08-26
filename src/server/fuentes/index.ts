import { fuenteFaro } from "./faro.js";
import { fuenteTwenty } from "./twenty.js";
import type { Fuente } from "./tipos.js";

/**
 * Qué sistema hay al otro lado de este editor.
 *
 * Una Application de Dokploy, una fuente. **No** se decide por petición a propósito: un solo
 * proceso con las credenciales de los dos sistemas dentro, y una base de borradores donde el
 * mismo `recordId` puede significar dos cosas, es exactamente lo que este diseño evita.
 *
 * Ausente = `twenty`, que es lo que llevaba corriendo desde el principio: la instancia que ya
 * está en producción no necesita tocar nada para seguir igual.
 */
export const fuente: Fuente = process.env.FUENTE === "faro" ? fuenteFaro : fuenteTwenty;

export * from "./tipos.js";
