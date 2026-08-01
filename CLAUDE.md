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
│   ├── auth.ts        — Basic Auth de la app (ver §10)
│   ├── twenty.ts       — cliente GraphQL de Twenty (ver §9)
│   └── schema.sql    — DDL + seed de templates (SQL estándar, portable)
└── client/
    ├── main.tsx, app.tsx       — bootstrap Preact; main.tsx importa fonts.css
    ├── fonts.css               — @font-face autoalojado (generado, 36 caras, subset latin)
    ├── context.tsx             — EditorContext + CANVAS_SIZES (presets IG)
    ├── types.ts, api.ts        — tipos y fetch al backend
    ├── lib/
    │   ├── logo.ts             — capa de logo fijo: applyLogoToCanvas/withoutLogo/isLogoObject
    │   ├── background.ts       — capa de fondo: findBackgroundImage/makeBackgroundInteractive (§9.12)
    │   ├── fonts.ts            — carga y re-medición de webfonts en canvas (§9.13 bug B)
    │   ├── workspace.ts        — margen de trabajo + recorte de exportación (§9.13 bug C)
    │   └── effects.ts          — legibilidad del texto sobre foto: blur/oscurecido/velo (§9.14)
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
└── logo.png                       — logo de marca (faro blanco, fondo transparente, 500x500)

Dockerfile, .dockerignore   — build multi-stage para Dokploy (ver §11)
```

## 4. Editor a medida (Fase 1 — completada)

| Tarea del plan | Estado / dónde vive |
|---|---|
| Presets de tamaño IG (1080×1080, 1080×1350, 1080×1920) | Hecho — [`src/client/context.tsx`](src/client/context.tsx) `CANVAS_SIZES`. Las 4 medidas LinkedIn se quitaron. |
| Logo fijo arriba-derecha | Hecho — [`src/client/lib/logo.ts`](src/client/lib/logo.ts) (`applyLogoToCanvas`/`withoutLogo`/`isLogoObject`). Capa `fabric.FabricImage` bloqueada (`selectable:false, evented:false, lockMovementX/Y:true`), marcada con `_isLogo`, recolocada en `setCanvasSize`/`loadTemplate`/undo-redo, **excluida** de todo lo que se persiste (save, historial) vía `withoutLogo`, e **incluida** en el export porque `exportPNG` lee el canvas en vivo. Usa el logo real de marca (`public/logo.png`, faro blanco, fondo transparente) — para cambiarlo, solo sustituir el archivo/`LOGO_URL` en `logo.ts`, no hay que tocar lógica; el archivo debe tener canal alfa real (RGBA), un JPG opaco se ve como un cuadro sólido encima del fondo. |
| Negrita en selección (estilos por carácter) | Hecho — `toggleBold` en [`use-canvas.ts`](src/client/hooks/use-canvas.ts). Si el `Textbox`/`IText` está en edición con un rango de caracteres seleccionado, aplica `setSelectionStyles({fontWeight}, start, end)` (Fabric v6, per-character); si no, alterna el `fontWeight` del objeto entero (comportamiento previo). Verificado end-to-end: el `canvas_json` guardado incluye `styles: [{start, end, style: {fontWeight: "700"}}]` solo en el rango seleccionado. |
| Fuentes autoalojadas | Hecho — `public/fonts/<Familia>/<peso>.woff2` (36 archivos, solo subset *latin*, cubre acentos/ñ del español) + [`src/client/fonts.css`](src/client/fonts.css) (`@font-face` generado, importado desde `main.tsx`). Se quitó `WebFont.load` de `app.tsx`, el `<link>` de Google Fonts de `index.html`, y la dependencia `webfontloader`. |
| Encaje imagen origen (cover/contain) | Hecho — `fitBackgroundImage` en `use-canvas.ts`, con `setBackground(type, value, fit)` y `setBackgroundImageFit(fit)` para cambiar el encaje sin re-subir. UI: dos botones Cover/Contain en `left-sidebar.tsx` (sección Bg). El color de fondo del canvas ya sirve de "letterbox" para `contain`. Además el fondo se puede **arrastrar y redimensionar a mano** (§9.12); Cover/Contain hacen de reset. |
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

> **Resueltos en Fase 3** (ver §10) — se dejan documentados aquí como hallazgo histórico:
> whitelist de subida permitía SVG, y no había ninguna autenticación en `/api/*`.

- **Sanitización de nombre de fichero al leer** (`uploads.ts`, función `sanitize`) existe y
  es razonable (whitelist de caracteres), pero **no se aplica al escribir** (`putUpload` usa
  el `filename` generado con timestamp+random, así que en la práctica no hay input de
  usuario en el nombre al guardar — solo la extensión viene del cliente).
- **CORS/tainted canvas**: resuelto — la imagen de origen de Twenty se proxea por
  `GET /api/news/:id/image` (mismo origen), no se carga cross-origin directamente.

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

**Logo de marca:** `public/logo.png` (faro blanco, **fondo transparente**, 500×500 RGBA,
provisto por el usuario desde `img_custom/logow-removebg.png`, ahora en `.gitignore`
porque tiene otros archivos personales sueltos, no solo el logo). Reemplaza a la versión
inicial en JPG (`logo.jpg`, fondo negro) — un JPG no tiene canal alfa, así que se veía
como un cuadro negro opaco encima de la imagen de fondo en vez de solo el faro. `logo.ts`
exige que el archivo tenga transparencia real (RGBA); si se vuelve a cambiar el logo,
confirmar que el nuevo export también la tiene.

**Fase 3 completa** (seguridad/hardening a nivel app, ver §10).

**Fase 4 completa por el lado del repo** (`Dockerfile` + `.dockerignore`, ver §11) —
build y arranque verificados localmente con `docker build`/`docker run` (auth, health
check, usuario no-root, persistencia en `/data`, todo probado, no solo leído). El Basic
Auth de la app (Fase 3) se amplió durante esta fase a **toda** la app, no solo `/api/*`
(ver §10.1) — al ser el único requisito real de acceso, el middleware de Traefik queda
como opcional (§11.4), simplificando lo que hay que tocar en el panel de Dokploy. Falta
la parte que solo se puede hacer con acceso real a ese panel: crear la Application, pegar
las env vars, montar el volumen, poner el dominio — nada de eso es código de este repo,
son pasos manuales del usuario en su infraestructura.

**Sin decidir todavía (activos reales, no solo código):**
- Fuentes de marca definitivas — hoy autoalojadas las mismas 10 familias que traía el
  template (Google Fonts, descargadas y servidas localmente).
- Dominio real del editor una vez desplegado — determina `PUBLIC_BASE_URL` y la URL final
  del enlace de Twenty (§9.7); hasta entonces sigue apuntando a `localhost`.
- Nombre de servicio interno de Twenty en Dokploy, para la optimización de red interna
  opcional de §11.5 (no bloqueante).

## 9. Fase 2 — Integración con Twenty (completa, sin n8n)

**Alcance real, distinto del `PLAN.md` original:** este editor solo diseña y **sustituye
la imagen en Twenty**. No publica en redes sociales — eso lo hace otro flujo, totalmente
aparte, que el usuario gestiona por su cuenta. Por eso **no hay n8n en este flujo**: se
descartó el `POST /api/publication/:id/render → webhook n8n` que preveía `PLAN.md` §3,
porque no existe (ni hace falta) un paso de "publicar" aquí.

### 9.1 Objeto y campos reales en Twenty (verificado por introspección GraphQL en vivo)

- Objeto: **`News`** (query singular `news(filter: {...})`, plural `newss`).
- `imagen` (Files, puede ser `null`) — imagen de origen. Su URL viene con un **token
  firmado de corta duración** (~24h) — nunca cachear esa URL, pedirla en el momento.
- `title` (RichText) — se usa el subcampo `title.markdown` como texto por defecto.
- `imagenEditada` (Links, campo creado por el usuario para este proyecto) — aquí se
  escribe la URL pública del PNG exportado. Shape de escritura:
  `updateNews(id, data: { imagenEditada: { primaryLinkUrl, primaryLinkLabel } })`.
- No se toca ningún campo de estado (`estado` existe en el objeto pero es cosa de un
  workflow propio del usuario, fuera de este editor).

### 9.2 Por qué no se sube como fichero (`imagen`) sino como Link (`imagenEditada`)

Se investigó a fondo (código fuente de Twenty en GitHub) cómo subir un fichero al campo
`imagen` (tipo Files) vía API. Conclusión: **no hay forma viable con esta instancia**.
El flujo "oficial" más reciente de Twenty (`createFileUpload` → `PUT` bytes →
`completeFileUpload`) y el legacy anterior (`uploadFilesFieldFile`) **no existen en el
esquema GraphQL de esta instancia** (confirmado por introspección real, dos veces — 302
mutations totales, ninguna de subida). La REST API tampoco lo resuelve (`PATCH /newss/{id}`
solo acepta JSON con un `fileId` ya existente, mismo problema). O es una versión de Twenty
más antigua con un mecanismo distinto no documentado, o requiere sesión de usuario en vez
de API key. **Decisión del usuario:** en vez de perseguir ese endpoint, creó un campo nuevo
`imagenEditada` de tipo Links y el editor escribe ahí una URL pública propia — cero
problema de subida de ficheros a Twenty, y probado end-to-end contra su CRM real.

**Requisito obligatorio del usuario:** esa URL debe ser accesible por `GET` público, sin
auth. Hoy `/api/uploads/:filename` no tiene ninguna autenticación (ver hallazgo de
seguridad heredado de Fase 0), así que ya lo cumple — verificado con un `curl` sin ninguna
cabecera. **Ojo para la Fase 3** (proteger `/api/*`): esta ruta concreta tiene que quedar
**excluida** de cualquier middleware de auth que se añada, o esta integración se rompe.

### 9.3 Endpoints nuevos (`src/server/index.ts` + `src/server/twenty.ts`)

- `GET /api/news/:id` — `{ id, title, imageUrl }`; `imageUrl` es siempre nuestra propia
  ruta de proxy (`/api/news/:id/image`), nunca la URL firmada de Twenty directamente.
- `GET /api/news/:id/image` — proxea los bytes reales desde Twenty (evita *tainted
  canvas* y no expone el token firmado al navegador).
- `POST /api/designs/from-news/:newsId` — *find-or-create*: si ya existe un `design` con
  ese `twenty_record_id` lo devuelve (con páginas), si no lo crea. Abrir el enlace de la
  misma noticia dos veces retoma el mismo borrador, no crea uno nuevo cada vez.
- `POST /api/news/:id/publish-image` — recibe el PNG exportado (multipart), lo guarda con
  el mismo mecanismo que `/api/uploads`, y escribe la URL pública en `imagenEditada`.

`src/server/db.ts`/`schema.sql`: la tabla `designs` tiene ahora `twenty_record_id TEXT`
con índice único (parcial, solo cuando no es `NULL`) — un diseño por noticia.

### 9.4 Frontend

- `src/client/hooks/use-router.ts` expone `recordId` (de `?recordId=` en la URL, cualquier
  ruta — pensado para `/edit?recordId=<id>`).
- `src/client/app.tsx`: si hay `recordId` y no hay `designId` todavía, llama a
  `openFromNewsRecord` (→ `POST /api/designs/from-news/:id`) y navega a `/design/:id`.
- **Imagen de origen: se refresca en CADA apertura del editor**, no solo la primera vez
  (cambiado tras el feedback del usuario — la "Imagen" en Twenty puede reemplazarse
  después de guardar un borrador si no encajaba, y el editor debe reflejar siempre la
  versión actual, no una copia congelada de la primera vez que se abrió). Vive en
  `src/client/components/page-canvas.tsx`, no en `app.tsx` (donde vivía antes) — tiene
  que ejecutarse **después** de que `loadFromJSON` termine de cargar el `canvas_json`
  guardado de esa página, porque `loadFromJSON` sustituye todo el contenido del canvas:
  si el refresco se dispara antes (p. ej. a través del "canvas activo" de
  `use-canvas.ts`, que no da ninguna garantía de orden frente a esa carga async), la
  imagen recién puesta se borraría en cuanto `loadFromJSON` resolviera. Por eso
  `setBackground`/`addText` de `use-canvas.ts` se separaron en una parte "resuelve cuál
  es el canvas activo" (sin cambios de comportamiento para el resto del editor) y una
  parte parametrizada por canvas explícito (`applyBackgroundToCanvas`/
  `applyTextToCanvas`, nuevas, expuestas por el contexto) que `page-canvas.tsx` llama
  directamente sobre su propio canvas, encadenada dentro del mismo `.then()` de la carga
  — así queda garantizado el orden sin necesitar ninguna señal/callback nueva entre
  componentes.
  El título por defecto (heading) **sigue aplicándose solo la primera vez** (página en
  blanco, `canvas_json === "{}"`) — solo la imagen se refresca siempre; si el operador ya
  escribió texto, no se toca. Solo se aplica en la página principal (`pages[0]`) del
  diseño, igual que antes. Verificado con Playwright: tras guardar contenido y refrescar
  la página del navegador, se repiten las llamadas a `GET /api/news/:id` y
  `GET /api/news/:id/image`, el título y una forma añadida a mano se conservan sin
  duplicarse, y `bgSrc` del objeto de fondo en el canvas sigue apuntando al proxy
  correcto — sin errores de consola.
- Botón **"Guardar en Twenty"** en el toolbar (visible solo si el diseño tiene
  `twenty_record_id`): exporta la imagen (`exportUploadBlob` en `use-canvas.ts`, devuelve
  un `Blob` en vez de forzar la descarga) y la sube vía `publish-image`. **JPEG, no
  PNG** (a diferencia del botón "Export" normal, que sigue en PNG) — el canvas siempre
  tiene fondo opaco (color o imagen con cover/contain), así que no hay transparencia que
  perder, y un PNG 2x de un diseño con foto de fondo puede pesar 5-10+ MB, mucho más
  frágil en producción (memoria del contenedor, proxies de por medio) que el mismo diseño
  en JPEG (`quality: 0.92`) — verificado: el mismo diseño de prueba pasó de 6.5 MB en PNG
  a 750 KB en JPEG. El servidor (`POST /api/news/:id/publish-image`) detecta el mime real
  del blob recibido (`file.type`) en vez de asumir PNG, así que sigue funcionando si
  algún día se manda otro formato.

### 9.5 Verificado end-to-end contra el Twenty real (`crm.elfarodealicante.com`)

Con Playwright: `/edit?recordId=<news real>` → navega al editor → imagen y título reales
precargados → clic en "Guardar en Twenty" → `imagenEditada` actualizado en Twenty (leído
de vuelta por GraphQL para confirmarlo) → la URL escrita responde `200` a un `curl` sin
cabeceras de auth. Datos de prueba limpiados después (campo `imagenEditada` revertido a
vacío en el registro usado para probar).

**Pendiente, no bloqueante para seguir desarrollando:** `PUBLIC_BASE_URL` hoy apunta a
`http://localhost:8787` (solo sirve para probar la mecánica en local). Para que Twenty
pueda hacer `GET` de verdad desde fuera hace falta el dominio público real — se resuelve
solo en la Fase 4 (despliegue) o con un túnel temporal si se quiere probar antes.

### 9.6 Variables de entorno nuevas

`.env` (no commiteado) y `.env.example` (documentado, sin valores):
- `TWENTY_API_URL` — `https://crm.elfarodealicante.com`.
- `TWENTY_TOKEN` — API key de workspace completo (Settings → API & Webhooks en Twenty).
  **No tiene alcance limitado a `News`** — Twenty no ofrece API keys con permisos
  granulares por objeto; es un secreto de servidor de acceso total al workspace, tratarlo
  como tal (nunca en el cliente, nunca commiteado).
- `PUBLIC_BASE_URL` — base para construir la URL pública de `imagenEditada`.

`package.json`: `dev`/`start` ahora usan `tsx --env-file-if-exists=.env` (flag nativo de
Node ≥ 20.6, sin dependencia `dotenv`) para cargar `.env` automáticamente; no falla si el
fichero no existe (alguien sin Twenty configurado puede seguir usando el editor solo).

### 9.7 Punto de entrada desde Twenty

Campo tipo **Link** en la ficha de `News`, apuntando a:

```
https://<DOMINIO-DEL-EDITOR>/edit?recordId={{id del registro}}
```

`<DOMINIO-DEL-EDITOR>` depende del despliegue de la Fase 4 (ver §11 — dominio público +
Basic Auth de app, sin middleware de Traefik necesario). **Para probarlo ya, en local:**
`http://localhost:5173/edit?recordId=<id>` (con `pnpm run dev` corriendo) — funciona igual
que en producción salvo que el campo `imagenEditada` no será accesible desde fuera de esta
máquina hasta que exista el dominio real. Rellenar el campo Link con el `id` de cada
registro es manual por ahora (bajo volumen, per lo que dijo el usuario sobre el campo de
estado); automatizarlo con un Workflow de Twenty (fórmula `CONCAT` sobre `record.id`) es
un afinado de Fase 5, no bloqueante.

### 9.8 Manejo de errores de red más robusto (`api.ts`, `use-designs.ts`, `twenty.ts`)

Tras un reporte del usuario de un `Failed to fetch` genérico al pulsar "Guardar en
Twenty", que no se pudo reproducir de forma determinista (probado varias veces contra el
Twenty real, siempre completó correctamente) — la teoría más plausible es una colisión
de puertos/proceso: durante esta misma sesión se reinició el servidor de dev
(`:5173`/`:8787`) muchas veces para pruebas de Docker y de la Fase 4, así que si había una
pestaña del navegador abierta contra esos mismos puertos en ese momento, una petición
podía caer justo cuando el servidor estaba reiniciando — eso sí produce un `Failed to
fetch` real (fallo de conexión), sin ser un bug de la app.

Aun así, la investigación destapó un bug real y independiente: **cualquier respuesta de
error que no sea JSON rompía el manejo de errores en el cliente.** El Basic Auth de Hono
devuelve el cuerpo de un `401` como texto plano (`"Unauthorized"`), no JSON — tanto
`api()` (`src/client/api.ts`) como `publishToTwenty` (`src/client/hooks/use-designs.ts`)
hacían `await r.json()` sin capturar el fallo de parseo, así que un `401` (sesión
caducada, credenciales incorrectas, etc.) se mostraba como
`SyntaxError: Unexpected token 'U', "Unauthorized" is not valid JSON` en vez de un
mensaje explicable. Reproducido y confirmado con Playwright usando credenciales
incorrectas a propósito.

Arreglado en los tres sitios que hablan con el exterior:
- `src/client/api.ts` (`api()`, usado por casi todo el frontend): `fetch()` envuelto en
  `try/catch` (fallo de red real → mensaje claro en vez de dejar pasar el `TypeError`
  crudo de "Failed to fetch"); `r.json()` envuelto en `try/catch` (respuesta no-JSON no
  rompe nada); `401` específicamente → "Sesión expirada o credenciales inválidas —
  recarga la página e inicia sesión de nuevo."
- `src/client/hooks/use-designs.ts` (`publishToTwenty`): mismo patrón, no reutiliza
  `api()` directamente porque manda `multipart/form-data` (un `Blob`), no JSON.
- `src/server/twenty.ts` (`twentyGraphQL`, usado por `fetchNews` y
  `setNewsEditedImage`): se le añadió `signal: AbortSignal.timeout(15000)`. Sin esto, una
  Twenty lenta o caída dejaba la petición del servidor colgada indefinidamente — el
  navegador nunca recibe respuesta hasta que algún timeout intermedio (el proxy de Vite
  en dev, Traefik en producción) corta la conexión por su cuenta, lo cual desde el
  cliente se ve exactamente como un `Failed to fetch` sin ninguna pista de la causa real.
  Ahora falla rápido con un mensaje explícito ("Twenty no respondió a tiempo").

Verificado con Playwright: con credenciales correctas, "Guardar en Twenty" sigue
completando con éxito (probado dos veces contra el Twenty real — **ambas escrituras de
prueba en `imagenEditada` se revirtieron a vacío después**, mismo procedimiento que en
§9.5); con credenciales incorrectas a propósito, el error ahora es el mensaje de sesión
expirada, no el `SyntaxError` de antes.

**Seguimiento:** el usuario reportó que el `Failed to fetch` seguía pasando **ya
desplegado en Dokploy** (no en local), y solo en "Guardar en Twenty" — el "Save" normal
(JSON, sin archivo) funcionaba bien. Eso apunta a algo específico de subir un archivo
grande en producción (memoria del contenedor, límite de un proxy intermedio), no a
autenticación ni conectividad general. No hay acceso directo al VPS/Dokploy del usuario
para confirmar la causa exacta con logs, así que se atacó el factor de riesgo más
controlable desde el código: el tamaño del archivo — ver §9.9. Si el error persiste tras
ese cambio, el siguiente paso es pedir los logs de la Application en Dokploy justo en el
momento del fallo (para ver si el contenedor se reinicia/OOM-kill o si hay un error de
Traefik).

### 9.9 Export a JPEG (no PNG) para "Guardar en Twenty"

`exportUploadBlob` en `use-canvas.ts` (antes `exportPNGBlob`) exporta con
`format: "jpeg", quality: 0.92` en vez de PNG. El canvas siempre tiene fondo opaco (color
o imagen en cover/contain), así que no hay transparencia que perder. Un PNG 2x de un
diseño con foto de fondo puede pesar 5-10+ MB; el mismo diseño en JPEG calidad 0.92 es
una fracción de eso sin pérdida visible — verificado con el mismo diseño de prueba: 6.5
MB en PNG → 750 KB en JPEG. El botón "Export" normal (descarga manual) no se tocó, sigue
en PNG.

`POST /api/news/:id/publish-image` (`src/server/index.ts`) ya no asume `.png`/
`image/png` al guardar — detecta el mime real del archivo recibido (`file.type`) y usa
`.jpg`/`image/jpeg` salvo que de verdad sea un PNG, así que sigue funcionando igual si
algún día se manda otro formato. Verificado con `curl -D -`: el archivo subido responde
con `Content-Type: image/jpeg` y `Content-Disposition: inline; filename="....jpg"`.

### 9.10 Logging de peticiones y no-cache de `index.html` (diagnóstico en producción)

El `Failed to fetch` seguía apareciendo en producción tras el cambio a JPEG, y los logs
del contenedor que mandó el usuario **solo contenían el arranque** (`API listening...`).
Eso no era información: **el servidor no registraba ninguna petición**, así que era
imposible distinguir "la petición nunca llegó" (red/proxy) de "llegó y falló dentro".

Dos cambios, ambos verificados con un build de producción real (`pnpm run build` +
`pnpm run start`, no solo `tsc`):

1. **Logging** (`src/server/index.ts`):
   - Middleware global que loguea `[MÉTODO ruta] status en Nms` para toda petición, y
     captura/registra cualquier excepción no manejada antes de dejarla propagar (un throw
     que escapa se traduce en una conexión cortada sin respuesta útil — exactamente como
     se ve un `Failed to fetch` desde el navegador).
   - `publish-image` loguea sus tres fases por separado, porque cada una falla de forma
     distinta y antes no había manera de saber en cuál moría: parsear el multipart,
     escribir en el volumen (`/data/uploads` — típico fallo de permisos si el volumen
     montado no es escribible por el usuario no-root, o disco lleno), y la llamada a
     Twenty. Cada fase tiene su `try/catch` con un status HTTP y un mensaje propios.
     Verificado provocando un fallo real (POST con un UUID inválido): el log muestra
     `inicio` → `fichero recibido: N bytes, tipo image/jpeg` → `guardado en disco: ...` →
     `fallo al actualizar Twenty: <error>` → `502 en 233ms`.

2. **`index.html` nunca se cachea** (`src/server/serve.ts`): es el único fichero con
   nombre estable, y es el que apunta a los bundles JS/CSS con hash en el nombre. Si el
   navegador servía una copia cacheada tras un redeploy, el operador seguía ejecutando el
   build **anterior** indefinidamente. Ahora `index.html` va con `Cache-Control: no-cache,
   no-store, must-revalidate` y los assets hasheados de `/assets/` con
   `max-age=31536000, immutable` (pueden cachearse para siempre: un build nuevo genera
   nombres nuevos). Las rutas `/api/*` no se tocan. Verificado con `curl -D -` en los tres
   casos. Sigue siendo correcto tenerlo, pero **no era la causa del bug** — ver §9.11.

> **Hipótesis descartada:** en este punto se creyó que el `"Failed to fetch"` literal
> significaba que el navegador ejecutaba un bundle viejo (porque un commit anterior ya
> había sustituido ese texto por un mensaje en español). Era falso: ese mensaje concreto
> lo produce el navegador *dentro* de `exportUploadBlob`, antes de llegar al código con el
> `try/catch` traducido. La causa real está en §9.11; el logging de este apartado es lo
> que permitió encontrarla.

### 9.11 CAUSA RAÍZ del `Failed to fetch`: la CSP bloqueaba `fetch()` sobre `data:` URL

**El bug real, confirmado en producción y reproducido en local bajo la CSP.**

El logging de §9.10 fue decisivo: en los logs del contenedor durante un fallo aparecían
todas las peticiones normales (`GET /api/news/...`, `/api/designs`, etc.) pero **ni una
sola línea `[POST /api/news/.../publish-image]`**. La petición no es que fallara en el
servidor: es que **nunca llegaba a salir del navegador**.

El motivo estaba en cómo se exportaba la imagen (`use-canvas.ts`):

```ts
const dataURL = canvas.toDataURL({ format: "jpeg", ... });
const res = await fetch(dataURL);   // ← aquí
return res.blob();
```

`fetch()` sobre un `data:` URL cuenta como una conexión a efectos de CSP, y la política
de la Fase 3 (§10.3) solo permite `connect-src 'self' ws: wss:`. El navegador lo bloquea
y `fetch` rechaza con `TypeError: Failed to fetch` — **exactamente el texto que veía el
usuario**, generado por el navegador, no por nuestro código. Por eso el `try/catch`
añadido en §9.8 no lo capturaba con un mensaje mejor: ese blindaje envuelve el `fetch` de
`publishToTwenty`, pero el que fallaba era el de `exportUploadBlob`, que corre *antes* y
cuyo error lo recoge el `catch` genérico del toolbar, que muestra `e.message` tal cual.

Confirmado con Playwright contra el build de producción (ver más abajo):

```
Connecting to 'data:text/plain;base64,...' violates the following Content Security Policy
directive: "connect-src 'self' ws: wss:". The action has been blocked.
```

**Por qué no se detectó antes, pese a probarlo varias veces con Playwright:** todas las
verificaciones anteriores se hicieron contra `pnpm run dev` (Vite en `:5173`), y **en dev
el HTML lo sirve Vite sin nuestra cabecera CSP** — algo que este propio documento ya
avisaba en §10.3 sin extraer la consecuencia. La CSP solo existe cuando el HTML lo sirve
Hono desde `dist/`. **Regla para adelante: cualquier cosa que pueda depender de la CSP
(fetch, workers, blobs, estilos/scripts inline) hay que probarla contra
`pnpm run build && pnpm run start` en `:8787`, no contra `:5173`.**

**Arreglo:** se eliminó por completo el round-trip por `data:` URL. `exportBlob` usa el
`canvas.toBlob({ format, quality, multiplier })` nativo de Fabric v6, que va directo del
canvas a un `Blob` sin pasar por base64 ni por `fetch` — así no interviene la CSP en
absoluto (no hace falta relajarla) y además se ahorra tener en memoria una copia base64
de la imagen 2x entera, que en un diseño con foto son varios MB de string encima del
bitmap. `exportPNG` (el botón de descarga manual) se pasó también a `Blob` +
`URL.createObjectURL` por el mismo motivo, con `revokeObjectURL` diferido.

Verificado contra el build de producción real (`pnpm run build` + `pnpm run start`,
`:8787`, con la CSP activa): `fetch('data:...')` sigue bloqueado (confirma el
diagnóstico), `canvas.toBlob` funciona, y el botón "Guardar en Twenty" completa de punta
a punta — 1 petición `publish-image` enviada, respuesta `200`, sin banner de error, sin
errores de consola más allá del bloqueo de `data:` provocado a propósito para la prueba.
Escritura de prueba en `imagenEditada` revertida a vacío después, como siempre.

### 9.12 Fondo movible + dos bugs de serialización que salieron a la luz

Petición del usuario: la imagen de origen entraba como fondo **fijo e inamovible**, y si
no encajaba bien no había forma de recolocarla desde el editor (había que cambiarla en
Twenty). Ahora el fondo se puede **arrastrar y redimensionar** como cualquier otro objeto.

**`src/client/lib/background.ts` (nuevo)** — toda la lógica de identificar y configurar la
capa de fondo, que antes estaba dispersa en búsquedas sueltas de `_isBgImage`:

- `makeBackgroundInteractive(img)`: `selectable`/`evented`/`hasControls` a `true`. La
  **rotación se deja bloqueada** a propósito (`lockRotation`, y se oculta el control `mtr`
  con `setControlVisible`, que es por instancia — mutar `img.controls` afectaría a todos
  los objetos porque el objeto de controles se comparte): para encuadrar un fondo, rotar
  casi siempre es un accidente. Los botones **Cover/Contain** del sidebar siguen
  funcionando y hacen de "reset" del encuadre si el operador se lía.
- `findBackgroundImage(canvas)`: busca por `_isBgImage` y, si no lo encuentra, cae al
  primer `FabricImage` que no sea el logo y lo re-marca (migración de diseños antiguos).

**Bug 1 — fondos duplicados acumulándose.** Fabric **solo serializa las propiedades que
conoce**: `toObject()` incluye `propertiesToInclude.concat(FabricObject.customProperties,
this.constructor.customProperties)`, y `customProperties` es `[]` por defecto. Es decir,
`_isBgImage`/`_bgFit` **se perdían al guardar**. Al reabrir un diseño, el refresco de la
imagen (§9.4) buscaba el fondo anterior para reemplazarlo, no lo encontraba, y **añadía
uno nuevo encima del viejo** — un fondo más por cada apertura. También rompía los botones
Cover/Contain en diseños restaurados. Arreglado registrando
`fabric.FabricImage.customProperties = ["_isBgImage", "_bgFit"]` en `background.ts`
(verificado leyendo el `canvas_json` guardado de vuelta desde la API: la marca ya viaja).

**Bug 2 — el refresco automático borraba el encuadre manual.** Como la imagen se re-pide a
Twenty en *cada* apertura (§9.4), volver a aplicar el `cover` sin más deshacía cualquier
recolocación guardada, dejando la nueva función inútil para borradores. Ahora
`applyBackgroundToCanvas` acepta `{ preserveFraming: true }` (lo pasa solo el refresco de
`page-canvas.tsx`, no una subida manual desde el sidebar) y **conserva
`left/top/scaleX/scaleY` del fondo anterior cuando la imagen entrante tiene el mismo
tamaño natural** — misma foto re-descargada, o un cambio donde la transformación anterior
sigue teniendo sentido geométrico. Si las dimensiones cambian, es otra foto y se aplica un
encaje limpio.

Los diseños guardados **antes** de este cambio tienen `selectable: false` grabado en su
JSON (esa sí es una propiedad estándar y se serializaba), así que `page-canvas.tsx`
normaliza el fondo con `makeBackgroundInteractive` justo después de `loadFromJSON` — si no,
los borradores antiguos seguirían con el fondo bloqueado para siempre.

**Verificado contra el build de producción** (`:8787`, con CSP real — ver la regla de
§10.3), no contra dev: arrastre **con ratón real** sobre el canvas → el fondo se mueve y
queda seleccionado; Guardar → el `canvas_json` persistido contiene la marca y la posición
nueva; recargar → **un solo fondo** (no duplicados), posición conservada, sigue
seleccionable y al fondo del stack (índice 0, debajo de texto y logo); pulsar **Cover** →
vuelve al encuadre limpio. Sin errores de consola en ningún paso.

### 9.13 Solidez del editor: texto y área de trabajo

Reporte del usuario: «la edición del texto es pésima — el recuadro de contorno se
descuadra y no encaja con el tamaño real, hay palabras que se tapan solas, y a veces no
se edita el texto al modificarlo desde el panel derecho». Eran **tres bugs distintos**,
cada uno con su causa; ninguno era cosmético.

#### Bug A — el panel derecho mutaba un objeto fantasma

`updateSelectedObject` guardaba en el estado una **copia** del objeto seleccionado tras
cada cambio (primero un spread `{...obj}`, luego un clon que preservaba el prototipo),
solo para darle a Preact una referencia nueva y que no se saltara el re-render. Esa copia
está **desconectada del canvas**: a partir del segundo cambio, el panel mutaba un objeto
que ya no era el del lienzo. Por eso «a veces» no se editaba — en realidad *siempre*
fallaba salvo el primer cambio tras seleccionar algo.

Ahora el estado guarda el **objeto real** y hay un contador `selectionVersion` que se
incrementa en cada mutación; eso es lo que dispara el re-render, y el panel siempre lee
valores vivos. Verificado: tres cambios seguidos de `fontSize` (60 → 72 → 90) desde el
panel se aplican los tres al objeto del canvas.

#### Bug B — el texto se medía con una fuente que aún no había cargado

El texto en canvas **no dispara la descarga de webfonts**: el navegador solo pide un
`@font-face` cuando algo *del documento* lo necesita, y un `fillText()` sobre un `<canvas>`
no cuenta. Así que Fabric medía con la fuente de reserva, **cacheaba** esos anchos de
carácter y maquetaba con ellos, mientras que lo que se acababa pintando era la fuente
real. De ahí los tres síntomas a la vez: recuadro y tiradores que no encajan con las
letras, palabras encimadas (el `Textbox` partía las líneas con anchos equivocados) y texto
que reflowea solo un instante después de cargar.

Es un problema que la propia documentación de Fabric describe, con su solución: cuando la
fuente esté disponible de verdad, limpiar su caché de anchos y llamar a `initDimensions()`.
Eso es `src/client/lib/fonts.ts` (nuevo): `syncCanvasFonts(canvas)` recoge las
combinaciones (familia, peso) realmente usadas — **incluidos los estilos por carácter**,
que es donde vive la negrita por selección —, fuerza su carga con `document.fonts.load()`,
limpia `fabric.cache.clearFontCache()` y re-mide todo el texto. Se llama al cargar una
página, al restaurar del historial, al aplicar una plantilla, al añadir texto y al cambiar
familia o peso.

**Es una regresión introducida en la Fase 1**: el template original usaba `WebFont.load`,
que tenía callback de "ya están listas"; al sustituirlo por `@font-face` autoalojado nunca
se añadió el paso de re-medir.

Verificado de forma objetiva: forzar una re-medición cuando las fuentes están garantizadas
devuelve **exactamente las mismas dimensiones** que ya tenía el objeto (`idéntico: true`),
lo que prueba que la maquetación ya está hecha con las métricas reales. La caja de
selección difiere del objeto en 1px, que es el grosor del propio borde.

#### Bug C — los tiradores del fondo caían fuera del elemento canvas

El elemento `<canvas>` medía exactamente lo que la página, así que cualquier objeto que
sobresaliera — sobre todo el fondo, que se escala a *cover* y por definición es más grande
que la página — tenía sus tiradores fuera del elemento, donde no se pueden ni dibujar ni
pulsar. Redimensionar el fondo era imposible.

`src/client/lib/workspace.ts` (nuevo) introduce un **margen de trabajo** alrededor de la
página (`WORKSPACE_PADDING = 320`): el canvas es mayor que la página, el
`viewportTransform` desplaza el origen para que la coordenada (0,0) siga siendo la esquina
de la página, y un `clipPath` recorta el pintado a la página — Fabric dibuja los controles
**después** de aplicar el recorte (`controlsAboveOverlay: true`), así que los tiradores
siguen visibles y utilizables en el margen. El `clipPath` lleva `excludeFromExport: true`
para no ensuciar el `canvas_json` guardado: es una propiedad del visor, no del diseño.

- **La exportación no cambia**: `pageExportCrop()` recorta la salida exactamente a la
  página. Verificado: el PNG/JPEG exportado sigue midiendo 2160×2160 para una página de
  1080×1080, con margen y todo.
- `page-canvas.tsx` dibuja la "página" como una tarjeta blanca con sombra **detrás** del
  canvas (que es transparente fuera del recorte), y el contenedor ya no lleva
  `overflow-hidden`, que volvería a cortar justo lo que este cambio expone.
- `canvas-area.tsx` calcula el encaje/zoom contra el tamaño del área de trabajo, no de la
  página.

**Límite conocido y por qué 320.** Una foto que cubre una página cuadrada sobresale
`(aspecto − 1) / 2` del ancho por lado: ~270px con una foto 3:2, ~420px con una 16:9.
Cubrir el peor caso exigiría un canvas de casi el triple del área de la página, y cada
píxel es memoria real (×4 bytes, ×devicePixelRatio², ×número de páginas). 320 cubre los
casos habituales; para fotos más panorámicas los tiradores laterales pueden quedar fuera,
y por eso el panel derecho tiene ahora una sección **Background** (aparece al seleccionar
el fondo) con un **deslizador de escala** — que escala respecto al centro de la página, no
al origen del objeto — y botones Cover/Contain para resetear el encuadre. Arrastrar
siempre funciona, independientemente de los tiradores.

Todo lo anterior verificado contra el **build de producción** (`:8787`, con CSP real —
§10.3), incluyendo que "Guardar en Twenty" sigue funcionando de punta a punta y que no
aparece ningún error de consola. Escritura de prueba en `imagenEditada` revertida.

### 9.14 Efectos de legibilidad del texto sobre la foto

Petición del usuario: poder difuminar o similar la imagen «para que sea más fácil poner un
texto legible encima». Es el problema clásico de texto sobre foto, y en diseño editorial se
resuelve con tres herramientas que aquí están todas (`src/client/lib/effects.ts`, nuevo;
UI en la sección **Bg** del sidebar izquierdo, bajo "Text legibility"):

- **Blur** — filtro `fabric.filters.Blur` sobre la imagen de fondo. Útil cuando la foto
  tiene mucho detalle y el texto se pierde entre él.
- **Darken** — filtro `fabric.filters.Brightness`, limitado a valores negativos: aquí solo
  interesa oscurecer, para ganar contraste.
- **Shade (velo/"scrim")** — una capa aparte sobre la foto, en cuatro modos: `Off`, `All`
  (velo uniforme), `Down` (degradado transparente arriba → oscuro abajo, para texto en la
  parte baja) y `Up` (el mismo, invertido). El degradado es lo que suelen usar los
  layouts editoriales y de redes: da contraste justo donde va el texto sin apagar la foto
  entera.

Notas de implementación:

- El **velo es un `fabric.Rect` gestionado**, no una propiedad de la imagen: se inserta
  **justo encima del fondo y debajo de todo lo demás** (`moveObjectTo(bgIndex + 1)`), y no
  es seleccionable ni recibe eventos — es un telón de fondo, y que se tragara los clics
  destinados al texto sería insufrible. Lleva `_isScrim`/`_scrimKind` registrados en
  `fabric.Rect.customProperties`, por la misma razón que el marcador del fondo (§9.12): sin
  eso Fabric los descarta al guardar y al recargar el velo volvería como un rectángulo
  negro anónimo que nadie sabe identificar ni quitar.
- La opacidad vive **dentro del color** (`rgba(...)`, y en los tramos del degradado), no en
  `opacity` del objeto, para que haya un único sitio que controle la intensidad.
- Los sliders confirman en **`change`** (al soltar), no en `input`: cada paso de blur
  re-filtra el bitmap a tamaño completo y hacerlo en cada píxel de arrastre va a tirones.
- **`applyFilters()` lee píxeles**, así que solo funciona si el canvas no está
  *tainted* — se cumple porque todas las imágenes son del mismo origen (el proxy
  `/api/news/:id/image` existe precisamente para eso, §9.3, y las subidas se sirven desde
  nuestro propio origen). Verificado explícitamente: con blur y oscurecido aplicados, la
  exportación sigue funcionando y da 2160×2160.

**Bug encontrado y arreglado durante la verificación:** los filtros se perdían al recargar.
Mismo patrón que el encuadre en §9.12 — el refresco automático desde Twenty sustituye el
objeto de imagen y el nuevo venía sin filtros. `applyBackgroundToCanvas` ahora también
traslada `filters` al reemplazo cuando `preserveFraming` está activo (el refresco
automático), porque el ajuste de legibilidad es trabajo del operador y perderlo en silencio
en cada apertura es exactamente el fallo que ya se corrigió para la posición.

Verificado contra el **build de producción**: blur y oscurecido se aplican como filtros
sobre el fondo, el velo se inserta en el orden correcto (`bg → scrim → texto → logo`), la
exportación no se rompe (2160×2160), y tras guardar y recargar sobreviven los tres ajustes.
Sin errores de consola.

### 9.15 Contorno del texto

La otra mitad de la legibilidad (§9.14 cubre el lado de la foto): un contorno de color
contrastado mantiene el texto legible sobre una imagen recargada **sin apagar la foto
entera**. Control en el panel derecho, sección Text: selector de color + hex y un slider de
grosor (0 = apagado).

No hace falta nada a medida en el modelo de datos: `stroke`, `strokeWidth`, `paintFirst`,
`strokeLineJoin` y `strokeUniform` son propiedades estándar de Fabric y se serializan
solas. Lo que sí importa es **cómo** se aplican, y por eso hay un helper `applyOutline` en
`right-sidebar.tsx` en vez de un `updateSelectedObject({ stroke })` pelado:

- **`paintFirst: "stroke"`** — por defecto Fabric pinta el relleno y **luego** el trazo
  encima, así que la mitad del grosor del contorno se come el interior del glifo y las
  letras salen más finas y embarradas cuanto más grueso es el contorno. Pintando el trazo
  primero, el relleno tapa su mitad interior, que es lo que hace que un contorno se lea
  limpio.
- **`strokeLineJoin: "round"`** — con el `miter` por defecto salen picos largos en las
  esquinas afiladas de letras como A, V o W en cuanto el contorno engorda.
- **`strokeUniform: true`** — mantiene el grosor constante si se escala la caja de texto,
  en vez de estirarse con ella.

Dos detalles de UI que evitan estados confusos:

- Fabric arranca con `strokeWidth: 1` y `stroke: null`, así que el grosor por sí solo no
  dice si hay contorno: el panel comprueba **también el color**, o mostraría "1px" en un
  texto que no tiene ninguno.
- Elegir un color con el contorno apagado lo enciende con un grosor proporcional al cuerpo
  de la letra (`max(2, fontSize * 0.06)`), para que el selector de color haga algo visible
  en vez de nada. Bajar el grosor a 0 limpia también el color, para que "apagado" sea
  apagado de verdad y no un trazo de grosor cero acechando en el objeto.

Verificado contra el **build de producción**: el panel reporta "off" en texto sin contorno
(no el `1px` de Fabric); elegir negro lo activa a 3px sobre un cuerpo de 48 con
`paintFirst/lineJoin/strokeUniform` correctos; el slider ajusta el grosor; la exportación
sigue dando 2160×2160; sobrevive a guardar y recargar; y volver a 0 deja `stroke: null`.
Sin errores de consola.

### 9.16 `loadFromJSON` borra el recorte del lienzo (bug del Ctrl+Z)

Reporte del usuario: al hacer **Ctrl+Z** «se quita el lienzo y se queda la parte del fondo
que pusiste como añadido para trabajar». Es decir, tras deshacer, el diseño pasaba a
pintarse sobre **toda** el área de trabajo, margen incluido, y el borde de la página
desaparecía.

**Causa.** `Canvas.loadFromJSON` termina con `this.set(enlivenedMap)`, y ese mapa lleva
`clipPath` tomado directamente del JSON parseado. Nuestro `clipPath` es
`excludeFromExport: true` a propósito (§9.13 bug C: es una propiedad del visor, no del
diseño, y no debe ensuciar el `canvas_json` guardado), así que **nunca está en ese JSON** y
la asignación lo deja en `undefined`. Sin recorte, todo se pinta hasta los bordes del
elemento canvas, que es más grande que la página.

Deshacer restaura un snapshot precisamente con `loadFromJSON`, de ahí que el síntoma
saltara con Ctrl+Z. Pero **afectaba a tres rutas**, no solo a esa:

1. `restoreFromHistory` — undo/redo (lo que se reportó).
2. `loadTemplate` — aplicar una plantilla.
3. `page-canvas.tsx` — abrir un diseño **ya guardado**, porque ahí
   `applyWorkspaceGeometry` corre *antes* de `loadFromJSON`. O sea, el recorte también se
   perdía al abrir cualquier borrador con contenido; simplemente aún no se había notado.

**Arreglo.** El recorte se extrajo a `applyWorkspaceClip(canvas, w, h)` en
`lib/workspace.ts`, con la advertencia escrita en su docstring, y se re-aplica en las tres
rutas justo después de que `loadFromJSON` resuelva. `applyWorkspaceGeometry` ahora lo llama
también, así que no hay dos definiciones del rectángulo.

Verificado contra el **build de producción** con teclas reales: recién abierto, tras añadir
un objeto, tras **Ctrl+Z**, tras **Ctrl+Shift+Z** y tras guardar y recargar, el `clipPath`
sigue siendo 1080×1080 `absolutePositioned` y el `viewportTransform` intacto; el undo hace
su trabajo (4 → 3 objetos) y el redo lo devuelve. Captura confirmando que la página vuelve
a verse recortada y con su borde. Sin errores de consola.

### 9.17 Tema oscuro

Toda la interfaz pasa a oscuro. El editor pasaba el día con una foto a pantalla completa
en el centro rodeada de blanco, que es justo el contexto donde un chrome claro cansa y
falsea la percepción del color de la imagen.

**Jerarquía de tres superficies** (definida en `@theme`, `src/client/styles.css`), que es
lo que impide que un tema oscuro se lea como una plancha plana:

| token | valor | uso |
|---|---|---|
| `surface` | `#0b0b0d` | app y área de trabajo — lo más oscuro, para que el diseño sea lo más luminoso de la pantalla y el ojo vaya ahí |
| `surface-secondary` | `#18181b` | paneles: sidebars, toolbar, barra de páginas |
| `surface-card` | `#27272a` | inputs, tarjetas y desplegables que van **encima** de un panel |

Ese tercer nivel es imprescindible: en el tema claro el panel y sus controles eran ambos
blancos y solo los separaba un borde; en oscuro eso desaparece, así que los controles se
suben un escalón (`bg-zinc-800` sobre paneles `bg-zinc-900`).

Detalles que no son un simple "invertir colores":

- **`color-scheme: dark`** en `body`, más un `<meta name="color-scheme">` y un
  `background` inline en `index.html`. Lo primero hace que el navegador pinte widgets
  nativos (controles de formulario, scrollbars, el popup del selector de color) en su
  variante oscura; lo segundo evita el destello blanco del primer frame, antes de que la
  hoja de estilos se aplique.
- **La sombra de la página** se rehizo: una sombra oscura no se ve sobre un fondo oscuro,
  así que la página se separa del área de trabajo con un borde de luz tenue
  (`rgba(255,255,255,0.10)`) y una sombra más profunda.
- **El chevron del `<select>`** es un SVG embebido en la CSS con el color en la URL; había
  que aclararlo a mano o desaparecía.
- **Superficies de error** (`bg-red-50/border-red-200/text-red-700`) pasan a tintado
  oscuro (`bg-red-950/border-red-900/text-red-300`) en vez de un lavado claro.

**Lo que a propósito NO se oscurece**, porque es contenido del diseño y no chrome:

- La **tarjeta de la página** en `page-canvas.tsx` (`bg-white`): representa la superficie
  del lienzo y debe reflejar el `backgroundColor` del diseño, no el tema de la app.
- Las **muestras de color y los degradados** del panel Bg: son opciones que el operador
  aplica a la obra; tienen que enseñar su color real.

La conversión (253 clases) se hizo con un mapeo en una sola pasada — importante para que
un valor no se reescriba dos veces (p. ej. `600 → 300` y luego ese `300 → 200`) — y se
verificó recorriendo el DOM ya renderizado en busca de superficies claras: los únicos
resultados son los dos casos intencionados de arriba. Capturas del editor y de la galería
revisadas, sin errores de consola.

## 10. Fase 3 — Seguridad y hardening (completa, nivel app)

Cubre el checklist de `PLAN.md` §5/§6 que depende solo del código de la app (no del
despliegue — eso es Fase 4: Traefik, VPN/allowlist de IP, contenedor no-root, red de
Dokploy). Todo lo de abajo está en [`src/server/index.ts`](src/server/index.ts) y
[`src/server/auth.ts`](src/server/auth.ts) (nuevo), verificado con `curl` contra el
servidor real (no solo lectura de código).

### 10.1 Auth en toda la app (no solo `/api/*`)

`src/server/auth.ts` expone `editorAuth()`: envuelve `basicAuth` de Hono
(`hono/basic-auth`) con credenciales de `EDITOR_USER`/`EDITOR_PASSWORD` (env). **El
servidor lanza un error al arrancar si faltan** — no hay modo "sin auth" accidental.

En `index.ts`, montado como middleware sobre `*` (toda ruta, no solo `/api/*` —
ampliado durante la Fase 4 tras probar en el panel real de Dokploy que configurar un
middleware de Basic Auth propio en Traefik era frágil/dependiente de la versión exacta
del panel; ver §11.4 y el razonamiento ahí):

```ts
const requireAuth = editorAuth();
app.use("*", async (c, next) => {
  if (c.req.method === "GET" && c.req.path.startsWith("/api/uploads/")) return next();
  if (c.req.method === "GET" && c.req.path === "/api/health") return next();
  return requireAuth(c, next);
});
```

**Dos excepciones, obligatorias:**
- `GET /api/uploads/:filename` — es la URL que Twenty necesita leer sin credenciales
  para "Imagen Editada" (requisito del §9.2, no negociable).
- `GET /api/health` — lo consulta el `HEALTHCHECK` de Docker/Dokploy, no un operador (ver
  §11.4: confirmado con `docker inspect` que sigue en estado `healthy` con toda la app
  detrás de auth, porque ese healthcheck pega directo al contenedor, no pasa por Traefik).

Nada más queda abierto: ni el HTML/JS/CSS de la SPA compilada (`dist/`, servida por
`serveStatic` en `serve.ts`), ni `GET /api/designs`, ni `/api/news/:id`, ni
`/api/news/:id/image` (la imagen de origen — el navegador del operador ya tiene las
credenciales cacheadas de la primera llamada, así que la carga en canvas funciona sola),
ni `publish-image`.

**Por qué Basic Auth y no una sesión propia:** un solo operador, sin roles, sin
necesidad de logout — Basic Auth resuelve esto con cero código de sesión/cookies.
`EDITOR_PASSWORD` no es una contraseña memorizable: es un secreto aleatorio largo (24
caracteres, generado con `crypto.randomBytes`), funciona en la práctica como una API key
entregada vía el prompt nativo de Basic Auth del navegador — sin necesidad de inventar un
esquema de header/query-param propio, que además sería más frágil (una API key en la URL
queda en logs de acceso y en el historial del navegador; Basic Auth no expone
credenciales en la URL). El navegador cachea las credenciales **por origen** tras el
primer 401 y las reenvía sola en todas las requests siguientes al mismo origen (`fetch`,
`<img src>`, lo que sea) — no hace falta ningún tratamiento especial para que el canvas
cargue imágenes vía `<img>` después del primer login. Verificado con `curl` (contra el
proceso local y contra el contenedor Docker real, ver §11.1): sin credenciales → `401` en
cualquier ruta (incluida la raíz `/` y los assets `/assets/*.js`); con
`-u admin:<pass>` → `200`; con credenciales incorrectas → `401`; `GET
/api/uploads/<inexistente>` y `GET /api/health` sin credenciales → responden igual que
con auth (no `401`, confirma que quedaron públicas). En dev, el proxy de Vite
(`vite.config.ts`, `/api → :8787`) reenvía cabeceras y status transparentemente — pero
ojo: en dev el HTML/JS de la SPA lo sirve **Vite** en `:5173` directamente (sin pasar por
este middleware, que vive en el backend `:8787`), así que la protección de "toda la app"
solo es real en producción (`pnpm run build && pnpm run start`, o el contenedor Docker).
En dev, la SPA en sí no está protegida — solo lo está una vez desplegada.

Credenciales en `.env` (`EDITOR_USER=admin`, `EDITOR_PASSWORD=<generada
aleatoriamente>`) — **cámbialas** por unas propias cuando quieras, solo hace falta
reiniciar el server. `.env.example` documenta ambas variables sin valores reales.

### 10.2 Saneado de subidas

`POST /api/uploads` y `POST /api/news/:id/publish-image` (`src/server/index.ts`):

- **SVG fuera de la whitelist** — ya no se acepta (`allowed = new Set(["png", "jpg",
  "jpeg", "gif", "webp"])`, sin `"svg"`). Era el vector de XSS más probable señalado en
  `PLAN.md` §7; no hacía falta como formato de entrada porque todo lo que llega al canvas
  se rasteriza al exportar. Verificado: subir un `.svg` con Basic Auth válido →
  `400 Unsupported file type`.
- **Límite de tamaño**: `MAX_UPLOAD_BYTES = 15 MB` en ambos endpoints → `413` si se
  excede.
- **Cabeceras al servir** (`GET /api/uploads/:filename`): `Content-Disposition: inline;
  filename="..."` (nombre saneado, sin comillas/backslashes) + `X-Content-Type-Options:
  nosniff`, para que el navegador nunca intente reinterpretar el contenido como otro tipo
  MIME. Verificado con `curl -D -`.
- `uploads.ts` no cambió — su `sanitize()` (whitelist de caracteres en el nombre al leer)
  ya era razonable; el nombre al escribir sigue siendo generado por el servidor
  (timestamp + random), nunca el `filename` que manda el cliente.

### 10.3 Cabeceras de seguridad / CSP

Middleware global (`app.use("*", ...)` en `index.ts`, antes de todo lo demás) que añade a
**toda** respuesta (incluida la SPA servida por `serveStatic` en producción):

```
Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:;
  style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:;
  font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
```

Notas de diseño:
- `style-src 'unsafe-inline'` hace falta porque Fabric.js manipula `style` inline del
  contenedor del canvas; sin esto se rompería el editor. `script-src` se queda estricto
  (`'self'`, sin `unsafe-inline`/`eval`) porque el build de producción de Vite no necesita
  ninguno de los dos.
- `frame-ancestors 'none'`: hoy el punto de entrada es pestaña nueva (`?recordId=`, ver
  §9.7), no iframe embebido en Twenty. Si en algún momento se decide embeber por iframe
  (`PLAN.md` §8 decisión #2), esta cabecera hay que cambiarla al origen exacto de Twenty
  — dejarla en `'none'` bloquearía el iframe.
- En dev, esta cabecera solo viaja en las respuestas JSON del backend (`:8787`); el HTML
  que el navegador realmente renderiza en dev lo sirve Vite en `:5173` directamente, sin
  pasar por este middleware. La cabecera cobra efecto real sobre el documento cuando se
  compila y se sirve con `pnpm run build && pnpm run start` (Hono sirviendo `dist/`).
  **⚠️ Consecuencia práctica, aprendida por las malas (§9.11): en dev NO se prueba la
  CSP.** Un `fetch()` sobre un `data:` URL (bloqueado por `connect-src`) pasó
  desapercibido en varias rondas de verificación con Playwright contra `:5173` y solo
  apareció ya desplegado, como un `Failed to fetch` sin traza en los logs del servidor.
  Cualquier cambio que pueda depender de la CSP — `fetch`, workers, blobs, estilos o
  scripts inline — hay que verificarlo contra `pnpm run build && pnpm run start` en
  `:8787`.

### 10.4 Qué queda fuera de Fase 3 (a propósito)

Todo lo que depende del **despliegue**, no del código de la app, queda para la Fase 4 tal
como lo separa `PLAN.md` §5:
- Traefik de Dokploy con middleware de auth/allowlist de IP, o VPN/red interna en vez de
  dominio público.
- Contenedor no-root, sin acceso a los volúmenes/DB de Twenty.
- `X-Forwarded-Proto/Host` (trust proxy) detrás de Traefik.
- `pnpm audit`/Renovate (`PLAN.md` §6) — sigue pendiente, sin cambios desde §6 de este
  documento (el ruido sigue viniendo de `fabric` → `jsdom`, no explotable en runtime tal
  como se despliega).

## 11. Fase 4 — Despliegue en el VPS con Dokploy

Decisiones del usuario para esta fase: acceso por **dominio público** (Twenty corre en
**el mismo VPS/Dokploy** que el editor, así que las llamadas editor→Twenty pueden
optimizarse a red interna de Docker más adelante, ver §11.5). El plan inicial era sumar
un segundo Basic Auth en Traefik sobre el de la app; se descartó por frágil de configurar
en este panel concreto y se resolvió ampliando el Basic Auth de la app a toda la web, no
solo `/api/*` — ver §10.1 y §11.4 para el razonamiento completo.

### 11.1 Imagen (`Dockerfile`, nuevo)

Build multi-stage, verificado localmente con `docker build` + `docker run` (no solo
lectura del Dockerfile):

- **Etapa `build`**: `node:24-slim`, `pnpm install --frozen-lockfile` (con
  devDependencies, hace falta `vite` para el build) + `pnpm run build` → `dist/`. El
  cliente no necesita ninguna variable de entorno en build time (todo lo que llama a la
  API usa rutas relativas `/api/...`, nunca `import.meta.env.VITE_*` — confirmado por
  grep, cero resultados).
- **Etapa `runtime`**: `node:24-slim` de nuevo (imagen limpia, sin herramientas de
  build), `pnpm install --prod --frozen-lockfile` (solo `dependencies`, sin `vite`/
  `typescript`), copia `dist/` y `src/server/` (el backend sigue corriendo con `tsx`
  directamente sobre `.ts`, igual que en dev — no hay paso de compilación propio para el
  servidor, ver `CLAUDE.md` §2). Usuario no-root `editor` (`groupadd`/`useradd
  --system`), sin acceso a nada fuera de `/app` y `/data`. `HEALTHCHECK` nativo de Docker
  contra `GET /api/health`.
- **`node:sqlite`** no necesita compilación nativa (ver §1), así que ninguna etapa
  necesita `python3`/`make`/`g++` — la imagen se queda pequeña y sin toolchain de build
  en el runtime.
- **`tsx` se movió de `devDependencies` a `dependencies`** en `package.json` (con su
  `pnpm-lock.yaml` actualizado): es una dependencia de **ejecución** real (`pnpm run
  start` la necesita en producción), estaba mal clasificada.
- **Gotcha encontrado y arreglado**: la primera build falló en la etapa `runtime` con
  `[ERR_PNPM_IGNORED_BUILDS] canvas@2.11.2, esbuild@0.25.12, esbuild@0.27.7` — la etapa
  runtime copiaba `package.json`+`pnpm-lock.yaml` pero **no** `pnpm-workspace.yaml`
  (donde vive `allowBuilds`, ver §2), así que pnpm no sabía qué scripts de build tenía
  aprobados el usuario. Arreglado copiando también `pnpm-workspace.yaml` en esa etapa.

### 11.2 Volúmenes: un único mount en `/data`

`src/server/db.ts` ya soportaba `DB_PATH` por env (heredado de antes); se añadió el
mismo patrón a `src/server/uploads.ts` (`UPLOADS_DIR` por env, antes hardcodeado a una
ruta relativa al código fuente). El `Dockerfile` fija por defecto:

```
DB_PATH=/data/data.db
UPLOADS_DIR=/data/uploads
```

**En Dokploy: monta un único volumen en `/data`** (persiste `data.db` +
`data.db-wal`/`-shm` + `uploads/` juntos). Sin este volumen, cada redeploy borra todos
los diseños guardados y las imágenes subidas — es el paso más fácil de olvidar y el más
caro de olvidar.

### 11.3 Variables de entorno a definir en el editor de Environment de Dokploy

**No crear un `.env` a mano en el servidor** — Dokploy inyecta estas variables
directamente en el proceso del contenedor (confirmado: el `CMD` del Dockerfile usa
`tsx --env-file-if-exists=.env`, que tolera la ausencia del fichero — verificado en el
`docker run` de prueba, log: `.env not found. Continuing without it.`, y el servidor
arrancó igualmente leyendo las env vars del propio proceso).

| Variable | Valor |
|---|---|
| `TWENTY_API_URL` | `https://crm.elfarodealicante.com` (o el nombre de servicio interno si se aplica §11.5) |
| `TWENTY_TOKEN` | el token real (nunca en el cliente, ya se cumple) |
| `PUBLIC_BASE_URL` | `https://<dominio-real-del-editor>` (Fase 4 — hoy en local es `http://localhost:8787`) |
| `EDITOR_USER` / `EDITOR_PASSWORD` | credenciales del Basic Auth de la app (Fase 3/4) — protege **toda** la app, no solo `/api/*` (ver §10.1/§11.4); `EDITOR_PASSWORD` debe ser un secreto largo generado, no una contraseña memorizable |

`DB_PATH`, `UPLOADS_DIR` y `PORT` **no hace falta definirlas** — el `Dockerfile` ya las
fija a los valores correctos (`/data/...`, `8787`); solo tocarlas si se cambia el layout
de volúmenes.

### 11.4 Dominio y Traefik

- Asignar dominio en Dokploy → Traefik gestiona TLS con Let's Encrypt automáticamente,
  sin certificados a mano.
- **Middleware de Basic Auth en Traefik: decidido que NO hace falta, ampliamos el auth de
  la app en su lugar.** El plan original (decisión inicial del usuario) era añadir un
  segundo Basic Auth en el middleware de dominio de Traefik, además del de la app
  (Fase 3). En la práctica, el panel de Dokploy de este despliegue solo permite
  referenciar middlewares ya definidos en un fichero de config dinámica de Traefik
  (`Domains → Middlewares` acepta texto tipo `nombre@file`, no un formulario con
  usuario/contraseña) — hay que editar esa config en una sección aparte del dashboard
  (a nivel de servidor, no de esta Application), generar el hash `apr1` a mano, etc. Se
  consideró demasiado fràgil/dependiente de la versión exacta del panel para ser un
  requisito de seguridad real. **Solución adoptada:** el middleware de auth de la app
  (§10.1) se amplió de `/api/*` a `*` — protege también el HTML/JS de la SPA, no solo la
  API. Con `EDITOR_PASSWORD` como secreto aleatorio largo (no una contraseña
  memorizable), este único middleware ya cubre el requisito de "nada accesible sin
  credencial" de `PLAN.md` §6 sin depender de nada de Traefik. **El campo `Middlewares`
  del dominio en Dokploy se puede dejar vacío.** Si más adelante se quiere esa segunda
  capa igualmente (defensa en profundidad extra), sigue siendo válida — solo que ya no es
  necesaria para estar seguro.
- **Health check en Dokploy**: configurar `GET /api/health` como ruta de health check,
  puerto `8787` — responde `200 {"ok":true}` sin auth de app. **No hace falta excluirla
  de nada en Traefik**: verificado con `docker inspect` sobre el contenedor real (toda la
  app ya detrás de auth) que el `HEALTHCHECK` de Docker sigue en estado `healthy` — pega
  directo al contenedor por su IP/puerto interno, no pasa por el dominio público ni por
  Traefik, así que un eventual Basic Auth a nivel de dominio no lo afectaría de todas
  formas.
- **Límite de memoria**: fijar un límite modesto en los recursos de la Application en
  Dokploy (p. ej. 512 MB) — es una app ligera (sin render en servidor, sin `jsdom`/
  `canvas` en el bundle de runtime), y el VPS ya tiene Twenty + n8n usando memoria.
- **Backup del volumen** `/data`: opcional (`PLAN.md` §5) — los borradores son de bajo
  valor, pero es gratis activarlo si Dokploy lo soporta para ese volumen.

### 11.5 Red interna hacia Twenty (mismo VPS — optimización, no bloqueante)

Como Twenty corre en el mismo Dokploy, las llamadas `editor → Twenty` (en
`src/server/twenty.ts`, hoy contra `https://crm.elfarodealicante.com`) **pueden**
enrutarse por la red interna de Docker en vez de salir a Internet y volver a entrar —
evita que el token de Twenty viaje por fuera del host. Para activarlo:

1. Confirmar en Dokploy el **nombre de servicio interno** del contenedor de Twenty
   (Dokploy → la Application de Twenty → detalles del servicio; suele ser algo con el
   patrón `<nombre-app>-<hash>` en `dokploy-network`) y su puerto interno.
2. Si el editor y Twenty están en la **misma red compartida** (`dokploy-network` — el
   caso normal salvo que se use Isolated Deployments), cambiar `TWENTY_API_URL` a
   `http://<nombre-de-servicio-interno>:<puerto>` en vez del dominio público.
3. Si se usa **Isolated Deployments** (cada Application en su propia red por defecto),
   hay que compartir red a propósito entre el editor y Twenty desde la configuración de
   red de Dokploy — si no, el nombre de servicio interno no resuelve y esto no
   funcionará (`PLAN.md` §5/§7 ya avisaba de esto).

No es bloqueante para el primer despliegue: `TWENTY_API_URL=https://crm.elfarodealicante.com`
tal cual (como ya funciona hoy en local) sigue siendo válido — es solo más tráfico
saliendo/entrando del host del que hace falta. Aplicar este cambio cuando se tenga
acceso real al panel de Dokploy para confirmar el nombre de servicio exacto — no se
puede adivinar desde aquí.

### 11.6 Qué no se implementó (a propósito) y por qué

- **`X-Forwarded-Proto`/`X-Forwarded-Host` ("trust proxy")**: `PLAN.md` §7 avisaba de
  esto para cuando hay un proxy (Traefik) delante, pero se revisó el código
  (`src/server/index.ts`, `serve.ts`) y **ninguna ruta construye URLs a partir de
  cabeceras de la request** — la única URL pública que se construye
  (`publish-image` → `imagenEditada`) usa siempre `PUBLIC_BASE_URL` explícito por env
  (§9.6), nunca `Host`/`X-Forwarded-*`. No hay nada que "confiar" porque no se lee esa
  cabecera en ningún sitio; se deja anotado por si en el futuro se añade código que sí
  la necesite.
- **Contenedor sin acceso a los volúmenes/DB de Twenty**: no requiere código — el
  contenedor del editor simplemente no monta ningún volumen de Twenty (`docker run`/
  Dokploy solo le da el volumen `/data` propio, ver §11.2). Nada que hacer más allá de
  no montarlo por error.
- **`docker-compose.yml`**: no se añadió — `PLAN.md` §4/§9 pide desplegar como
  **Application** (build por Dockerfile) en Dokploy, no como stack de Compose.
