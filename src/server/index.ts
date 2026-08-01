import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { query, get, run } from "./db.js";
import { putUpload, getUpload } from "./uploads.js";
import { fetchNews, setNewsEditedImage } from "./twenty.js";
import { editorAuth } from "./auth.js";

const app = new OpenAPIHono();

// ── Logging de peticiones ───────────────────────────────────────────
//
// Sin esto no había NINGUNA traza de las peticiones en los logs del contenedor, así que
// un fallo en producción (p. ej. el "Failed to fetch" al guardar en Twenty) no dejaba
// absolutamente nada que mirar: no se podía distinguir "la petición nunca llegó al
// servidor" (problema de red/proxy) de "llegó y falló aquí dentro". El coste es una
// línea por petición; a este volumen (un operador) es irrelevante.
app.use("*", async (c, next) => {
  const start = Date.now();
  const { method } = c.req;
  const path = c.req.path;
  try {
    await next();
  } catch (e) {
    // Un throw que llega hasta aquí normalmente se traduce en una conexión cortada sin
    // respuesta útil para el navegador — que es exactamente como se ve un "Failed to
    // fetch". Dejar constancia antes de que se pierda.
    console.error(`[${method} ${path}] ERROR no manejado tras ${Date.now() - start}ms:`, e);
    throw e;
  }
  console.log(`[${method} ${path}] ${c.res.status} en ${Date.now() - start}ms`);
});

// ── Seguridad (Fase 3) ──────────────────────────────────────────────
//
// Cabeceras defensivas para toda respuesta (documento SPA en producción incluido).
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self' ws: wss:; font-src 'self' data:; " +
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "same-origin");
});

// Basic Auth en TODA la app (API + la SPA/estáticos que sirve serve.ts en producción),
// EXCEPTO dos rutas públicas obligatorias:
//   - GET /api/uploads/:filename — es la URL que se escribe en "Imagen Editada" de
//     Twenty, tiene que responder sin credenciales (requisito del usuario, CLAUDE.md §9.2).
//   - GET /api/health — lo consulta el HEALTHCHECK de Docker/Dokploy, no un operador.
// Nada más queda abierto — ni el HTML/JS de la SPA, así que no hace falta ningún
// middleware adicional en Traefik para que esto sea seguro: EDITOR_PASSWORD es un
// secreto aleatorio largo (no una contraseña memorizable), funciona como una API key
// entregada vía el prompt nativo de Basic Auth del navegador. El navegador la cachea por
// origen tras el primer 401 y la reenvía sola en requests siguientes (fetch/<img>/etc).
const requireAuth = editorAuth();
app.use("*", async (c, next) => {
  if (c.req.method === "GET" && c.req.path.startsWith("/api/uploads/")) return next();
  if (c.req.method === "GET" && c.req.path === "/api/health") return next();
  return requireAuth(c, next);
});

// ── Health check (Fase 4 — sin auth: lo consulta el orquestador, no un operador) ──

app.get("/api/health", (c) => c.json({ ok: true }, 200));

// ── Schemas ──────────────────────────────────────────────────────────

const DesignSchema = z.object({
  id: z.string(),
  name: z.string(),
  canvas_json: z.string(),
  width: z.number(),
  height: z.number(),
  thumbnail_url: z.string().nullable(),
  twenty_record_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const TemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  canvas_json: z.string(),
  width: z.number(),
  height: z.number(),
  thumbnail_url: z.string().nullable(),
  sort_order: z.number(),
});

const PageSchema = z.object({
  id: z.string(),
  design_id: z.string(),
  title: z.string(),
  canvas_json: z.string(),
  sort_order: z.number(),
  created_at: z.string(),
});

const DesignWithPagesSchema = DesignSchema.extend({
  pages: z.array(PageSchema),
});

const ErrorSchema = z.object({ error: z.string() });

// ── List designs ────────────────────────────────────────────────────

const listDesigns = createRoute({
  method: "get",
  path: "/api/designs",
  responses: { 200: { content: { "application/json": { schema: z.array(DesignSchema) } }, description: "OK" } },
});

app.openapi(listDesigns, async (c) => {
  const rows = await query<z.infer<typeof DesignSchema>>("SELECT * FROM designs ORDER BY updated_at DESC");
  return c.json(rows, 200);
});

// ── Get design ──────────────────────────────────────────────────────

const getDesign = createRoute({
  method: "get",
  path: "/api/designs/{id}",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { content: { "application/json": { schema: DesignWithPagesSchema } }, description: "OK" },
    404: { content: { "application/json": { schema: ErrorSchema } }, description: "Not found" },
  },
});

app.openapi(getDesign, async (c) => {
  const { id } = c.req.valid("param");
  const row = await get<z.infer<typeof DesignSchema>>("SELECT * FROM designs WHERE id = ?", [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  const pages = await query<z.infer<typeof PageSchema>>(
    "SELECT * FROM pages WHERE design_id = ? ORDER BY sort_order",
    [id]
  );
  return c.json({ ...row, pages }, 200);
});

// ── Create design ───────────────────────────────────────────────────

const createDesign = createRoute({
  method: "post",
  path: "/api/designs",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
            canvas_json: z.string().optional(),
            width: z.number().optional(),
            height: z.number().optional(),
          }),
        },
      },
    },
  },
  responses: { 200: { content: { "application/json": { schema: DesignSchema } }, description: "OK" } },
});

app.openapi(createDesign, async (c) => {
  const { name, canvas_json, width, height } = c.req.valid("json");
  const canvasData = canvas_json || "{}";
  await run(
    "INSERT INTO designs (name, canvas_json, width, height) VALUES (?, ?, ?, ?)",
    [name || "Untitled Design", canvasData, width || 1080, height || 1080]
  );
  const row = await get<z.infer<typeof DesignSchema>>("SELECT * FROM designs ORDER BY created_at DESC LIMIT 1");
  // Auto-create first page
  await run(
    "INSERT INTO pages (design_id, title, canvas_json, sort_order) VALUES (?, ?, ?, ?)",
    [row!.id, "Page 1", canvasData, 0]
  );
  return c.json(row!, 200);
});

// ── Update design ───────────────────────────────────────────────────

const updateDesign = createRoute({
  method: "put",
  path: "/api/designs/{id}",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
            canvas_json: z.string().optional(),
            width: z.number().optional(),
            height: z.number().optional(),
            thumbnail_url: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { content: { "application/json": { schema: DesignSchema } }, description: "OK" },
    404: { content: { "application/json": { schema: ErrorSchema } }, description: "Not found" },
  },
});

app.openapi(updateDesign, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const existing = await get<z.infer<typeof DesignSchema>>("SELECT * FROM designs WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "Not found" }, 404);

  await run(
    `UPDATE designs SET name = ?, canvas_json = ?, width = ?, height = ?, thumbnail_url = ?, updated_at = datetime('now') WHERE id = ?`,
    [body.name ?? existing.name, body.canvas_json ?? existing.canvas_json, body.width ?? existing.width, body.height ?? existing.height, body.thumbnail_url ?? existing.thumbnail_url, id]
  );
  const row = await get<z.infer<typeof DesignSchema>>("SELECT * FROM designs WHERE id = ?", [id]);
  return c.json(row!, 200);
});

// ── Delete design ───────────────────────────────────────────────────

const deleteDesign = createRoute({
  method: "delete",
  path: "/api/designs/{id}",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { content: { "application/json": { schema: z.object({ ok: z.boolean() }) } }, description: "OK" },
  },
});

app.openapi(deleteDesign, async (c) => {
  const { id } = c.req.valid("param");
  await run("DELETE FROM designs WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Add page ───────────────────────────────────────────────────────

const addPage = createRoute({
  method: "post",
  path: "/api/designs/{id}/pages",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            title: z.string().optional(),
            canvas_json: z.string().optional(),
            after_sort_order: z.number().optional(),
          }),
        },
      },
    },
  },
  responses: { 200: { content: { "application/json": { schema: PageSchema } }, description: "OK" } },
});

app.openapi(addPage, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const count = await get<{ c: number }>("SELECT COUNT(*) as c FROM pages WHERE design_id = ?", [id]);
  const title = body.title || `Page ${(count?.c ?? 0) + 1}`;

  let insertOrder: number;
  if (body.after_sort_order !== undefined) {
    await run(
      "UPDATE pages SET sort_order = sort_order + 1 WHERE design_id = ? AND sort_order > ?",
      [id, body.after_sort_order]
    );
    insertOrder = body.after_sort_order + 1;
  } else {
    const maxOrder = await get<{ m: number }>("SELECT COALESCE(MAX(sort_order), -1) as m FROM pages WHERE design_id = ?", [id]);
    insertOrder = (maxOrder?.m ?? -1) + 1;
  }

  await run(
    "INSERT INTO pages (design_id, title, canvas_json, sort_order) VALUES (?, ?, ?, ?)",
    [id, title, body.canvas_json || "{}", insertOrder]
  );
  const page = await get<z.infer<typeof PageSchema>>("SELECT * FROM pages WHERE design_id = ? ORDER BY created_at DESC LIMIT 1", [id]);
  return c.json(page!, 200);
});

// ── Duplicate page ─────────────────────────────────────────────────

const duplicatePage = createRoute({
  method: "post",
  path: "/api/pages/{pageId}/duplicate",
  request: { params: z.object({ pageId: z.string() }) },
  responses: {
    200: { content: { "application/json": { schema: PageSchema } }, description: "OK" },
    404: { content: { "application/json": { schema: ErrorSchema } }, description: "Not found" },
  },
});

app.openapi(duplicatePage, async (c) => {
  const { pageId } = c.req.valid("param");
  const original = await get<z.infer<typeof PageSchema>>("SELECT * FROM pages WHERE id = ?", [pageId]);
  if (!original) return c.json({ error: "Not found" }, 404);
  // Shift sort_order of pages after the original
  await run(
    "UPDATE pages SET sort_order = sort_order + 1 WHERE design_id = ? AND sort_order > ?",
    [original.design_id, original.sort_order]
  );
  await run(
    "INSERT INTO pages (design_id, title, canvas_json, sort_order) VALUES (?, ?, ?, ?)",
    [original.design_id, `${original.title} (copy)`, original.canvas_json, original.sort_order + 1]
  );
  const page = await get<z.infer<typeof PageSchema>>("SELECT * FROM pages WHERE design_id = ? AND sort_order = ?", [original.design_id, original.sort_order + 1]);
  return c.json(page!, 200);
});

// ── Update page ────────────────────────────────────────────────────

const updatePage = createRoute({
  method: "put",
  path: "/api/pages/{pageId}",
  request: {
    params: z.object({ pageId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            title: z.string().optional(),
            canvas_json: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { content: { "application/json": { schema: PageSchema } }, description: "OK" },
    404: { content: { "application/json": { schema: ErrorSchema } }, description: "Not found" },
  },
});

app.openapi(updatePage, async (c) => {
  const { pageId } = c.req.valid("param");
  const body = c.req.valid("json");
  const existing = await get<z.infer<typeof PageSchema>>("SELECT * FROM pages WHERE id = ?", [pageId]);
  if (!existing) return c.json({ error: "Not found" }, 404);
  await run(
    "UPDATE pages SET title = ?, canvas_json = ? WHERE id = ?",
    [body.title ?? existing.title, body.canvas_json ?? existing.canvas_json, pageId]
  );
  const page = await get<z.infer<typeof PageSchema>>("SELECT * FROM pages WHERE id = ?", [pageId]);
  return c.json(page!, 200);
});

// ── Delete page ────────────────────────────────────────────────────

const deletePage = createRoute({
  method: "delete",
  path: "/api/pages/{pageId}",
  request: { params: z.object({ pageId: z.string() }) },
  responses: {
    200: { content: { "application/json": { schema: z.object({ ok: z.boolean() }) } }, description: "OK" },
    400: { content: { "application/json": { schema: ErrorSchema } }, description: "Cannot delete last page" },
  },
});

app.openapi(deletePage, async (c) => {
  const { pageId } = c.req.valid("param");
  const page = await get<z.infer<typeof PageSchema>>("SELECT * FROM pages WHERE id = ?", [pageId]);
  if (!page) return c.json({ ok: true }, 200);
  const count = await get<{ c: number }>("SELECT COUNT(*) as c FROM pages WHERE design_id = ?", [page.design_id]);
  if ((count?.c ?? 0) <= 1) return c.json({ error: "Cannot delete the last page" }, 400);
  await run("DELETE FROM pages WHERE id = ?", [pageId]);
  return c.json({ ok: true }, 200);
});

// ── List templates ──────────────────────────────────────────────────

const listTemplates = createRoute({
  method: "get",
  path: "/api/templates",
  responses: { 200: { content: { "application/json": { schema: z.array(TemplateSchema) } }, description: "OK" } },
});

app.openapi(listTemplates, async (c) => {
  const rows = await query<z.infer<typeof TemplateSchema>>("SELECT * FROM templates ORDER BY sort_order");
  return c.json(rows, 200);
});

// ── Get template ────────────────────────────────────────────────────

const getTemplate = createRoute({
  method: "get",
  path: "/api/templates/{id}",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { content: { "application/json": { schema: TemplateSchema } }, description: "OK" },
    404: { content: { "application/json": { schema: ErrorSchema } }, description: "Not found" },
  },
});

app.openapi(getTemplate, async (c) => {
  const { id } = c.req.valid("param");
  const row = await get<z.infer<typeof TemplateSchema>>("SELECT * FROM templates WHERE id = ?", [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row, 200);
});

// ── File uploads ────────────────────────────────────────────────────
//
// SVG queda fuera de la whitelist: es el vector de XSS más probable en un editor de
// imágenes (un <script>/onload dentro del SVG se ejecutaría con el origen del editor
// si se sirviera inline). No hace falta como formato de subida — todo lo que entra al
// canvas se rasteriza al exportar. Límite de tamaño para no permitir subidas gigantes.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB

app.post("/api/uploads", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || typeof file === "string") {
    return c.json({ error: "No file provided" }, 400);
  }

  const ext = file.name?.split(".").pop()?.toLowerCase() || "png";
  const allowed = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
  if (!allowed.has(ext)) {
    return c.json({ error: "Unsupported file type" }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: "File too large" }, 413);
  }

  const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const data = await file.arrayBuffer();
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/png";
  const url = await putUpload(filename, data, mime);

  return c.json({ url }, 200);
});

app.get("/api/uploads/:filename", async (c) => {
  const { filename } = c.req.param();
  const result = await getUpload(filename);
  if (!result) return c.json({ error: "Not found" }, 404);

  return new Response(result.data, {
    headers: {
      "Content-Type": result.contentType,
      "Content-Disposition": `inline; filename="${filename.replace(/["\\]/g, "")}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=31536000",
    },
  });
});

// ── Twenty integration ──────────────────────────────────────────────
//
// GET /api/news/:id            — datos por defecto (título + URL de imagen propia,
//                                 esta última siempre vía nuestro proxy: nunca se manda
//                                 al cliente la URL firmada de Twenty).
// GET /api/news/:id/image      — proxy de los bytes de la imagen de origen (evita
//                                 tainted canvas y no expone el token firmado de Twenty).
// POST /api/news/:id/publish-image — recibe el PNG exportado, lo guarda como upload
//                                 público y escribe esa URL en el campo "Imagen
//                                 Editada" (Links) de la noticia. No publica en redes;
//                                 eso lo hace otro flujo fuera de este editor.

app.get("/api/news/:id", async (c) => {
  const { id } = c.req.param();
  try {
    const news = await fetchNews(id);
    if (!news) return c.json({ error: "Not found" }, 404);
    return c.json(
      {
        id: news.id,
        title: news.title,
        imageUrl: news.imageUrl ? `/api/news/${id}/image` : null,
      },
      200
    );
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Twenty fetch failed" }, 502);
  }
});

app.get("/api/news/:id/image", async (c) => {
  const { id } = c.req.param();
  try {
    const news = await fetchNews(id);
    if (!news?.imageUrl) return c.json({ error: "Not found" }, 404);
    const upstream = await fetch(news.imageUrl);
    if (!upstream.ok || !upstream.body) return c.json({ error: "Upstream fetch failed" }, 502);
    return new Response(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "image/jpeg",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Twenty fetch failed" }, 502);
  }
});

app.post("/api/designs/from-news/:newsId", async (c) => {
  const { newsId } = c.req.param();
  const existing = await get<z.infer<typeof DesignSchema>>(
    "SELECT * FROM designs WHERE twenty_record_id = ?",
    [newsId]
  );
  if (existing) {
    const pages = await query<z.infer<typeof PageSchema>>(
      "SELECT * FROM pages WHERE design_id = ? ORDER BY sort_order",
      [existing.id]
    );
    return c.json({ ...existing, pages }, 200);
  }

  let name = "Untitled Design";
  try {
    const news = await fetchNews(newsId);
    if (news?.title) name = news.title.slice(0, 120);
  } catch {
    // best effort — fall back to the default name
  }

  await run(
    "INSERT INTO designs (name, canvas_json, width, height, twenty_record_id) VALUES (?, ?, ?, ?, ?)",
    [name, "{}", 1080, 1080, newsId]
  );
  const row = await get<z.infer<typeof DesignSchema>>(
    "SELECT * FROM designs WHERE twenty_record_id = ?",
    [newsId]
  );
  await run(
    "INSERT INTO pages (design_id, title, canvas_json, sort_order) VALUES (?, ?, ?, ?)",
    [row!.id, "Page 1", "{}", 0]
  );
  const pages = await query<z.infer<typeof PageSchema>>(
    "SELECT * FROM pages WHERE design_id = ? ORDER BY sort_order",
    [row!.id]
  );
  return c.json({ ...row!, pages }, 200);
});

// Logging paso a paso a propósito: este endpoint hace tres cosas que pueden fallar de
// formas muy distintas (parsear un multipart grande, escribir en el volumen, hablar con
// Twenty) y en producción no había manera de saber en cuál de las tres moría.
app.post("/api/news/:id/publish-image", async (c) => {
  const { id } = c.req.param();
  console.log(`[publish-image ${id}] inicio`);

  let file: File;
  try {
    const body = await c.req.parseBody();
    const parsed = body["file"];
    if (!parsed || typeof parsed === "string") {
      console.warn(`[publish-image ${id}] sin fichero en el multipart`);
      return c.json({ error: "No file provided" }, 400);
    }
    file = parsed;
  } catch (e) {
    console.error(`[publish-image ${id}] fallo al parsear el multipart:`, e);
    return c.json({ error: "No se pudo leer la imagen enviada" }, 400);
  }
  console.log(`[publish-image ${id}] fichero recibido: ${file.size} bytes, tipo ${file.type || "(sin tipo)"}`);

  if (file.size > MAX_UPLOAD_BYTES) {
    console.warn(`[publish-image ${id}] fichero demasiado grande: ${file.size} > ${MAX_UPLOAD_BYTES}`);
    return c.json({ error: "File too large" }, 413);
  }

  const publicBaseUrl = process.env.PUBLIC_BASE_URL;
  if (!publicBaseUrl) {
    console.error(`[publish-image ${id}] PUBLIC_BASE_URL no está definida en el entorno`);
    return c.json({ error: "PUBLIC_BASE_URL no configurado en el servidor" }, 500);
  }

  // El cliente exporta JPEG (no PNG) para este flujo — ver exportUploadBlob en
  // use-canvas.ts — pero se detecta por el mime real del blob en vez de asumirlo, por si
  // algún día cambia.
  const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
  const ext = mime === "image/png" ? "png" : "jpg";
  const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

  let publicUrl: string;
  try {
    const data = await file.arrayBuffer();
    const relativeUrl = await putUpload(filename, data, mime);
    publicUrl = `${publicBaseUrl.replace(/\/$/, "")}${relativeUrl}`;
    console.log(`[publish-image ${id}] guardado en disco: ${filename} → ${publicUrl}`);
  } catch (e) {
    // Típicamente permisos del volumen (/data no escribible por el usuario no-root) o
    // disco lleno.
    console.error(`[publish-image ${id}] fallo al escribir el fichero:`, e);
    return c.json({ error: "No se pudo guardar la imagen en el servidor" }, 500);
  }

  try {
    await setNewsEditedImage(id, publicUrl, "Imagen editada (Open Design)");
  } catch (e) {
    console.error(`[publish-image ${id}] fallo al actualizar Twenty:`, e);
    return c.json({ error: e instanceof Error ? e.message : "Twenty update failed" }, 502);
  }

  console.log(`[publish-image ${id}] OK`);
  return c.json({ url: publicUrl }, 200);
});

export default app;
