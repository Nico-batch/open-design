import { useState, useEffect, useCallback } from "preact/hooks";

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

  // ?recordId=<uuid> — entry point from Twenty (any path, e.g. /edit?recordId=...)
  const recordId = new URLSearchParams(window.location.search).get("recordId");

  return { path, navigate, designId, recordId };
}
