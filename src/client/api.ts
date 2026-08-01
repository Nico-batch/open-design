export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = { method, headers: {} };
  if (body) {
    (opts.headers as Record<string, string>)["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let r: Response;
  try {
    r = await fetch(path, opts);
  } catch {
    // fetch() itself rejected (server unreachable / connection dropped), not an HTTP
    // error status — surface something actionable instead of a bare "Failed to fetch".
    throw new Error("No se pudo conectar con el servidor. Comprueba tu conexión y vuelve a intentarlo.");
  }
  // Not every error response is JSON (e.g. Basic Auth's 401 body is plain text
  // "Unauthorized") — don't let a parse failure on those mask the real status.
  let data: any = {};
  try {
    data = await r.json();
  } catch {
    // leave data empty; fall through to the status-based message below
  }
  if (!r.ok) {
    if (r.status === 401) throw new Error("Sesión expirada o credenciales inválidas — recarga la página e inicia sesión de nuevo.");
    throw new Error(data.error || `Request failed (${r.status})`);
  }
  return data as T;
}
