import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import app from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, "..", "..", "dist");
const PORT = Number(process.env.PORT) || 8787;

// Serve the built client (present in production; absent while `vite` handles the UI in dev).
if (existsSync(DIST_DIR)) {
  // index.html must never be cached: it's the only file with a stable name, and it's what
  // points at the content-hashed JS/CSS bundles. If the browser serves a stale copy after
  // a redeploy, the user keeps running the *previous* build's code indefinitely — which
  // is exactly what happened when a fix looked "not deployed" because the old error
  // message kept showing. The hashed assets under /assets/ can be cached forever, since
  // a new build produces new filenames.
  app.use("/*", async (c, next) => {
    await next();
    if (c.req.path.startsWith("/api")) return;
    if (c.req.path.startsWith("/assets/")) {
      c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      c.res.headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  });

  app.use("/*", serveStatic({ root: "dist" }));

  // SPA fallback — but NEVER for asset requests.
  //
  // serveStatic calls next() when it can't find a file, so without this guard a missing
  // /assets/index-<hash>.css fell through to here and was answered with index.html at
  // Content-Type: text/html. The browser then refuses to apply it (we send nosniff) and
  // the page renders completely unstyled, with nothing in the log to explain why — the
  // request looks like a perfectly healthy 200. Anything under /assets/, or any path that
  // looks like a file, gets an honest 404 instead, which is diagnosable.
  app.get("*", async (c, next) => {
    const path = c.req.path;
    if (path.startsWith("/api")) return next();
    if (path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) {
      console.warn(`[static] no encontrado: ${path}`);
      return c.text("Not found", 404);
    }
    return serveStatic({ path: "dist/index.html" })(c, next);
  });
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
