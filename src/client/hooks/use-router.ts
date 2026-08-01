import { useState, useEffect, useCallback } from "preact/hooks";
import { coerceTwentyObjectType } from "../lib/twenty";

export function useRouter() {
  const [path, setPath] = useState(window.location.pathname);

  const navigate = useCallback((to: string) => {
    window.history.pushState(null, "", to);
    setPath(to);
  }, []);

  useEffect(() => {
    const handler = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  // Parse /design/:id
  const match = path.match(/^\/design\/([^/]+)$/);
  const designId = match ? match[1] : null;

  // Entry point from Twenty (any path, e.g. /edit?recordId=...&objectType=event):
  //   ?recordId=<uuid>       — el registro del CRM que se va a editar
  //   ?objectType=news|event — a qué objeto pertenece. Opcional: los enlaces que ya
  //                            existen en las fichas de News no lo llevan, y para esos el
  //                            valor por defecto ("news") es justamente el correcto.
  const params = new URLSearchParams(window.location.search);
  const recordId = params.get("recordId");
  const objectType = coerceTwentyObjectType(params.get("objectType"));

  return { path, navigate, designId, recordId, objectType };
}
