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
  app.use("/*", serveStatic({ root: "dist" }));
  app.get("*", (c, next) => {
    if (c.req.path.startsWith("/api")) return next();
    return serveStatic({ path: "dist/index.html" })(c, next);
  });
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
