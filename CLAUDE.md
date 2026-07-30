# CLAUDE.md — open-design fork (editor de posts de Instagram para Twenty CRM)

> Contexto completo del proyecto en [`PLAN.md`](PLAN.md). Este archivo es el mapa técnico
> del código, con los puntos exactos que tocaremos en las fases siguientes y los hallazgos
> de seguridad/arquitectura encontrados hasta ahora.

## 0. Origen

Fork de [`clawnify/open-design`](https://github.com/clawnify/open-design) en
`https://github.com/Nico-batch/open-design`, clonado en esta carpeta. `PLAN.md` estaba
ya presente antes del clone y se conservó.

## 1. Arquitectura actual del servidor (tras Fase 1.0)

**Fase 0 encontró que el repo, tal como venía del template, no podía correr fuera de la
plataforma de Clawnify** (ver §1.1 para el detalle histórico de esos hallazgos). Fase 1.0
reemplazó esa capa por completo. Estado actual:

- **`src/server/db.ts`** — usa **`node:sqlite`** (el módulo SQLite nativo incluido en
  Node.js, sin dependencias externas ni compilación nativa) contra un fichero `data.db` en
  la raíz del repo. Al arrancar ejecuta [`schema.sql`](src/server/schema.sql) completo (es
  idempotente: `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE`), así que crea/actualiza el
  esquema solo. Expone `query/get/run(sql, params)` — misma firma que antes, así que
  [`src/server/index.ts`](src/server/index.ts) no necesitó cambios en sus queries.
- **`src/server/index.ts`** — usa `OpenAPIHono` de `@hono/zod-openapi` **directamente**
  (antes: `createApp` de `@clawnify/app`, que era solo un envoltorio fino sobre esto mismo
  más un middleware `initDB(c.env)` atado a bindings de Cloudflare). Las rutas no cambiaron.
- **`src/server/serve.ts`** (nuevo) — entrypoint Node real con `@hono/node-server`. Sirve la
  app Hono en `process.env.PORT || 8787`. Si existe `dist/` (build de producción) también
  sirve los estáticos del cliente con fallback a `index.html` para rutas no-`/api` (SPA).
  En dev, `dist/` no existe y Vite sirve el front por separado — tal como antes.
- **`src/server/uploads.ts`** no se tocó — ya era Node puro (`fs`) y ahora corre bajo un
  runtime Node real, así que funciona sin el error de `import.meta.url` que daba bajo
  `workerd` (ver §1.1).
- **`wrangler.toml` se eliminó** — ya no hay ninguna dependencia de Cloudflare Workers/D1 en
  el proyecto (`wrangler`, `@clawnify/app`, `@clawnify/db`, `@clawnify/routes` fuera de
  `package.json`).

### ¿Por qué `node:sqlite` y no `better-sqlite3`?

`PLAN.md` y la primera pasada de Fase 0 asumían `better-sqlite3`. Al intentarlo en esta
máquina (Windows, Node 24, sin Visual Studio Build Tools) **falló la compilación nativa**
(`gyp ERR! find VS` — no hay binario prebuilt para esta combinación de Node/plataforma y
no hay toolchain de C++ instalada). `node:sqlite` es un módulo **incluido en Node.js**
(disponible sin flag desde esta versión: `node --help | grep sqlite` → `--no-experimental-sqlite`,
es decir, viene *activado* por defecto), con la misma forma de API
(`db.prepare(sql).all/get/run(...params)`) — cero dependencias nativas, cero toolchain que
instalar, y encaja mejor con "VPS ligero, sin dependencias que puedan romperse en el build".

**Contrapartida a anotar para la Fase 4 (Dockerfile):** `node:sqlite` requiere **Node ≥ 22.5**
(idealmente Node 24 LTS, la misma que esta máquina de desarrollo), no el "Node 20+" que
`PLAN.md` §4 mencionaba de pasada. Hay que fijar la imagen base del Dockerfile a `node:24-slim`
(o superior) en vez de una imagen Node 20.

### 1.1 Historial: por qué se cambió (hallazgos originales de Fase 0)

Esta subsección documenta el problema tal como se encontró, por si hace falta reconstruir
el razonamiento. **Ya está resuelto** — no requiere acción.

`src/server/db.ts` era un re-export de `@clawnify/db` (paquete npm privado de Clawnify).
Ese paquete solo sabía hablar con `env.DB` (binding D1 de Cloudflare Workers) o
`env.STORAGE` (binding propietario "Clawnify Storage capability", la plataforma
`app.clawnify.com`) — ninguna ruta a SQLite plano. `@clawnify/app` (usado vía `createApp`)
inyectaba un middleware que llamaba `initDB(c.env)` en cada request; `c.env` solo existe
bajo el runtime de Cloudflare Workers/Miniflare, no en Node plano. `wrangler.toml` confirmaba
el target D1, y `clawnify.json` confirmaba que el repo estaba pensado para desplegarse en la
plataforma de Clawnify, que provisiona D1/storage automáticamente.

Además, **`pnpm run dev` (el del template original, sin tocar nada) fallaba al arrancar la
API**, incluso en local:

```
[ui] VITE v6.4.1 ready in 879ms — http://localhost:5173/   (esto sí arrancaba)
[api] ⎔ Starting local server...
[api] X [ERROR] service core:user:open-design: Uncaught TypeError:
      The "path" argument must be of type string or an instance of URL. Received undefined
      at fileURLToPath (node-internal:internal_url:155:15)
[api] X [ERROR] The Workers runtime failed to start.
[api] wrangler dev --port 8787 exited with code 1
```

Causa: `src/server/uploads.ts` calculaba `__dirname` con
`dirname(fileURLToPath(import.meta.url))` a nivel de módulo. Bajo `workerd` (el runtime de
`wrangler dev`), `import.meta.url` no se resuelve como en Node y `fileURLToPath` recibía
`undefined`. El propio template mezclaba un módulo de almacenamiento Node/`fs` con un
runtime (`workerd`/D1) donde ese `fs` no tiene sentido — solo funcionaba de verdad en la
plataforma de Clawnify.

Ambos problemas (capa de datos y `uploads.ts`) se resolvían con el mismo movimiento: dejar
de usar `wrangler dev`/`workerd` y correr Node plano. Eso es lo que hace §1 ahora.

### 1.2 Gotcha de Windows: `concurrently` + `tsx watch` pierde el output del hijo

Al montar el script `dev` inicialmente con `tsx watch src/server/serve.ts` (para reiniciar
el servidor al guardar), el proceso `[api]` nunca imprimía nada bajo `concurrently` en este
entorno (Windows + Git Bash) — ni error, ni el mensaje de arranque; el puerto `:8787` no
llegaba a abrirse. Aislado con pruebas: `tsx watch ...` funciona perfecto invocado solo
(`npx tsx watch ...` o el `.CMD` de `node_modules/.bin` directamente), y `concurrently` con
`tsx` **sin** `watch` también funciona bien — el problema es específico de la combinación
`concurrently` + `tsx watch` en Windows (probablemente por cómo `tsx watch` reexpone stdio
de su proceso hijo). **Solución aplicada:** el script `dev` usa `tsx` sin `watch`. Se pierde
el auto-restart del servidor al editar `src/server/*`; para desarrollo activo del backend,
reiniciar `pnpm run dev` a mano tras cada cambio (o correr `tsx watch src/server/serve.ts`
en una terminal aparte, fuera de `concurrently`, si hace falta el auto-restart).

## 2. Cómo arrancar en local

```bash
pnpm install
pnpm run dev
```

- Arranca `vite` (front, `:5173`) y `tsx src/server/serve.ts` (API, `:8787`) en paralelo vía
  `concurrently`. Vite proxea `/api/*` a `:8787` ([`vite.config.ts`](vite.config.ts)).
- **Verificado end-to-end** (Fase 1.0): `GET/POST /api/designs`, `GET /api/templates`
  responden con datos reales desde `data.db`; el front en `:5173` carga y su proxy `/api`
  llega al servidor Node correctamente.
- `data.db` se crea solo en la raíz del repo al primer arranque (ya está en `.gitignore`
  junto a `data.db-wal`/`data.db-shm`, los ficheros de modo WAL de SQLite).
- Para producción (o para probar el build): `pnpm run build` (genera `dist/`) y luego
  `pnpm run start` (`tsx src/server/serve.ts`, que al detectar `dist/` sirve el cliente
  compilado además de la API).
- `pnpm install` puede requerir aprobar builds nativos la primera vez — ver
  `pnpm-workspace.yaml` → `allowBuilds` (`esbuild: true` para vite/tsx; `canvas`/`sharp` en
  `false`, son opcionales de `fabric`/`jsdom` que no usamos).

## 3. Estructura del código

```
src/
├── server/
│   ├── index.ts     — todas las rutas Hono/OpenAPI (designs, pages, templates, uploads)
│   ├── db.ts         — node:sqlite contra schema.sql (ver §1)
│   ├── serve.ts      — entrypoint Node (@hono/node-server), dev y producción
│   ├── uploads.ts    — uploads a filesystem local (Node puro, fs)
│   └── schema.sql    — DDL + seed de templates (SQL estándar, portable)
└── client/
    ├── main.tsx, app.tsx       — bootstrap Preact; main.tsx importa fonts.css
    ├── fonts.css               — @font-face autoalojado (generado, 36 caras, subset latin)
    ├── context.tsx             — EditorContext + CANVAS_SIZES (presets IG)
    ├── types.ts, api.ts        — tipos y fetch al backend
    ├── lib/
    │   └── logo.ts             — capa de logo fijo: applyLogoToCanvas/withoutLogo/isLogoObject
    ├── hooks/
    │   ├── use-canvas.ts       — toda la lógica de Fabric.js: texto, formas, imágenes,
    │   │                         fondo (cover/contain), undo/redo, resize, zoom, negrita
    │   │                         por selección, exportPNG, serialización (sin el logo)
    │   ├── use-designs.ts      — CRUD de diseños/páginas contra la API
    │   └── use-router.ts       — router mínimo, parsea `/design/:id`
    └── components/
        ├── editor.tsx, canvas-area.tsx, page-canvas.tsx, pages-bar.tsx
        ├── left-sidebar.tsx, right-sidebar.tsx, toolbar.tsx
        ├── home.tsx, design-list.tsx, template-card.tsx

public/
├── fonts/<Familia>/<peso>.woff2   — fuentes autoalojadas (servidas por Vite/estático)
└── logo-placeholder.svg           — logo placeholder (sustituir por el de marca)
```

## 4. Editor a medida (Fase 1 — completada)

| Tarea del plan | Estado / dónde vive |
|---|---|
| Presets de tamaño IG (1080×1080, 1080×1350, 1080×1920) | Hecho — [`src/client/context.tsx`](src/client/context.tsx) `CANVAS_SIZES`. Las 4 medidas LinkedIn se quitaron. |
| Logo fijo arriba-derecha | Hecho — [`src/client/lib/logo.ts`](src/client/lib/logo.ts) (`applyLogoToCanvas`/`withoutLogo`/`isLogoObject`). Capa `fabric.FabricImage` bloqueada (`selectable:false, evented:false, lockMovementX/Y:true`), marcada con `_isLogo`, recolocada en `setCanvasSize`/`loadTemplate`/undo-redo, **excluida** de todo lo que se persiste (save, historial) vía `withoutLogo`, e **incluida** en el export porque `exportPNG` lee el canvas en vivo. Usa un placeholder (`public/logo-placeholder.svg`) — sustituir por el logo real de marca cuando se tenga (solo cambiar el archivo/`LOGO_URL`, no hay que tocar lógica). |
| Negrita en selección (estilos por carácter) | Hecho — `toggleBold` en [`use-canvas.ts`](src/client/hooks/use-canvas.ts). Si el `Textbox`/`IText` está en edición con un rango de caracteres seleccionado, aplica `setSelectionStyles({fontWeight}, start, end)` (Fabric v6, per-character); si no, alterna el `fontWeight` del objeto entero (comportamiento previo). Verificado end-to-end: el `canvas_json` guardado incluye `styles: [{start, end, style: {fontWeight: "700"}}]` solo en el rango seleccionado. |
| Fuentes autoalojadas | Hecho — `public/fonts/<Familia>/<peso>.woff2` (36 archivos, solo subset *latin*, cubre acentos/ñ del español) + [`src/client/fonts.css`](src/client/fonts.css) (`@font-face` generado, importado desde `main.tsx`). Se quitó `WebFont.load` de `app.tsx`, el `<link>` de Google Fonts de `index.html`, y la dependencia `webfontloader`. |
| Encaje imagen origen (cover/contain) | Hecho — `fitBackgroundImage` en `use-canvas.ts`, con `setBackground(type, value, fit)` y `setBackgroundImageFit(fit)` para cambiar el encaje sin re-subir. UI: dos botones Cover/Contain en `left-sidebar.tsx` (sección Bg). El color de fondo del canvas ya sirve de "letterbox" para `contain`. |
| Export PNG (cliente, 2x) | Sin cambios de fondo — sigue en [`use-canvas.ts`](src/client/hooks/use-canvas.ts) `exportPNG`, `multiplier: 2`. Pendiente para Fase 2: exponer el `dataURL`/blob en vez de forzar `<a download>`, para el flujo con Twenty/n8n. |
| Quitar plantillas/tamaños LinkedIn | Hecho — seed de `templates` vaciado en [`schema.sql`](src/server/schema.sql) (las 6 plantillas `category: 'linkedin'` fuera). `templates` devuelve `[]`; `home.tsx` ya maneja ese caso (sección oculta si `templates.length === 0`). No había librería de stickers/SVG separada que quitar. |

### 4.1 Bug preexistente encontrado y arreglado durante la verificación

Al probar el editor real en navegador (no solo `tsc`/build) aparecieron dos problemas —
ninguno estaba en el plan, los dos bloqueaban el flujo básico de crear-un-diseño-y-editar:

1. **Diseño nuevo se abría sin páginas.** `createDesign`/`createFromTemplate` en
   [`use-designs.ts`](src/client/hooks/use-designs.ts) seteaban `activeDesign` con la
   respuesta del `POST` (que no trae `pages`), y como el `id` ya coincidía, el efecto que
   dispara `loadDesign` en `app.tsx` nunca se ejecutaba — el diseño se abría con `pages: []`
   y ninguna página visible hasta recargar. Arreglado: ambas funciones ahora hacen un
   `GET /api/designs/:id` justo después de crear (`activateCreatedDesign`) para poblar
   `pages`/`activePageId` de verdad. **Bug del template original, no introducido en Fase 1**,
   pero lo heredaba cualquier flujo nuevo.
2. **`{ ...selectedObject }` rompía el panel derecho tras la primera edición.** El spread de
   un objeto Fabric produce un objeto plano (pierde el prototipo), así que
   `selectedObject instanceof fabric.Textbox` pasaba a `false` en el siguiente render y
   `right-sidebar.tsx` mostraba el panel de "Shape" (genérico) en vez de "Text" tras cambiar
   *cualquier* propiedad (tamaño de fuente, color, negrita...). Arreglado con
   `cloneWithPrototype` (`Object.assign(Object.create(Object.getPrototypeOf(obj)), obj)`) en
   `use-canvas.ts`, que da una referencia nueva (dispara el re-render) sin perder la clase.
   **También preexistente** — reproducible con un simple cambio de tamaño de fuente en el
   template original, antes de tocar `toggleBold`.

Verificado con Playwright (headless Chromium) contra `pnpm run dev` real: sin errores de
consola, dropdown de tamaños con exactamente los 3 presets IG, logo visible en el canvas,
negrita por selección persistida correctamente, panel de texto estable tras editar.

## 5. Hallazgos de seguridad (para Fase 3)

- **`POST /api/uploads`** ([`src/server/index.ts`](src/server/index.ts), sección "File
  uploads"): la whitelist de extensiones permite **`svg`** explícitamente. `PLAN.md` §4/§6
  ya marca esto como riesgo ("denegar o sanear SVG"); confirmado en código, no es hipotético.
- **Sin autenticación**: ninguna ruta bajo `/api/*` tiene middleware de auth. Confirma
  `PLAN.md` §3/§6 tal cual.
- **Sanitización de nombre de fichero al leer** (`uploads.ts`, función `sanitize`) existe y
  es razonable (whitelist de caracteres), pero **no se aplica al escribir** (`putUpload` usa
  el `filename` generado con timestamp+random, así que en la práctica no hay input de
  usuario en el nombre al guardar — solo la extensión viene del cliente).
- **CORS/tainted canvas**: no hay proxy de imágenes externas todavía; todo el contenido hoy
  se sirve desde el propio origen (`/api/uploads/:filename`), así que el problema de
  "tainted canvas" que anticipa `PLAN.md` §7 aparecerá en cuanto se añada el fetch de la
  imagen de origen desde Twenty (Fase 2) si no se proxea por el backend.

## 6. `pnpm audit`

Estado en Fase 0 (con `@clawnify/*` + `wrangler` todavía en el árbol): 62 advisories totales,
51 en producción. Tras quitar `wrangler`/`@clawnify/*`/`better-sqlite3`/`webfontloader`
(Fase 1): **55 advisories totales, 52 en producción** (`3 low | 31 moderate | 17 high | 1
critical` en prod). Apenas bajó porque casi todo el volumen nunca vino de esa cadena — viene
de **`fabric` → `jsdom`/`canvas` → `@mapbox/node-pre-gyp` → `tar`** (código Node-side de
Fabric para SSR/tests, no usado en el bundle de navegador), que sigue igual porque `fabric`
sigue siendo una dependencia real (es el motor del canvas).

**Lectura para el plan:** ninguna de las vulnerabilidades de `fabric`→`jsdom` es explotable
en producción tal como se despliega (Node plano sirviendo el bundle de Vite ya compilado,
sin `jsdom`/`tar` ejecutándose en runtime). El riesgo real es *supply chain*, no runtime.
`PLAN.md` §6 pide "`pnpm audit` limpio y versiones fijadas" — dado que el upstream no
parcheará esto, conviene automatizar Renovate/Dependabot (Fase 5) pronto.

## 7. Otras discrepancias con `PLAN.md` a tener en cuenta

- El prompt de arranque (§10) menciona puertos `:5178`/`:3006` que no coinciden con la
  configuración real (API `:8787`, Vite `:5173`).
- `agent.md` y `clawnify.json` describen el propósito/deploy original de la plantilla
  (LinkedIn, Canva-like, plataforma Clawnify) — quedarán desactualizados cuando se reenfoque
  a Instagram/Twenty y ya no aplique el despliegue vía Clawnify; limpiar en Fase 1.
- `PLAN.md` §4 asumía Node 20+ para el Dockerfile; con `node:sqlite` el mínimo real es
  Node ≥ 22.5 (usar Node 24 LTS) — ver §1.

## 8. Estado actual

**Fase 1 completa** (servidor Node plano + editor a medida, ver §1 y §4). Verificado en
navegador real (Playwright headless), no solo `tsc`/build: crear diseño, tamaños IG, logo,
negrita por selección con persistencia correcta, cover/contain — todo probado end-to-end
sin errores de consola. `data.db`/`data.db-wal`/`data.db-shm` se limpiaron antes de dejar el
repo (se recrean solos al arrancar).

**Sin decidir todavía (activos reales, no solo código):**
- Logo de marca definitivo — hoy hay un placeholder en `public/logo-placeholder.svg`.
- Fuentes de marca definitivas — hoy autoalojadas las mismas 10 familias que traía el
  template (Google Fonts, descargadas y servidas localmente).

**Siguiente paso:** Fase 2 — integración con Twenty (`GET /api/publication/:id`, proxy de
imagen de origen) y n8n (`POST /api/publication/:id/render`), y el punto de entrada
`?recordId` desde Twenty. Ver `PLAN.md` §5 Fase 2.
