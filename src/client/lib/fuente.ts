import { useEffect, useState } from "preact/hooks";

/**
 * Qué sistema hay al otro lado de este editor: el CRM (`twenty`) o la app editorial
 * (`faro`). El bundle es **el mismo** en las dos Applications —lo elige una variable de
 * entorno del servidor—, así que la única forma de saberlo desde el navegador es
 * preguntárselo.
 *
 * Solo se usa para lo que el operador lee. Nada de comportamiento cuelga de esto: el destino
 * del arte lo decide el servidor, no el cliente.
 */
export type NombreFuente = "twenty" | "faro";

let pendiente: Promise<NombreFuente> | null = null;

function pedir(): Promise<NombreFuente> {
  // Una sola petición por sesión de navegador: el valor no cambia sin un redespliegue.
  pendiente ??= fetch("/api/health")
    .then((r) => r.json())
    .then((j) => (j?.fuente === "faro" ? "faro" : "twenty"))
    // Si `/api/health` falla, "twenty" es la respuesta menos sorprendente: es lo que lleva
    // corriendo desde el principio y lo que vale cuando la variable no está definida.
    .catch(() => "twenty" as NombreFuente);
  return pendiente;
}

export function useFuente(): NombreFuente {
  const [nombre, setNombre] = useState<NombreFuente>("twenty");
  useEffect(() => {
    let vivo = true;
    pedir().then((f) => vivo && setNombre(f));
    return () => {
      vivo = false;
    };
  }, []);
  return nombre;
}
