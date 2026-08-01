import { basicAuth } from "hono/basic-auth";

/**
 * Protege el editor con Basic Auth server-side (además de lo que se añada a nivel de
 * Traefik en la Fase 4). El navegador cachea las credenciales por origen tras el primer
 * 401, así que cualquier request posterior al mismo origen (fetch, <img>, etc.) las
 * reenvía sola — no hace falta lógica de sesión propia.
 */
export function editorAuth() {
  const username = process.env.EDITOR_USER;
  const password = process.env.EDITOR_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "EDITOR_USER y EDITOR_PASSWORD deben estar definidos (ver .env.example) — la API no puede arrancar sin auth configurada."
    );
  }
  return basicAuth({ username, password, realm: "Open Design" });
}
