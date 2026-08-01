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
└── logo.jpg                       — logo de marca (faro blanco sobre negro, 1024x1024)

Dockerfile, .dockerignore   — build multi-stage para Dokploy (ver §11)
```

## 4. Editor a medida (Fase 1 — completada)

| Tarea del plan | Estado / dónde vive |
|---|---|
| Presets de tamaño IG (1080×1080, 1080×1350, 1080×1920) | Hecho — [`src/client/context.tsx`](src/client/context.tsx) `CANVAS_SIZES`. Las 4 medidas LinkedIn se quitaron. |
| Logo fijo arriba-derecha | Hecho — [`src/client/lib/logo.ts`](src/client/lib/logo.ts) (`applyLogoToCanvas`/`withoutLogo`/`isLogoObject`). Capa `fabric.FabricImage` bloqueada (`selectable:false, evented:false, lockMovementX/Y:true`), marcada con `_isLogo`, recolocada en `setCanvasSize`/`loadTemplate`/undo-redo, **excluida** de todo lo que se persiste (save, historial) vía `withoutLogo`, e **incluida** en el export porque `exportPNG` lee el canvas en vivo. Usa el logo real de marca (`public/logo.jpg`, faro blanco sobre negro) — para cambiarlo, solo sustituir el archivo/`LOGO_URL` en `logo.ts`, no hay que tocar lógica. |
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

**Logo de marca:** ya integrado — `public/logo.jpg` (faro blanco sobre negro, 1024x1024,
provisto por el usuario desde `img_custom/logow.jpg`, ahora en `.gitignore` porque tiene
otros archivos personales sueltos, no solo el logo).

**Fase 3 completa** (seguridad/hardening a nivel app, ver §10).

**Fase 4 completa por el lado del repo** (`Dockerfile` + `.dockerignore`, ver §11) —
build y arranque verificados localmente con `docker build`/`docker run` (auth, health
check, usuario no-root, persistencia en `/data`, todo probado, no solo leído). Falta la
parte que solo se puede hacer con acceso real al panel de Dokploy: crear la Application,
pegar las env vars, montar el volumen, poner el dominio + middleware de Traefik — nada de
eso es código de este repo, son pasos manuales del usuario en su infraestructura.

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
  `openFromNewsRecord` (→ `POST /api/designs/from-news/:id`) y navega a `/design/:id`. La
  primera vez que se abre (página en blanco, `canvas_json === "{}"`), precarga la imagen
  de origen como fondo (`cover`) y el título como heading — **solo la primera vez**; si el
  operador ya guardó algo, no se vuelve a tocar en aperturas siguientes.
- Botón **"Guardar en Twenty"** en el toolbar (visible solo si el diseño tiene
  `twenty_record_id`): exporta el PNG (`exportPNGBlob`, nueva variante de `exportPNG` que
  devuelve un `Blob` en vez de forzar la descarga) y lo sube vía `publish-image`.

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

`<DOMINIO-DEL-EDITOR>` depende del despliegue de la Fase 4 (todavía no decidido — VPN vs.
basic auth vs. SSO, dominio propio o interno). **Para probarlo ya, en local:**
`http://localhost:5173/edit?recordId=<id>` (con `pnpm run dev` corriendo) — funciona igual
que en producción salvo que el campo `imagenEditada` no será accesible desde fuera de esta
máquina hasta que exista el dominio real. Rellenar el campo Link con el `id` de cada
registro es manual por ahora (bajo volumen, per lo que dijo el usuario sobre el campo de
estado); automatizarlo con un Workflow de Twenty (fórmula `CONCAT` sobre `record.id`) es
un afinado de Fase 5, no bloqueante.

## 10. Fase 3 — Seguridad y hardening (completa, nivel app)

Cubre el checklist de `PLAN.md` §5/§6 que depende solo del código de la app (no del
despliegue — eso es Fase 4: Traefik, VPN/allowlist de IP, contenedor no-root, red de
Dokploy). Todo lo de abajo está en [`src/server/index.ts`](src/server/index.ts) y
[`src/server/auth.ts`](src/server/auth.ts) (nuevo), verificado con `curl` contra el
servidor real (no solo lectura de código).

### 10.1 Auth en `/api/*`

`src/server/auth.ts` expone `editorAuth()`: envuelve `basicAuth` de Hono
(`hono/basic-auth`) con credenciales de `EDITOR_USER`/`EDITOR_PASSWORD` (env). **El
servidor lanza un error al arrancar si faltan** — no hay modo "sin auth" accidental.

En `index.ts`, montado como middleware sobre `/api/*` **antes** de las rutas:

```ts
const requireAuth = editorAuth();
app.use("/api/*", async (c, next) => {
  if (c.req.method === "GET" && c.req.path.startsWith("/api/uploads/")) return next();
  return requireAuth(c, next);
});
```

**Única excepción, obligatoria:** `GET /api/uploads/:filename` queda público — es la URL
que Twenty necesita leer sin credenciales para "Imagen Editada" (requisito del §9.2, no
negociable). Nada más de `/api/*` queda abierto: ni `GET /api/designs`, ni
`/api/news/:id`, ni `/api/news/:id/image` (la imagen de origen — el navegador del
operador ya tiene las credenciales cacheadas de la primera llamada, así que la carga en
canvas funciona sola), ni `publish-image`.

**Por qué Basic Auth y no una sesión propia:** un solo operador, sin roles, sin
necesidad de logout — Basic Auth resuelve esto con cero código de sesión/cookies. El
navegador cachea las credenciales **por origen** tras el primer 401 y las reenvía solo en
todas las requests siguientes al mismo origen (`fetch`, `<img src>`, lo que sea) — no
hace falta ningún tratamiento especial para que el canvas cargue imágenes vía `<img>`
después del primer login. Verificado con `curl`: sin credenciales → `401`; con
`-u admin:<pass>` → `200`; con credenciales incorrectas → `401`; `GET
/api/uploads/<inexistente>` sin credenciales → `404` (no `401`, confirma que quedó
público). En dev, el proxy de Vite (`vite.config.ts`, `/api → :8787`) reenvía cabeceras y
status transparentemente, así que el flujo de auth funciona igual en `:5173` que en
producción.

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

Decisiones del usuario para esta fase: acceso por **dominio público + Basic Auth en
Traefik** (sobre el Basic Auth de app de la Fase 3 — dos capas independientes), y Twenty
corre en **el mismo VPS/Dokploy** que el editor (así que las llamadas editor→Twenty
pueden optimizarse a red interna de Docker más adelante, ver §11.5).

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
| `EDITOR_USER` / `EDITOR_PASSWORD` | credenciales del Basic Auth de la app (Fase 3) — pueden (y conviene que) sean **distintas** de las del Basic Auth de Traefik (§11.4), dos capas independientes |

`DB_PATH`, `UPLOADS_DIR` y `PORT` **no hace falta definirlas** — el `Dockerfile` ya las
fija a los valores correctos (`/data/...`, `8787`); solo tocarlas si se cambia el layout
de volúmenes.

### 11.4 Dominio y Traefik (decisión del usuario: dominio público + Basic Auth)

- Asignar dominio en Dokploy → Traefik gestiona TLS con Let's Encrypt automáticamente,
  sin certificados a mano.
- Añadir el middleware de **Basic Auth de Traefik** al dominio (panel de Dokploy →
  Domains → Middlewares, o el equivalente en la versión que tengas) con credenciales
  **propias**, distintas de `EDITOR_USER`/`EDITOR_PASSWORD`. Con esto el operador
  necesita pasar dos prompts de Basic Auth (Traefik primero, la app después) — molesto
  una vez por sesión de navegador, pero es defensa en profundidad real: si algún día se
  quita o se rompe el auth de la app por error, Traefik sigue bloqueando el acceso.
- **Health check en Dokploy**: configurar `GET /api/health` como ruta de health check —
  responde `200 {"ok":true}` **sin auth** (excluida a propósito del middleware de la
  app, ver `src/server/index.ts`; si además pasa por Traefik con Basic Auth delante, hay
  que excluir esta ruta también del middleware de Traefik o el health check del propio
  Dokploy empezará a fallar con 401).
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
