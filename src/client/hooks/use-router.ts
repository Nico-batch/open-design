import { useState, useEffect, useCallback } from "preact/hooks";
import { coerceTwentyObjectType, coercePublicationFormat } from "../lib/twenty";

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
  //   ?format=post|story     — qué pieza del registro. También opcional, y por el mismo
  //                            motivo: los enlaces que ya existen editan el post del feed,
  //                            que es lo que vale "post". Cada formato es un borrador
  //                            aparte y escribe en un campo distinto del CRM.
  const params = new URLSearchParams(window.location.search);
  const recordId = params.get("recordId");
  const objectType = coerceTwentyObjectType(params.get("objectType"));
  const publicationFormat = coercePublicationFormat(params.get("format"));

  return { path, navigate, designId, recordId, objectType, publicationFormat };
}
