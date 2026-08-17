import { useState, useCallback, useRef, useEffect } from "preact/hooks";
import type { Design, DesignWithPages, Template, Page } from "../types";
import { api } from "../api";
import { coerceTwentyObjectType, type TwentyObjectType } from "../lib/twenty";

export function useDesigns(
  getCanvasJSONForPage: (pageId: string) => string,
  /** Tamaño actual del lienzo. Se guarda con el diseño porque cambiarlo desde el
   *  desplegable del toolbar no se persistía: al recargar, la página volvía al tamaño
   *  original y la plantilla —maquetada para el nuevo— quedaba descolocada. */
  getCanvasSize: () => { width: number; height: number }
) {
  const [designs, setDesigns] = useState<Design[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [activeDesign, setActiveDesign] = useState<Design | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const activeIdRef = useRef<string | null>(null);
  const activePageIdRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep activePageIdRef in sync
  useEffect(() => {
    activePageIdRef.current = activePageId;
  }, [activePageId]);

  // Load designs + templates on mount
  useEffect(() => {
    (async () => {
      try {
        const [d, t] = await Promise.all([
          api<Design[]>("GET", "/api/designs"),
          api<Template[]>("GET", "/api/templates"),
        ]);
        setDesigns(d);
        setTemplates(t);
      } catch (e) {
        console.error("Failed to load data:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const saveDesign = useCallback(async () => {
    if (!activeIdRef.current) return;
    setSaving(true);
    try {
      // Save all pages' canvas JSON
      const currentPages = pages;
      for (const page of currentPages) {
        const json = getCanvasJSONForPage(page.id);
        if (json && json !== "{}") {
          const updatedPage = await api<Page>("PUT", `/api/pages/${page.id}`, {
            canvas_json: json,
          });
          setPages((prev) => prev.map((p) => (p.id === updatedPage.id ? updatedPage : p)));
        }
      }
      // Also update design's canvas_json with first page for backwards compat
      const firstPageJson = currentPages.length > 0 ? getCanvasJSONForPage(currentPages[0].id) : "{}";
      const size = getCanvasSize();
      const updated = await api<Design>("PUT", `/api/designs/${activeIdRef.current}`, {
        canvas_json: firstPageJson,
        width: size.width,
        height: size.height,
      });
      setDesigns((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
      setActiveDesign(updated);
    } catch (e) {
      console.error("Failed to save:", e);
    } finally {
      setSaving(false);
    }
  }, [getCanvasJSONForPage, getCanvasSize, pages]);

  // Uploads the exported image and writes its public URL into the linked Twenty record's
  // "Imagen Editada" field — the record can be a News or an Events one, so the object
  // type saved on the design decides which object gets updated. Does not save the design
  // or publish to social media — those are separate, unrelated steps.
  const publishToTwenty = useCallback(
    async (pngBlob: Blob): Promise<{ url?: string; field?: string }> => {
      const recordId = activeDesign?.twenty_record_id;
      if (!recordId) throw new Error("Este diseño no está vinculado a ningún registro de Twenty");
      const objectType = coerceTwentyObjectType(activeDesign?.twenty_object_type);
      // El formato decide a qué campo del registro va la URL: el vertical 9:16 es una
      // historia y tiene el suyo propio ("Imagen Story"). El umbral separa con holgura los
      // tres presets: 1080×1920 da 1.78 y el siguiente más alto, 1080×1350, se queda en
      // 1.25.
      const { width, height } = getCanvasSize();
      const target = height >= width * 1.7 ? "story" : "feed";
      const form = new FormData();
      form.append("file", pngBlob, "design.png");
      form.append("target", target);
      let resp: Response;
      try {
        resp = await fetch(`/api/twenty/${objectType}/${recordId}/publish-image`, {
          method: "POST",
          body: form,
        });
      } catch {
        // fetch() itself rejected — a real network failure (server down/unreachable,
        // connection dropped mid-upload), not an HTTP error status. Surface something
        // actionable instead of letting the bare "Failed to fetch" TypeError bubble up.
        throw new Error("No se pudo conectar con el servidor. Comprueba tu conexión y que el editor siga accesible, y vuelve a intentarlo.");
      }
      // Some failure responses (e.g. 401 from Basic Auth) aren't JSON — don't let a
      // parse error on those mask the real status.
      let data: { error?: string; url?: string; field?: string } = {};
      try {
        data = await resp.json();
      } catch {
        // leave data empty; fall through to the status-based message below
      }
      if (!resp.ok) {
        if (resp.status === 401) throw new Error("Sesión expirada o credenciales inválidas — recarga la página e inicia sesión de nuevo.");
        throw new Error(data.error || `No se pudo publicar en Twenty (error ${resp.status})`);
      }
      return { url: data.url, field: data.field };
    },
    [activeDesign, getCanvasSize]
  );

  // Creating a design only returns the design row (no pages, even though the server
  // auto-creates "Page 1"). Fetch the full record so `pages`/`activePageId` are populated
  // before the editor mounts — otherwise the new design opens with no visible canvas.
  const activateCreatedDesign = useCallback(async (id: string) => {
    activeIdRef.current = id;
    const full = await api<DesignWithPages>("GET", `/api/designs/${id}`);
    setActiveDesign(full);
    setPages(full.pages);
    setActivePageId(full.pages[0]?.id ?? null);
  }, []);

  const createDesign = useCallback(async (): Promise<string | undefined> => {
    try {
      const d = await api<Design>("POST", "/api/designs", {
        name: "Untitled Design",
        canvas_json: "{}",
      });
      setDesigns((prev) => [d, ...prev]);
      await activateCreatedDesign(d.id);
      return d.id;
    } catch (e) {
      console.error("Failed to create design:", e);
    }
  }, [activateCreatedDesign]);

  // Entry point from Twenty (?recordId=...&objectType=...). Finds the design already
  // linked to that record, or creates one — the same record always resumes the same
  // draft. The pair (objeto, registro) is the key: News and Events are separate objects.
  const openFromTwentyRecord = useCallback(
    async (recordId: string, objectType: TwentyObjectType): Promise<string | undefined> => {
      try {
        const full = await api<DesignWithPages>(
          "POST",
          `/api/designs/from-twenty/${objectType}/${recordId}`
        );
        setDesigns((prev) => (prev.some((d) => d.id === full.id) ? prev : [full, ...prev]));
        activeIdRef.current = full.id;
        setActiveDesign(full);
        setPages(full.pages);
        setActivePageId(full.pages[0]?.id ?? null);
        return full.id;
      } catch (e) {
        console.error("Failed to open design from Twenty record:", e);
      }
    },
    []
  );

  const createFromTemplate = useCallback(async (template: Template): Promise<string | undefined> => {
    try {
      const d = await api<Design>("POST", "/api/designs", {
        name: template.name,
        canvas_json: template.canvas_json,
        width: template.width,
        height: template.height,
      });
      setDesigns((prev) => [d, ...prev]);
      await activateCreatedDesign(d.id);
      return d.id;
    } catch (e) {
      console.error("Failed to create from template:", e);
    }
  }, [activateCreatedDesign]);

  const loadDesign = useCallback(
    async (id: string) => {
      try {
        const d = await api<DesignWithPages>("GET", `/api/designs/${id}`);
        setActiveDesign(d);
        activeIdRef.current = d.id;
        setPages(d.pages);
        if (d.pages.length > 0) {
          setActivePageId(d.pages[0].id);
        } else {
          setActivePageId(null);
        }
      } catch (e) {
        console.error("Failed to load design:", e);
      }
    },
    []
  );

  const deleteDesign = useCallback(async (id: string) => {
    try {
      await api<{ ok: boolean }>("DELETE", `/api/designs/${id}`);
      setDesigns((prev) => prev.filter((d) => d.id !== id));
      if (activeIdRef.current === id) {
        setActiveDesign(null);
        activeIdRef.current = null;
      }
    } catch (e) {
      console.error("Failed to delete:", e);
    }
  }, []);

  const renameDesign = useCallback(async (id: string, name: string) => {
    try {
      const updated = await api<Design>("PUT", `/api/designs/${id}`, { name });
      setDesigns((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
      if (activeIdRef.current === id) setActiveDesign(updated);
    } catch (e) {
      console.error("Failed to rename:", e);
    }
  }, []);

  // ── Page management ─────────────────────────────────────────────────

  const addPage = useCallback(async (afterPageId?: string) => {
    if (!activeIdRef.current) return;
    try {
      const body: Record<string, unknown> = {};
      if (afterPageId) {
        const afterPage = pages.find((p) => p.id === afterPageId);
        if (afterPage) body.after_sort_order = afterPage.sort_order;
      }
      const page = await api<Page>("POST", `/api/designs/${activeIdRef.current}/pages`, body);
      // Re-fetch all pages to get correct sort_order after shifts
      const d = await api<DesignWithPages>("GET", `/api/designs/${activeIdRef.current}`);
      setPages(d.pages);
      setActivePageId(page.id);
    } catch (e) {
      console.error("Failed to add page:", e);
    }
  }, [pages]);

  const duplicatePage = useCallback(
    async (pageId: string) => {
      // Save current canvas state for the page being duplicated
      const json = getCanvasJSONForPage(pageId);
      if (json && json !== "{}") {
        try {
          await api<Page>("PUT", `/api/pages/${pageId}`, { canvas_json: json });
        } catch {
          // best effort
        }
      }
      try {
        const page = await api<Page>("POST", `/api/pages/${pageId}/duplicate`, {});
        // Re-fetch all pages to get correct sort_order
        if (activeIdRef.current) {
          const d = await api<DesignWithPages>("GET", `/api/designs/${activeIdRef.current}`);
          setPages(d.pages);
        }
        setActivePageId(page.id);
      } catch (e) {
        console.error("Failed to duplicate page:", e);
      }
    },
    [getCanvasJSONForPage]
  );

  const deletePage = useCallback(
    async (pageId: string) => {
      try {
        await api<{ ok: boolean }>("DELETE", `/api/pages/${pageId}`);
        const remaining = pages.filter((p) => p.id !== pageId);
        setPages(remaining);
        if (activePageIdRef.current === pageId && remaining.length > 0) {
          setActivePageId(remaining[0].id);
        }
      } catch (e) {
        console.error("Failed to delete page:", e);
      }
    },
    [pages]
  );

  const renamePage = useCallback(async (pageId: string, title: string) => {
    try {
      const updated = await api<Page>("PUT", `/api/pages/${pageId}`, { title });
      setPages((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } catch (e) {
      console.error("Failed to rename page:", e);
    }
  }, []);

  // switchToPage is now just scrolling + activating — handled by CanvasArea/PagesBar
  const switchToPage = useCallback((pageId: string) => {
    setActivePageId(pageId);
  }, []);

  const activePage = pages.find((p) => p.id === activePageId) ?? null;

  // Auto-save debounced
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => saveDesign(), 2000);
  }, [saveDesign]);

  return {
    designs,
    templates,
    activeDesign,
    setActiveDesign,
    activeIdRef,
    loading,
    saving,
    createDesign,
    createFromTemplate,
    openFromTwentyRecord,
    loadDesign,
    saveDesign,
    publishToTwenty,
    deleteDesign,
    renameDesign,
    scheduleSave,
    // Pages
    pages,
    activePageId,
    activePage,
    addPage,
    duplicatePage,
    deletePage,
    renamePage,
    switchToPage,
  };
}
