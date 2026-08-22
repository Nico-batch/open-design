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
    ├── fonts.css               — @font-face autoalojado (38 caras, subset latin) + emoji
    ├── context.tsx             — EditorContext + CANVAS_SIZES (presets IG)
    ├── types.ts, api.ts        — tipos y fetch al backend
    ├── lib/
    │   ├── logo.ts             — capa de logo fijo: applyLogoToCanvas/withoutLogo/isLogoObject
    │   ├── background.ts       — capa de fondo: findBackgroundImage/makeBackgroundInteractive (§9.12)
    │   ├── fonts.ts            — carga y re-medición de webfonts en canvas (§9.13 bug B)
    │   ├── workspace.ts        — margen de trabajo + recorte de exportación (§9.13 bug C)
    │   ├── effects.ts          — legibilidad del texto sobre foto: blur/oscurecido/velo (§9.14)
    │   ├── text-styles.ts      — formato por rango de caracteres dentro de un texto (§9.21)
    │   ├── text-effects.ts     — sombra, resplandor, hueco y fondo del texto (§9.24)
    │   ├── enhance.ts          — receta "Mejorar": acabado de noticia local (§9.25)
    │   ├── snapping.ts         — imán de arrastre a las guías de centro, escape con Ctrl (§9.23)
    │   ├── event-fields.ts     — campos de un evento → texto publicable, fechas (§9.26)
    │   ├── event-template.ts   — plantilla de eventos: bloques, modos, temas (§9.26/§9.27)
    │   ├── news-fields.ts      — secciones de una noticia y la cuenta del pie (§9.28)
    │   ├── news-template.ts    — plantilla opcional de noticias: una foto a página completa,
    │   │                         nítida arriba y difuminada abajo, chip, titular y pie sobre
    │   │                         la parte difuminada (§9.28/§9.29/§9.30)
    │   └── palette.ts          — colores de marca + muestras de los selectores (§9.29)
    │   (workspace.ts aloja además el contenedor del textarea oculto de Fabric, §9.22)
    ├── hooks/
    │   ├── use-canvas.ts       — toda la lógica de Fabric.js: texto, formas, imágenes,
    │   │                         fondo (cover/contain), undo/redo, resize, zoom, negrita
    │   │                         por selección, exportPNG, serialización (sin el logo)
    │   ├── use-designs.ts      — CRUD de diseños/páginas contra la API
    │   └── use-router.ts       — router mínimo, parsea `/design/:id`
    └── components/
        ├── editor.tsx, canvas-area.tsx, page-canvas.tsx, pages-bar.tsx
        ├── guides-overlay.tsx      — guías de centro imantadas, capa DOM fuera de Fabric (§9.23)
        ├── event-panel.tsx         — sección "Evento" del sidebar izquierdo (§9.26)
        ├── news-panel.tsx          — sección "Noticia" del sidebar izquierdo (§9.28/§9.30)
        ├── color-field.tsx         — selector de color con muestras de marca (§9.29)
        ├── left-sidebar.tsx, right-sidebar.tsx, toolbar.tsx
        ├── home.tsx, design-list.tsx, template-card.tsx

public/
├── fonts/<Familia>/<peso>.woff2   — fuentes autoalojadas (servidas por Vite/estático)
└── logo.png                       — logo de marca (faro blanco, fondo transparente, 500x500;
                                      su colocación depende de la plantilla, ver §9.28)

Dockerfile, .dockerignore   — build multi-stage para Dokploy (ver §11)
```

## 4. Editor a medida (Fase 1 — completada)

| Tarea del plan | Estado / dónde vive |
|---|---|
| Presets de tamaño IG (1080×1080, 1080×1350, 1080×1920) | Hecho — [`src/client/context.tsx`](src/client/context.tsx) `CANVAS_SIZES`. Las 4 medidas LinkedIn se quitaron. |
| Logo fijo arriba-derecha | Hecho — [`src/client/lib/logo.ts`](src/client/lib/logo.ts) (`applyLogoToCanvas`/`withoutLogo`/`isLogoObject`). Capa `fabric.FabricImage` bloqueada (`selectable:false, evented:false, lockMovementX/Y:true`), marcada con `_isLogo`, recolocada en `setCanvasSize`/`loadTemplate`/undo-redo, **excluida** de todo lo que se persiste (save, historial) vía `withoutLogo`, e **incluida** en el export porque `exportPNG` lee el canvas en vivo. Usa el logo real de marca (`public/logo.png`, faro blanco, fondo transparente) — para cambiarlo, solo sustituir el archivo/`LOGO_URL` en `logo.ts`, no hay que tocar lógica; el archivo debe tener canal alfa real (RGBA), un JPG opaco se ve como un cuadro sólido encima del fondo. |
| Negrita en selección (estilos por carácter) | Hecho, y **generalizado en §9.21** a color, tamaño, tipografía, cursiva, subrayado y contorno. `toggleBold` conserva su comportamiento (aplica al rango seleccionado si el `Textbox` está en edición, al cuadro entero si no) pero ahora escribe a través de `applyTextStyle`, que es el único punto por el que pasa el formato de texto. |
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

### 9.1 Objetos y campos reales en Twenty (verificado por introspección GraphQL en vivo)

> El editor sirve a **dos** objetos del CRM, no solo a `News` — ver §9.19 para `Events`.
> Esta sección describe `News`, que fue el primero y sigue siendo el caso por defecto.

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
  El título por defecto **sigue aplicándose solo la primera vez** (página en
  blanco, `canvas_json === "{}"`) — solo la imagen se refresca siempre; si el operador ya
  escribió texto, no se toca. (Desde §9.28 ese "título por defecto" de una noticia ya no
  es un cuadro de texto suelto sino la plantilla entera; la condición de cuándo se aplica
  no ha cambiado.) Solo se aplica en la página principal (`pages[0]`) del
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

Campo tipo **Link** en la ficha del registro, apuntando a:

```
https://<DOMINIO-DEL-EDITOR>/edit?recordId={{id del registro}}&objectType=news    ← News
https://<DOMINIO-DEL-EDITOR>/edit?recordId={{id del registro}}&objectType=event   ← Events
```

`objectType` es opcional y por defecto vale `news`, así que los enlaces que ya existían en
las fichas de noticias (sin ese parámetro) siguen funcionando tal cual — ver §9.19.

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

### 9.18 El blur borraba parte de la foto: el límite de textura de Fabric

Reporte del usuario, con captura: al aplicar blur, la franja derecha de la imagen
desaparecía y quedaba un bloque plano. No era un problema de encuadre — la foto llegaba
recortada al lienzo.

**Causa.** Fabric renderiza los filtros en un lienzo WebGL de **`config.textureSize`
(4096 px) por lado**, creado una sola vez, y fija el viewport al tamaño del bitmap de
origen. El driver recorta ese viewport al tamaño real del buffer, así que **todo lo que
pase de 4096 px vuelve completamente transparente**, en silencio y sin ningún error. Una
foto de cámara de 5184×3456 (18 MP, lo normal en lo que llega desde Twenty) pierde así el
21% derecho en cuanto se enciende el blur o el oscurecido — que es exactamente la
proporción de la captura del usuario.

Medido directamente sobre el bitmap filtrado, con imágenes sintéticas de varios tamaños:

| origen | primera columna vacía | cubierto |
|---|---|---|
| 3000×2000 | — | 100% |
| 4500×3000 | 4096 | 91% |
| 5184×3456 | 4096 | 79% |
| 2000×4600 | fila 4096 | recorta por abajo |

**Arreglo: reducir el bitmap de origen a 4096 px de lado**
(`downscaleOversizedSource` en [`lib/background.ts`](src/client/lib/background.ts)). Se
descartó subir `textureSize` (el lienzo WebGL es `textureSize²`: pasarlo a 8192 son 268 MB
de VRAM, y aun así no garantiza nada — el máximo depende de la GPU) y también desactivar
`enableGLFiltering` (el blur en 2D son ~30 muestras por píxel y dos pasadas en JS: sobre 18
MP es inusable). Reducir es además lo correcto por sí solo: la página mide como mucho
1920 px y se exporta a 2×, así que un bitmap de 5000 px ya se estaba submuestreando al
pintar — solo costaba memoria y tiempo de filtrado. El tope se deriva de
`fabric.config.textureSize` en lugar de escribirse a mano, para que los dos no se separen.

Tres detalles que costaron una vuelta cada uno:

- **La escala se convierte, no se resetea.** Cambiar el bitmap encogería el objeto en la
  página, así que se multiplica `scaleX/scaleY` por lo que perdió el bitmap. La
  compensación se mide sobre **`img.width` (el objeto), no sobre el elemento**: un diseño
  restaurado desde JSON vuelve con el `width` *serializado* (ya reducido, si se guardó tras
  este cambio) pero con el elemento a resolución completa, así que medir el elemento
  duplicaba la cuenta y agrandaba el fondo un 26% en cada recarga.
- **Se reduce `_originalElement`, no `getElement()`.** Este último devuelve el bitmap *ya
  filtrado* cuando hay efectos activos — que al recargar es precisamente el truncado.
  Reducir ese dejaba la franja que falta grabada para siempre en vez de curarla (se veía
  como un hueco que además se movía al cambiar la intensidad del blur, porque el
  desenfoque arrastraba el borde).
- **`getSrc()` se sobrescribe en el prototipo.** Fabric serializa una imagen llamando a
  `getSrc()`, que **incrusta el bitmap entero como data URL en base64 en cuanto el elemento
  de respaldo es un canvas** — y reducir la imagen lo convierte justo en eso. Sin esto,
  guardar escribía megabytes de base64 en `canvas_json` en lugar de una URL. Solo actúa
  sobre imágenes cuyo elemento hemos sustituido (marcadas con `_srcUrl`); el resto conserva
  el comportamiento de Fabric. Verificado: el `canvas_json` guardado son 774 bytes, sin
  `data:image`.

Se aplica en las **cuatro** entradas de una imagen al lienzo, no solo en la subida:
`applyBackgroundToCanvas` (subida manual y refresco desde Twenty) y las tres rutas que
reconstruyen el fondo desde su `src` guardado — `page-canvas.tsx`, `restoreFromHistory` y
`loadTemplate`. Faltando cualquiera de ellas, el recorte reaparece al recargar o al
deshacer, que es como se detectó (`normalizeBackgroundSource` es el envoltorio para esas
tres, igual que `applyWorkspaceClip` en §9.16 — mismo patrón, misma causa de fondo:
`loadFromJSON` devuelve el lienzo a su estado *serializado*, no al estado en memoria).

Verificado contra el **build de producción** (`:8787`, con CSP real — §10.3) con una foto
sintética de 5184×3456: se reduce a 4096×2731 y se muestra a 1620×1080 en (-270, 0), que es
el *cover* exacto de una foto 3:2 en una página cuadrada; con blur al 25% **no queda ni una
columna ni una fila transparente**; sobrevive a guardar, recargar, añadir una forma,
**Ctrl+Z** y volver a mover el blur al 35%, siempre con un único fondo y la misma geometría;
la exportación sigue dando 2160×2160. En el camino real de Twenty (imagen de 1200×819, por
debajo del tope) no cambia nada: no se reduce, y el reencuadre manual y el blur siguen
sobreviviendo al refresco automático al reabrir. Sin errores de consola en ningún paso.

### 9.19 Multi-objeto: `News` + `Events`

El editor ya no sirve a un solo objeto de Twenty. Se añadió **`Events`** con exactamente la
misma mecánica: campo Files **Imagen** como foto de origen y campo Links **Imagen Editada**
como destino del resultado. Lo único que cambia entre objetos son los nombres de la API de
GraphQL y de dónde sale el título por defecto (y, desde §9.26, qué campos extra se piden y
cómo se leen), y eso vive en una sola tabla
(`OBJECTS` en [`src/server/twenty.ts`](src/server/twenty.ts)); todo lo demás — rutas,
cliente, base de datos — es genérico y solo pasa el tipo por parámetro. Añadir un tercer
objeto es una entrada más en esa tabla y una en la lista del cliente
([`src/client/lib/twenty.ts`](src/client/lib/twenty.ts)).

**Nombres reales, confirmados por introspección contra la instancia (no supuestos):**

| | `News` | `Events` |
|---|---|---|
| tipo en el editor | `news` | `event` |
| query singular | `news` | **`eventCustom`** |
| mutación | `updateNews` | **`updateEventCustom`** |
| título por defecto | `title` (RichText → `.markdown`) | **`name`** (String) |
| imagen de origen | `imagen` (Files) | `imagen` (Files) |
| destino | `imagenEditada` (Links) | `imagenEditada` (Links) |

Los dos sobresaltos están en la columna de `Events`: Twenty expone el objeto personalizado
con el sufijo **`Custom`** porque `Event` choca con un nombre del núcleo (`event` a secas
**no existe** en el esquema), y su título es un `String` plano, no un RichText. Ambos son
justo el tipo de cosa que no se puede adivinar: se introspeccionó el esquema en vivo.

**Cómo viaja el tipo, de punta a punta:**

- **URL de entrada**: `?objectType=news|event` junto a `?recordId=`
  ([`use-router.ts`](src/client/hooks/use-router.ts)). **Es opcional y por defecto vale
  `news`**, para que los enlaces que ya existen en las fichas de noticias sigan
  funcionando sin tocarlos.
- **Base de datos**: columna nueva `designs.twenty_object_type`, y el índice único pasa de
  `(twenty_record_id)` a **`(COALESCE(twenty_object_type,'news'), twenty_record_id)`** — la
  identidad de un borrador es el par (objeto, registro), no el id suelto. Así el
  *find-or-create* sigue retomando siempre el mismo borrador por registro.
- **Rutas**: `/api/twenty/:type/:id`, `/api/twenty/:type/:id/image`,
  `/api/twenty/:type/:id/publish-image` y `POST /api/designs/from-twenty/:type/:recordId`.
  Un `:type` desconocido responde `400`, no un fallo confuso más adentro.
- **"Guardar en Twenty"** lee el tipo **del diseño** (`twenty_object_type`), no de la URL:
  el operador puede haber llegado al borrador desde la galería y no desde el enlace.

**Dos migraciones que `schema.sql` NO puede hacer solo**, y por eso viven en
[`db.ts`](src/server/db.ts): el fichero es idempotente (`CREATE ... IF NOT EXISTS`), lo que
sirve para crear la base desde cero pero no para *cambiar* algo ya existente — una columna
nueva no aparece en una tabla ya creada, y un índice que cambia de definición **se ignora en
silencio** porque su nombre ya está ocupado. Al arrancar se añade la columna si falta y se
rehace el índice si su SQL todavía no menciona la columna nueva (se detecta por su
definición, no por un número de versión).

**Compatibilidad con lo ya guardado.** Se conservan `GET /api/news/:id` y
`GET /api/news/:id/image` como alias de `type=news`, y no por cortesía: la URL del proxy
queda grabada como `src` del fondo **dentro del `canvas_json`** de cada borrador ya
guardado, así que quitarla dejaría esos diseños sin fondo al abrirlos. Los diseños
anteriores tampoco tienen tipo (`NULL`), de ahí el `COALESCE` tanto en el índice como en la
consulta del *find-or-create*.

**Verificado contra el build de producción** (`:8788`, con CSP real — §10.3) y contra el
Twenty real, no solo `tsc`: la migración sobre una base creada con el **esquema antiguo** y
un borrador de noticia dentro (columna añadida, índice rehecho, fila intacta); ese borrador
antiguo se retoma —no se duplica— y abre su fondo por el alias heredado, sin ningún 4xx ni
error de consola; un evento abre desde `?recordId=…&objectType=event` con su foto y su
`name` como titular; "Guardar en Twenty" escribe en `imagenEditada` del **evento**
(confirmado leyéndolo de vuelta por GraphQL) y el borrador se retoma igual al reabrir; un
`:type` inventado da `400` en las cuatro rutas. Las escrituras de prueba en `imagenEditada`
(un evento y una noticia) se revirtieron a vacío después, como siempre.

### 9.20 Emojis en el texto

Los emojis ya entraban y se pintaban (Fabric v6 usa `Intl.Segmenter`, así que una secuencia
ZWJ como 👨‍👩‍👧 cuenta como **un** grafema y no se parte al medir ni al mover el cursor).
Lo que faltaba era que el resultado **no dependiera de la máquina del operador**: sin fuente
propia, el navegador cae a la del sistema y cada uno pinta un juego distinto — y Windows no
trae banderas de país, así que `🇪🇸` salía como las letras **"ES"** (reproducido y capturado
antes del cambio).

**Fuente autoalojada.** `public/fonts/Noto-Color-Emoji/{0..9}.woff2` (COLRv1, ~2 MB en
total) + sus `@font-face` en [`fonts.css`](src/client/fonts.css), **troceados por
`unicode-range`** igual que los sirve Google Fonts: el navegador solo descarga el trozo del
emoji que se use. No se declara ninguna familia del sistema como respaldo — el objetivo es
justamente que el diseño se vea igual en cualquier equipo.

**Un solo punto de enganche en Fabric.** `_getFontDeclaration` es donde Fabric construye la
cadena `ctx.font`, y **usa la misma para medir y para pintar**; añadir ahí la familia de
emoji (`installEmojiFontFallback` en [`lib/fonts.ts`](src/client/lib/fonts.ts), llamado una
vez desde `main.tsx`) mantiene las dos en sintonía y deja intacto el `fontFamily` del
objeto — que es lo que alimenta el desplegable de fuentes y lo que se serializa en
`canvas_json`. Tocar `fontFamily` habría contaminado ambos.

**Y hay que re-medir, como con cualquier otra webfont** (§9.13 bug B): la fuente de emoji
solo se pide cuando ya hay un emoji en el lienzo, así que el primero que se escribe se mide
contra un glifo de reserva y la línea se parte con el ancho equivocado. `syncCanvasFonts`
la carga (pasándole el texto, para que `unicode-range` acote la descarga) y limpia la caché
de anchos; un listener de `text:changed` cubre el caso de escribirlo **en mitad de la
edición**, que es el único momento en que una fuente llega a mitad de faena.

**Selector de emojis** ([`emoji-picker.tsx`](src/client/components/emoji-picker.tsx), en el
panel derecho, sección Text): lista curada por categorías, no el catálogo Unicode entero —
esto es para titulares, no un teclado de chat. Inserta **en el cursor** si el cuadro está en
edición (y si no, al final). Dos detalles que lo hacen usable:

- `onMouseDown` con `preventDefault` en el botón y en el desplegable: sin eso el foco se va
  del cuadro de texto, Fabric cierra la edición y el emoji acabaría al final en vez de
  donde está el cursor.
- El cursor avanza contando **grafemas**, no la longitud de la cadena: un emoji son varias
  unidades de código y `insertChars` deja el cursor en medio si se usa `.length` (el propio
  manejador de *drop* de Fabric tiene ese fallo).
- Las muestras del selector se pintan con la **misma** fuente que el lienzo, o en Windows
  una bandera se vería ahí como las letras del país y no como lo que va a salir. Abrir el
  selector sí descarga todos los trozos (los emojis de la lista caen en subconjuntos
  distintos); es una vez por navegador y quedan cacheados un año (§9.10).

Verificado contra el **build de producción** (`:8788`, CSP real — §10.3): sin emojis en el
lienzo **no se descarga ni un byte** de la fuente; al escribir `🇪🇸` sale la bandera (antes,
"ES"); el selector inserta en el cursor sin sacar el texto de edición; sobrevive a guardar y
recargar; y la exportación sigue dando 2160×2160 con los emojis pintados. Sin errores de
consola.

### 9.21 Formato por rango de caracteres

Petición del usuario: «si tengo un texto "Este comentario es de prueba." poder poner la
palabra *prueba* de otro color o algo por el estilo. Actualmente pilla todo el texto
cualquier formato que aplique». Hasta ahora la **negrita** era la única excepción (§4): el
resto de controles del panel derecho se aplicaban siempre al cuadro entero.

Ahora respetan la selección **color, tamaño, tipografía, cursiva, subrayado y contorno**.
Siguen siendo del cuadro entero **alineación, interlineado, espaciado y opacidad**, y no por
decisión de diseño sino porque Fabric no puede guardarlas por carácter (ver abajo).

**Dónde vive.** [`src/client/lib/text-styles.ts`](src/client/lib/text-styles.ts) (nuevo)
concentra el conocimiento de Fabric; `applyTextStyle` en
[`use-canvas.ts`](src/client/hooks/use-canvas.ts) es **el único punto** por el que pasa el
formato de texto, y el panel solo decide qué propiedad manda. `toggleBold` se reescribió
encima de él: lo único que le queda propio es decidir hacia qué lado alternar.

#### Lo que decide el diseño (leído en el código de Fabric 6.9.1, no supuesto)

1. **Qué se puede guardar por carácter lo dicta `styleProperties`**
   (`shapes/Text/constants.ts`): `fontSize`, `fontWeight`, `fontFamily`, `fontStyle`,
   `underline`, `overline`, `linethrough`, `stroke`, `strokeWidth`, `fill`, `deltaY`,
   `textBackgroundColor`, `textDecorationThickness`. Lo que no está en esa lista se guarda
   y **se ignora en silencio** al pintar. La trampa está en el contorno: `paintFirst`,
   `strokeLineJoin` y `strokeUniform` parecen propiedades de texto pero son solo de objeto,
   así que `splitTextStyleProps` manda `stroke`/`strokeWidth` al rango y esos tres al
   objeto (inocuo: el paso de trazo se salta los caracteres que no tienen). La lista se
   **deriva** de `fabric.FabricText._styleProperties` en vez de copiarse, por el mismo
   criterio que el tope de textura de §9.18.
2. **Perder el foco del DOM NO cierra la edición.** El manejador `blur` de Fabric
   (`ITextKeyBehavior`) es literalmente `blur() { this.abortCursorAnimation(); }`;
   `exitEditing` solo se alcanza desde interacciones del propio lienzo. Por eso un
   `<input type="color">` que abre el diálogo del sistema **conserva la selección**, que era
   el riesgo principal del trabajo. Lo único que se pierde es el dibujo del resaltado, y se
   recupera con `renderCursorOrSelection()` (solo exige `isEditing`, no foco).
3. **Escribir `undefined` borra el ajuste**, no lo guarda: `_extendStyles` pasa la
   declaración fusionada por `pickBy(v => v !== undefined)`. Sobre eso está construido
   "Quitar formato" para un rango; para el cuadro entero se usa `removeStyle(prop)`.
4. **Un cursor sin selección no puede llevar estilo**: `setSelectionStyles` recorre
   `start..end`, así que con el cursor plegado no escribe nada, y Fabric no tiene "estilo
   pendiente para lo siguiente que se teclee". Por eso `textRange()` devuelve `null` con el
   cursor plegado y se cae al cuadro entero — la misma regla que ya usaba la negrita.
5. **Índices planos, siempre por `get/setSelectionStyles`.** `Textbox` remapea líneas
   gráficas a lógicas con su `_styleMap`; tocar `obj.styles[línea][carácter]` a mano se
   descuadra en cuanto el texto va en varias líneas.

**Persistencia: cero trabajo.** `Text.toObject` incluye siempre `styles` y todo el guardado
pasa por `withoutLogo(canvas, () => JSON.stringify(canvas.toJSON()))`, que no filtra nada.
Los estilos por palabra viajan solos en `canvas_json` y sobreviven a guardar, recargar y
undo/redo. `collectUsedFaces` (§9.13 bug B) ya recorría los estilos por carácter, así que un
cambio de tipografía o peso en un rango se re-mide gratis.

**Conflicto cuadro/palabra.** Cambiar el color con el cuadro entero seleccionado **no** borra
las palabras coloreadas a mano — el valor por carácter manda al pintar, y se decidió
conservarlo (como Word o Canva). La salida es el botón **Quitar formato**, que limpia la
selección si la hay y, si no, todos los ajustes por palabra del cuadro.

#### Tres bugs encontrados durante la verificación

Ninguno se ve leyendo el código; los tres salieron al probar con ratón y teclado reales.

- **El lienzo no repintaba el color.** `setSelectionStyles` muta el mapa de estilos sin pasar
  por `set()`, así que **nunca marca el objeto como sucio** y Fabric vuelve a estampar el
  bitmap cacheado. La palabra se quedaba del color viejo hasta que algo invalidaba la caché,
  lo que hacía parecer que solo funcionaban tamaño y tipografía (esos llaman a
  `initDimensions`, que sí la invalida). `applyTextStyle`/`clearTextStyle` ponen `dirty = true`
  explícitamente, igual que ya hacía `lib/fonts.ts` al re-medir.
- **Enter en un campo del panel se comía la palabra.** Al devolver el foco al lienzo *durante*
  el keydown, la acción por defecto de la tecla la recibía el cuadro de texto, y Enter ahí
  **sustituye los caracteres seleccionados por un salto de línea**: confirmar un color
  borraba la palabra que se estaba formateando (el texto quedaba como `Este comentario es de` + salto + `.`). Se cancela la
  pulsación (`preventDefault`) antes de mover el foco.
- **El botón Guardar dejó de responder.** Enfocar el textarea oculto de Fabric desplaza el
  documento (Fabric lo aparca en la posición del texto, fuera del viewport si hay zoom), y
  eso ocurría con el puntero aún pulsado sobre el control: el botón se movía de debajo del
  cursor y nunca recibía el clic. Se enfoca con `focus({ preventScroll: true })`.

**Foco: qué lleva `preventDefault` y qué no.** Los botones y las muestras de color llevan
`onMouseDown` con `preventDefault` (como ya hacían la negrita y el selector de emojis), así
que no roban el foco. Los campos que hay que enfocar para escribir —hexadecimal, tamaño,
desplegable de tipografía— no pueden, y devuelven el foco al lienzo **con Enter**, no con
`change`: `change` también salta al perder el foco, es decir justo cuando el operador acaba
de pulsar otro control, y quitárselo ahí sería pelearse con él.

**Valores mixtos.** Si la selección abarca valores distintos, el campo se muestra vacío con
un `placeholder` "varios" y los botones de estilo solo se marcan activos si **todos** los
caracteres lo tienen; si no, el panel mentiría sobre lo que hay seleccionado.

**Verificado contra el build de producción** (`pnpm run build && pnpm run start`, `:8788`,
con la CSP real — regla de §10.3/§9.11), con ratón y teclado reales y midiendo los píxeles
pintados, no solo el modelo: colorear *prueba* deja `styles: [{start: 22, end: 28, style:
{fill}}]` y el `fill` del cuadro intacto; aparecen píxeles rojos y el resto sigue oscuro;
tamaño, cursiva, tipografía y contorno se acumulan sobre ese mismo rango sin tocar el cuadro;
el contorno guarda `stroke`/`strokeWidth` por carácter y `paintFirst` en el objeto; con el
cursor plegado la muestra de color recolorea el cuadro **y la palabra conserva el suyo**; la
negrita sigue alternando solo el rango en los dos sentidos; "Quitar formato" lo deja limpio;
undo restaura exactamente el mismo recuento de píxeles; la exportación sigue dando 2160×2160;
y tras **recargar** la página la palabra sigue roja y en Playfair Display mientras el resto
sigue en Montserrat. El selector de emojis sigue insertando en el cursor. Sin errores de
consola en ningún paso.

### 9.22 La interfaz se desplazaba al seleccionar texto

Reporte del usuario: «en ocasiones al seleccionar una palabra el sitio web como que se
sube, escondiendo la parte superior de la interfaz y mostrando una parte negra abajo», y
solo cuando la palabra queda por debajo del centro de la pantalla.

**Causa.** Para recibir las pulsaciones, Fabric aparca un `<textarea>` invisible de 1×1 en
la posición del cursor, lo cuelga de `document.body` y lo **recoloca en cada movimiento del
cursor o de la selección** (`updateTextareaPosition`). Sus coordenadas son **del documento**,
no de la ventana: `_calcTextareaPosition` termina sumando `canvas._offset`. Con la página
ampliada eso cae muy por debajo del pliegue —medido: `top: 1364px` en una ventana de 1000px—
así que el navegador desplaza el elemento enfocado hasta hacerlo visible.

Lo que despista es que `html, body, #app` **ya tienen `overflow: hidden`**
([`styles.css`](src/client/styles.css)). Eso no lo impide: `overflow: hidden` quita la barra
y el desplazamiento por parte del usuario, pero el contenedor **sigue siendo desplazable por
código**, y eso incluye el "llevar el foco a la vista" del navegador. De ahí que se moviera
sin que apareciera ninguna barra y que asomara el fondo de la página como una banda negra.

**No es una regresión de §9.21.** Comprobado sacando el build del commit anterior
(`6df850a`, antes del formato por rango) y repitiendo la medición: exactamente el mismo
desplazamiento de 420px. Lo que cambió es la frecuencia — seleccionar palabras pasó a ser
algo que se hace todo el rato, así que un fallo latente se volvió cotidiano.

**Arreglo:** `installTextareaHost()` en [`lib/workspace.ts`](src/client/lib/workspace.ts),
llamado una vez desde `main.tsx` antes de que exista ningún canvas (mismo patrón que
`installEmojiFontFallback`, §9.20). Crea un contenedor fijo del tamaño de la ventana,
recortado y sin eventos de puntero, y se lo pasa a Fabric por `hiddenTextareaContainer` —
que existe justo para esto («An alternative to attaching to the document.body»). El textarea
sigue quedando fuera de los límites de ese contenedor, así que el navegador **lo desplaza a
él** para revelar el cursor y se detiene ahí: el contenedor ya está entero en pantalla, y
nada de lo que ve el operador se mueve.

Se registra a través de `IText.ownDefaults` y no objeto por objeto. Fabric fusiona
`ownDefaults` en cada instancia al construirla, así que cubre de una vez el texto añadido
desde la barra, el restaurado de un diseño guardado, el reconstruido por deshacer y el de
una plantilla — los mismos cuatro puntos de entrada que en §9.18 hubo que ir encontrando de
uno en uno. **Ojo:** `hiddenTextareaContainer` está en `iTextDefaultValues`, de modo que cada
instancia recibe un `null` propio; asignarlo en el prototipo **no funciona**, lo tapa.

**Relacionado, ya arreglado en §9.21:** `restoreTextFocus` enfoca con
`focus({ preventScroll: true })`. Sin eso el desplazamiento ocurría con el puntero aún
pulsado sobre un control del panel, el botón se movía de debajo del cursor y no llegaba a
recibir el clic — así fue como el botón Guardar dejó de responder.

**Verificado contra el build de producción** (`:8788`, CSP real) midiendo
`documentElement.scrollTop` y la posición de la barra superior en cada paso: al entrar en
edición, al escribir, al mover el cursor al principio, al llevarlo al final y al seleccionar
una palabra baja, el desplazamiento se queda en **0** y la barra en `top: 0` (antes: 420 y
−420). El textarea vive ya en `DIV#fabric-textarea-host`. Las dos suites completas de §9.21
siguen pasando enteras, así que el textarea sigue recibiendo el teclado con normalidad.

### 9.23 Guías de centro imantadas

Empezó como una cuadrícula de tercios, solo visual, sin imán — así se decidió en su momento,
con la salvedad expresa de que «para centrar exacto se sigue yendo a ojo». El usuario pidió
lo contrario: una guía que divida el lienzo en 4 (un eje vertical y uno horizontal por el
centro, no tercios) y que además **imante** el arrastre — con **Ctrl** pulsado como escape
para colocar a mano cerca del centro sin que el imán interfiera. Mismo botón del toolbar
(ahora con icono de mira, `Crosshair`), junto al zoom; apagado por defecto, y el imán está
activo **solo mientras la guía está encendida** — es una sola decisión con dos efectos, no
dos ajustes independientes.

**Sigue siendo una capa del DOM, no objetos de Fabric** — la decisión de fondo de la versión
anterior no cambia con el imán, y merece repetirse: meter la guía en el lienzo obligaría a
excluirla a mano de cuatro sitios a la vez: del `canvas_json` (no es parte del diseño), del
historial (cada encendido sería un paso de deshacer), de la selección (una guía no es algo
que se pulse) y sobre todo **de la exportación** — `exportPNG`/`exportUploadBlob` leen el
lienzo **en vivo**, que es justamente por lo que el logo sí sale en la imagen final (§4). Una
guía colada dentro del JPEG que se sube a Twenty habría sido un mal día. Como hermana del
`<canvas>` en el DOM ([`guides-overlay.tsx`](src/client/components/guides-overlay.tsx)),
nada de eso puede pasar por construcción — **el imán en sí vive aparte, en
[`lib/snapping.ts`](src/client/lib/snapping.ts)**, enganchado al evento `object:moving` de
Fabric: mueve el objeto real en el lienzo, pero nunca toca el DOM de la guía ni al revés; lo
único que cruza de un lado a otro es qué eje quedó enganchado, para que la línea correspondiente
se resalte.

**Por qué el imán no vive en la propia guía visual.** `GuidesOverlay` es
`pointer-events: none` a propósito (§9.23 original) — nunca puede ser ella quien intercepte
el arrastre. El imán tenía que enganchar el propio Fabric, así que es un `canvas.on(
"object:moving", ...)` más, registrado una vez por página dentro de `registerCanvas`
(`use-canvas.ts`, el mismo sitio que todos los demás `canvas.on(...)` del editor) — no un
listener nuevo por objeto.

**Cómo decide qué enganchar:**

- **Solo el centro del objeto, por eje por separado** (decisión del usuario): se compara
  `target.getCenterPoint()` contra `(pageWidth/2, pageHeight/2)` en cada eje de forma
  independiente, así que se puede centrar en horizontal y seguir moviendo libre en vertical.
  Los bordes no enganchan — solo el centro.
  Se usa `getCenterPoint()`/`setPositionByOrigin(..., "center", "center")`, nunca aritmética
  sobre `left/top`: es lo único que funciona igual para un objeto suelto, uno rotado y una
  `ActiveSelection` (arrastre de varios objetos a la vez) sin tener que tratar cada origen
  como caso aparte.
- **Tolerancia en píxeles de pantalla, no de diseño** (`8px / zoom`): al zoom por defecto
  (`0.58`) son ~14 unidades de diseño, pero el radio de enganche se *siente* igual a
  cualquier zoom — mismo criterio que ya usa el grosor de la línea (`1 / zoom`).
- **Ctrl (o Cmd) desactiva el imán mientras se mantiene pulsado**, leído directamente del
  evento nativo de cada tick de `object:moving` (`opt.e.ctrlKey`/`metaKey`), no de un
  `keydown`/`keyup` global: no hay ningún listener que registrar ni limpiar, y no se queda
  "pegado" en encendido si la ventana pierde el foco con la tecla aún pulsada. Cmd se trata
  igual que Ctrl por paridad con el zoom con rueda de `canvas-area.tsx`, que ya hace lo mismo.
  **Límite conocido y documentado en el propio código:** como el evento solo se dispara al
  mover el ratón, pulsar Ctrl *después* de haberse quedado quieto sobre el centro no libera
  el objeto hasta el siguiente movimiento — el comportamiento esperable, no un listener global
  de más.
- **El historial no necesita nada nuevo**: `object:modified` ya dispara `saveHistory`
  ([use-canvas.ts](src/client/hooks/use-canvas.ts)) y salta *después* de soltar, así que la
  posición ya imantada entra sola en el `Ctrl+Z`.

**Resaltado de la línea enganchada** (pedido por el usuario): mientras un eje está
enganchado, esa línea pasa al color de acento (`#6366f1`, el mismo del anillo de página
activa y de los tiradores de Fabric) y grosor `2 / zoom`; al soltar (`mouse:up`) vuelve a su
estilo normal. El estado vive en `use-canvas.ts` como `{ pageId, x, y }` — **con la página
incluida**, porque el overlay se pinta en todas las páginas a la vez (una por lienzo) y solo
debe resaltarse la que se está arrastrando de verdad; el *setter* descarta la actualización
si nada cambió (`prev` se devuelve tal cual), porque el handler corre en cada tick del ratón
y sin eso sería un render de más por cada píxel de arrastre.

Dos detalles heredados de la versión de tercios, sin cambios:

- **El grosor se divide por el zoom.** Todo el árbol del lienzo va escalado por CSS
  (`canvas-area.tsx`), así que una línea de 1px se pintaría a 0.58px con el zoom por defecto
  y casi desaparece. `1 / zoom` la mantiene en un píxel real a cualquier zoom.
- **Núcleo claro con halo oscuro** (`rgba(255,255,255,.7)` + `box-shadow` negro). Un color
  único no vale: debajo puede haber la tarjeta blanca, una foto clara o una oscura.

Se dibuja sobre **la página**, no sobre el área de trabajo: el margen existe para alcanzar
los tiradores que se salen (§9.13), y el centro solo significa algo dentro de lo que se
exporta.

`showGuides` sigue viviendo junto al zoom en `use-canvas.ts`, como lo que es: un ajuste del
visor. No se guarda en ningún sitio, así que al recargar vuelve a estar apagada (y el imán
con ella).

**Verificado contra el build de producción** (`:8788`, CSP real — regla de §9.11/§10.3),
con ratón real (Playwright) y comprobando la posición exacta persistida en `canvas_json`
via API, no solo lo que se ve en pantalla: arrastrar una forma a pocos píxeles del centro
suelta con `getCenterPoint()` en exactamente `(540, 540)` sobre una página 1080×1080, y la
línea correspondiente se resalta durante el arrastre y vuelve a su color al soltar; repetir
el mismo arrastre **con Ctrl mantenido durante todo el movimiento** deja el objeto en la
posición natural del cursor (`546.9, 545.17` en la prueba, sin redondear a 540) y sin ningún
resaltado — el imán queda desactivado de verdad, no solo visualmente; apagar el botón de
guías y repetir el arrastre da el mismo resultado sin imán; con dos objetos seleccionados a
la vez el centro del grupo engancha igual, sin descolocar los objetos que contiene; tras un
arrastre imantado, `Ctrl+Z` devuelve el objeto a su posición previa; y la comprobación que de
verdad importa — **el PNG exportado es idéntico byte a byte (mismo SHA-256) con la guía
encendida y apagada** — confirma que nada de esto puede acabar dentro de la imagen que sube a
Twenty. Sin errores de consola en ningún paso.

### 9.24 Efectos del texto: sombra, resplandor, hueco y fondo

Petición del usuario: «más efectos para las letras, quiero uno que añada como un contorno
sombreado». Aclarado con vistas previas, resultó ser **sombra proyectada**; añadió además
**resplandor**, **hueco** y **fondo del texto**. Todo vive en
[`lib/text-effects.ts`](src/client/lib/text-effects.ts), el equivalente para la letra de lo
que `lib/effects.ts` hace con la foto (§9.14): entre los dos cubren las dos salidas al mismo
problema — calmar la imagen, o hacer el texto lo bastante fuerte como para que dé igual.

#### Tres cosas de Fabric que deciden el diseño

1. **Un objeto tiene exactamente una ranura `shadow`.** Un resplandor *es* una sombra sin
   desplazamiento y con más desenfoque, así que sombra y resplandor **no pueden coexistir**.
   Por eso son un selector `Ninguno | Sombra | Resplandor` y no dos casillas que se pisarían
   la una a la otra en silencio.
2. **`shadow` es de objeto, no por carácter** — no está en `styleProperties` (§9.21). Pasa
   igualmente por `applyTextStyle`, porque `splitTextStyleProps` desvía al objeto lo que no
   es por carácter, pero **una selección no puede acotarla**. En cambio
   `textBackgroundColor`, `fill` y `stroke` sí son por carácter, así que el fondo del texto y
   el hueco **sí siguen a la palabra seleccionada**.
3. **La sombra se salta el contorno salvo que se le pida.** `_renderTextStroke` llama a
   `_removeShadow` cuando `shadow.affectStroke` es `false`, que es lo normal. Sin tocarlo,
   una letra con contorno proyecta la sombra solo de su relleno y el contorno parece pegado
   encima. `affectStroke: true` hace que la silueta entera la proyecte como una sola forma —
   es literalmente lo que convierte esto en el «contorno sombreado» que se pidió.

**El tipo de efecto no se guarda aparte**: se deduce del desplazamiento (sin desplazamiento
= resplandor). Así todo cabe dentro del `shadow` que Fabric ya serializa, sin nada que
registrar en `customProperties` ni que perder al pasar por `canvas_json`. La intensidad viaja
como el alfa del color (`rgba(...)`), leído de vuelta con `fabric.Color`, para que el
selector de color siga siendo un selector de color.

#### Hueco: un intercambio, no un estado oculto

Activarlo mueve el color de la letra **al contorno**; desactivarlo lo devuelve al relleno y
limpia el contorno. Al ser una involución exacta, pulsar el botón dos veces devuelve
exactamente lo que había, y no hay ningún «color anterior» guardado que pueda quedar obsoleto
al recargar. Pisa un contorno previo a propósito: la alternativa pierde más — una palabra
roja con contorno negro se quedaría solo en negro, y el color que el ojo sigue desaparecería
sin vuelta atrás. Crear el contorno al entrar no es opcional: relleno transparente sin trazo
es una palabra invisible, y se lee como que el botón ha borrado el texto.

#### Un bug encontrado en la verificación

El contorno del hueco salía de **1px** en vez de derivarse del cuerpo de la letra: se le
estaba pasando `strokeWidth` tal cual, y **Fabric deja ese valor en 1 aunque no haya ningún
contorno** — exactamente la trampa que el comentario de `applyOutline` ya advertía desde
§9.15. Con letra de 48px eso es un filo de pelo. Ahora se pasa `outlineWidth`, que es el
valor ya corregido por «no hay color de trazo ⇒ no hay contorno».

**Verificado contra el build de producción** (`:8788`, CSP real), midiendo píxeles pintados
además del modelo: encender la sombra pasa de 16.610 a 33.060 píxeles con tinta, o sea que se
pinta de verdad y no solo se guarda; el `canvas_json` recoge `offsetX/Y`, `affectStroke: true`
y el color en `rgba`; el deslizador de distancia llega hasta la sombra; cambiar a resplandor
**sustituye** la sombra en vez de acumularse (una sola ranura, desplazamiento 0); al recargar
el panel vuelve marcando «Resplandor» y no «Ninguno»; «Ninguno» la borra del diseño guardado;
el hueco deja `fill: transparent` con contorno de 2px del color que tenía la letra y vuelve
limpio, incluso con un contorno azul previo; el fondo del texto se guarda **solo en el rango**
`22..28` y el cuadro no recibe ninguno; y la exportación sigue dando 2160×2160. Las suites
completas de §9.21 y §9.23 siguen pasando enteras. Sin errores de consola.

### 9.25 «Mejorar»: la receta de noticia local, sin IA

El usuario venía pasando cada imagen por un modelo de imagen con un prompt largo, y pidió
poder aplicar «esos efectos» desde el editor con un botón **Mejorar**, más poder configurar
cada uno por separado.

**Al escribir el prompt como valores concretos, resulta que casi nada de él necesita un
modelo.** Buena parte de su extensión son prohibiciones —«NO CAMBIES, NO REGENERES, NO
RECORTES, NO INVENTES, NO CAMBIES LAS DIMENSIONES»— y todas se cumplen aquí **por
construcción**, porque la fotografía no se repinta nunca: es un objeto del lienzo con
filtros encima. Lo que queda es un puñado de filtros y de ajustes tipográficos.

El argumento decisivo, sin embargo, es otro: **por el modelo, el titular vuelve como
píxeles**. Una errata obliga a regenerar la imagen entera. Aplicado al lienzo sigue siendo
texto real — editable, seleccionable palabra a palabra (§9.21), y guardado en `canvas_json`.

Correspondencia entre el prompt y lo que ya existía:

| Prompt | Dónde |
|---|---|
| Mantener foto, encuadre, dimensiones; no recortar ni inventar | Imposible violarlo: no se regenera |
| Velo oscuro semitransparente | Scrim, §9.14 |
| Titular Montserrat ExtraBold blanco | El peso 800 ya venía en `public/fonts` |
| Centrado, interlineado compacto, tracking reducido | Controles existentes |
| Sombra negra difusa, sin contorno grueso | §9.24 |
| Palabra destacada en otro color | §9.21 |
| Logo en su sitio | §4 |
| **Nitidez** y **contraste** | Nuevos: `Convolute` y `Contrast` |
| **MAYÚSCULAS** y **centrar el bloque** | Nuevos, en `lib/enhance.ts` |

**Dos botones, no uno** (decisión del usuario): «Mejorar foto» en el panel Bg y «Mejorar
titular» en el panel de texto. Reencuadrar un titular ya colocado a mano es lo más intrusivo
de la receta, así que se decide aparte.

#### Detalles que importan

- **El orden de los filtros no es arbitrario.** La nitidez va primero, sobre la foto aún
  intacta: un desenfoque posterior la desharía, y afilar *después* de subir el contraste
  exagera los halos que el propio contraste crea.
- **El kernel de nitidez suma 1.** `sharpenMatrix` interpola el laplaciano de 5 puntos con
  la identidad, así que a 0 deja la foto igual y los pesos siempre suman uno — un kernel que
  no suma 1 aclara u oscurece la imagen entera en silencio, que es la forma habitual de que
  esto salga mal.
- **Las mayúsculas solo se aplican si la longitud no cambia.** `styles` va indexado por
  posición de carácter, así que una conversión que alargue el texto (ß→SS) descuadraría el
  formato por palabra. En español no ocurre (á→Á), pero la guarda está escrita.
- **Se re-centra dos veces.** Montserrat 800 casi nunca está descargada al pulsar el botón,
  así que la primera medida es la de la fuente de reserva (§9.13 bug B); `syncCanvasFonts`
  resuelve y se vuelve a centrar con las métricas reales.
- **La receta se aplica al cuadro entero**, nunca al rango seleccionado: es un preset de
  maquetación, y acotarlo a una palabra dejaría el resto del titular en la fuente y el
  tamaño viejos.
- Todos los valores siguen siendo deslizadores normales (nitidez y contraste son nuevos en
  el panel Bg), así que la receta es un punto de partida y no una caja negra. Ctrl+Z la
  deshace.

**Verificado contra el build de producción** (`:8788`, CSP real) con una foto sintética
detallada, midiendo la imagen además del modelo: tras «Mejorar foto» la luminancia media baja
de 119,6 a 64,7 (oscurece de verdad) pero se queda muy por encima de negro (la foto sigue
viéndose, que es lo que el prompt pide dos veces), y la energía de bordes sube de 1,128 a
1,317 (la nitidez y el contraste hacen algo medible); el `canvas_json` guarda
`Convolute + Contrast + Brightness` y un scrim, y el `src` de la imagen **sigue siendo la URL
original**, no un `data:` — o sea que la foto no se sustituyó. Tras «Mejorar titular»: texto
en mayúsculas con acentos intactos, Montserrat 800, `#ffffff`, centrado, `lineHeight 1.05`,
`charSpacing -20`, sin contorno, sombra de 13px de desenfoque, centro horizontal exacto en
540,0 y ancho 886 sobre 1080 (márgenes laterales). La exportación sigue dando 2160×2160 y las
suites de §9.21, §9.23 y §9.24 siguen pasando enteras. Sin errores de consola.

**Lo que esto NO hace:** no llama a ninguna IA. Si algún día se quiere el acabado concreto de
un modelo de imagen (por ejemplo un reencuadre generativo), eso sería un endpoint nuevo con
su clave de API, y habría que asumir que el texto deja de ser editable.

### 9.26 Plantilla automática de eventos

Petición del usuario: para los eventos, «una especie de estructura que siempre se repita y
sea variable con respecto a los campos disponibles», de modo que abrir el editor con un
evento requiera poca edición manual. Las noticias no cambian en nada.

Un evento no es una foto con un titular: es un registro con una docena de datos publicables
(cuándo, dónde, cuánto, de qué tipo) que hasta ahora había que teclear a mano en el lienzo
mirando la ficha de Twenty en otra pestaña.

#### Dos hechos de los datos reales que decidieron el diseño

Verificados por MCP contra la instancia (98 registros, 39 inspeccionados campo a campo):

1. **Las fechas están en UTC y hay que pintarlas en `Europe/Madrid`.** El espectáculo cuya
   descripción dice «21:30 h» está guardado como `2026-08-22T19:30:00.000Z`. Formatear en
   UTC —o fiarse de la zona del navegador— publica la hora equivocada en la imagen.
2. **La «Imagen» de un evento casi nunca es una foto de prensa: es un cartel** que ya lleva
   impresos el nombre, la fecha y el lugar (`cartel-final-rmf-alicante-598x1024.jpg`,
   `Cartel-Actualizado-2026-1-768x960.jpg`). Eso condiciona el encuadre y, sobre todo,
   explica el límite conocido del final de esta sección.

Otros: `municipio` siempre relleno; `direccion` a veces vacía; `organizador` y
`correoContacto` **vacíos en los 39 registros**, así que ni se piden; los campos vacíos
llegan como `""` y no como `null` (se normalizan en el servidor, `blankToNull`); muchos
nombres traen un separador (`|`, guión) que ya divide título y subtítulo.

#### Piezas

- **`src/server/twenty.ts`** — `TwentyObjectDef` gana `fieldsSelection`/`readFields`, ambos
  **opcionales**: `news` no los define y su query se construye idéntica a la de antes, así
  que no hay forma de que esto la afecte. `TwentyRecord` gana `fields`, que para una noticia
  es `null`.
- **`src/server/index.ts`** — `DEFAULT_CANVAS_SIZE` por tipo de objeto: `news` 1080×1080,
  `event` **1080×1350** (4:5 aprovecha mucho mejor un cartel vertical y ocupa más pantalla
  en el feed). Solo afecta a diseños nuevos; los ya creados conservan su tamaño.
- **`src/client/lib/event-fields.ts`** (nuevo) — datos crudos → texto publicable. Sin
  dependencias: `Intl.DateTimeFormat` con `timeZone: "Europe/Madrid"` cubre todo. Aquí viven
  las reglas de fecha, `CATEGORY_LABELS`, la primera frase de la descripción y el troceo del
  nombre en título + subtítulo.
- **`src/client/lib/event-template.ts`** (nuevo) — dónde se coloca cada cosa. **Nada tiene
  posición absoluta**: los bloques se declaran en orden, se miden de verdad y se apilan
  anclados **por abajo**; el que no tiene dato no se crea y su hueco no existe. Anclar por
  abajo es lo que mantiene la composición estable cuando el titular pasa de dos líneas a
  cuatro.
- **`src/client/components/event-panel.tsx`** (nuevo) — sección «Evento» del panel
  izquierdo, visible solo si el diseño viene de un evento: «Rehacer plantilla», el
  conmutador de modo, y la lista de campos encontrados/vacíos (la superficie de diagnóstico
  de la pregunta que se va a hacer siempre: «¿por qué no sale la fecha?»).

#### Los dos modos, y por qué el umbral está donde está

- **«Cartel entero»**: el cartel se ve completo (contain) sobre un fondo hecho con la misma
  imagen a *cover*, desenfocada y oscurecida; la ficha de datos va debajo.
- **«A sangre»**: la imagen ocupa la página con degradado inferior y el bloque encima — el
  layout de las noticias.

La elección es automática por proporción, pero el umbral (`ASPECT_TOLERANCE = 1.08`) es
deliberadamente **estrecho**, y el motivo no es geométrico: llevar un cartel a sangre hace
dos daños a la vez, lo recorta y pone nuestro bloque encima de los datos que el cartel ya
daba. Como no hay forma fiable de distinguir un cartel de una fotografía, el umbral se
inclina al lado que no pierde información: solo va a sangre lo que encaja **sin recortar
prácticamente nada**. Para el resto está el conmutador, a un clic.

#### Orden de operaciones (lo delicado)

`page-canvas.tsx` pasa de dos ramas con callbacks a medias a un único `bootstrap()`
secuencial, porque la composición depende de dos cosas asíncronas: **el fondo cargado** (para
conocer la proporción y elegir modo) y **las fuentes cargadas** (para medir el texto).

```
loadFromJSON → applyWorkspaceClip → normalizeBackgroundSource → applyLogoToCanvas
  → GET /api/twenty/:type/:id
  → applyBackgroundToCanvas({ preserveFraming, pageWidth, pageHeight })   ← ahora SÍ se espera
  → composeEventOnCanvas(...)  [solo si la página está en blanco y es un evento]
  → scheduleSave()
```

Dentro de `composeEventTemplate` se **apila dos veces**, con `syncCanvasFonts` en medio. No
basta con recolocar un objeto como hace «Mejorar titular» (§9.25): si el titular pasa de dos
líneas a tres al llegar Montserrat 800 real, se mueve todo lo que va debajo — hay que
re-apilar entero.

#### Un bug latente que este trabajo activó, y dos que introdujo

- **Tamaño de página capturado obsoleto.** `page-canvas.tsx` monta con `deps: []` y usaba el
  `width/height` capturado dentro de continuaciones asíncronas; `applyBackgroundToCanvas`
  además cerraba sobre `canvasWidth/canvasHeight` del hook. Mientras todo medía 1080×1080 no
  se notaba, pero el efecto que sincroniza el tamaño con el diseño (`app.tsx`) corre **un
  render después** del montaje, así que con 1080×1350 la página se recortaba a un cuadrado y
  el *cover* del fondo se calculaba contra la altura equivocada. Arreglado con un `sizeRef`
  reasignado en cada render (el patrón de `onActivateRef`) y un `pageWidth`/`pageHeight`
  explícito en las opciones de `applyBackgroundToCanvas`.
- **`customProperties` no se hereda como parece.** `toObject()` serializa
  `propertiesToInclude.concat(FabricObject.customProperties, this.constructor.customProperties)`.
  Registrar el marcador solo en la clase base **no basta**: `Textbox` no declara
  `customProperties` propia y por tanto la hereda —ahí sí aparecía—, pero `Rect` y
  `FabricImage` sí la declaran (`effects.ts` y `background.ts` escriben las suyas) y esa
  propiedad propia **tapa** la heredada. Observado en el `canvas_json` guardado: los textos
  conservaban su rol y la píldora y el cartel lo perdían, con lo que al recargar «Rehacer
  plantilla» ya no sabía que existían y **cada pasada dejaba un cartel más encima del
  anterior** — el bug de §9.12 otra vez, por otra puerta. Se registra clase por clase y
  **conservando** lo que cada una ya tuviera.
- **`clone()` copia las propiedades registradas**, así que el cartel del modo cartel nacía
  marcado como fondo (`_isBgImage`) y `findBackgroundImage` lo devolvía a él: el refresco
  desde Twenty habría sustituido el cartel en vez del fondo. Se borra la marca al clonar.
- `normalizeBackgroundSource` se generalizó a **todas** las imágenes (era el quinto punto de
  entrada que §9.18 no cubría): el cartel también vuelve de `loadFromJSON` a resolución de
  cámara y el filtro del fondo lo truncaría.

#### Historial y guardado

`composeEventOnCanvas` envuelve la composición en `isRestoringRef` —el mismo mecanismo que
usa `loadTemplate`— así que los ~10 objetos que añade **no** son diez pasos de deshacer.
Distingue dos usos: la composición automática **sella** el historial en una sola entrada (es
el estado inicial del documento; deshacer hasta una página en blanco no es un estado útil),
mientras que «Rehacer plantilla» deja **una** entrada, de modo que `Ctrl+Z` devuelve
exactamente lo que había antes del clic. El snapshot inicial diferido de `registerCanvas`
(100 ms) consulta ahora un `historySealedRef` antes de escribir, o machacaría lo compuesto.

Y se llama a `scheduleSave()` al terminar: `saveDesign` ignora las páginas cuyo JSON sea
`"{}"`, que es justo la condición de «primera vez» — sin guardar, la página seguiría
contando como en blanco y **se recompondría en cada apertura**, pisando lo editado.

#### Verificado contra el build de producción

`pnpm run build && pnpm run start` en `:8788` con CSP real (regla de §9.11/§10.3), con
Playwright y leyendo el `canvas_json` persistido por la API, no solo lo que se ve:

- Las nueve reglas de fecha, contrastadas contra lo que dice la **descripción del propio
  registro**: `19:30Z` → «Sábado 22 de agosto · 21:30 h» y `07:30Z` → 09:30, que es lo que
  ponen sus textos. Las madrugadas (`23:30 → 07:00` Madrid) salen como una sola noche, no
  como dos días.
- Composición real de tres eventos: orden del stack `fondo → velo → [cartel] → categoría →
  título → subtítulo → fecha → lugar → [píldora] → precio`, **cero solapes** (medidos par a
  par), todo dentro de la página, un solo fondo, sin `data:image` en el `canvas_json`.
- Campos ausentes: sin `direccion` el lugar sale solo con el municipio; con `precio:
  DE_PAGO` la píldora no se crea y el resto sube a ocupar su sitio.
- Modo cartel: 563×691 en (259, 80), la ficha empieza en y=851 — no se pisan; proporción del
  bitmap conservada (0.814).
- Persistencia: tras recargar, el `canvas_json` es **idéntico**, con exactamente un cartel y
  un fondo (no se recompone ni se duplica).
- `Ctrl+Z` tras cambiar de modo, exportación **2160×2700** (2× de 1080×1350), y una noticia
  real abierta en paralelo: 1080×1080, imagen + titular, sin sección «Evento» ni bloques de
  evento. Sin errores de consola en ningún paso.

#### Límite conocido

Cuando el cartel de origen ya trae impresos el nombre, la fecha y el lugar —lo habitual—, la
ficha generada **repite** esa información. En modo cartel queda separada debajo, que es la
disposición normal de un post de agenda; a sangre queda encima y se nota. No hay forma fiable
de detectar «esta imagen ya lleva el texto», así que la decisión es editorial: el conmutador
de modo y el borrado manual de un bloque son la salida. Si acabara siendo molesto, lo natural
sería un tercer modo «solo cartel» que dejara únicamente la franja de datos que el cartel no
da (o ninguna).


### 9.27 Los tres formatos, los dos temas de marca y el campo Imagen Story

Cuatro cambios pedidos sobre la plantilla de §9.26: que los tres presets de tamaño sean
utilizables de verdad, que el formato vertical vaya a su propio campo del CRM, que haya dos
temas de color con la paleta de la marca, y que la etiqueta de precio sea más pequeña.

#### La plantilla se re-apila al cambiar de tamaño

`relayoutEventTemplate` (en `event-template.ts`) recoloca los bloques que ya existen contra
el nuevo borde inferior, sin volver a pedir nada a Twenty ni tocar los textos. Los cuerpos
de letra van en proporción al **ancho** y los tres presets miden 1080 de ancho, así que lo
único que cambia de verdad es el anclaje vertical y cuánto sitio hay.

El titular se devuelve a su cuerpo nominal antes de re-ajustarlo: `fitToLines` solo sabe
encoger, así que sin ese reinicio cada cambio de tamaño lo dejaría un poco más pequeño que
el anterior, sin vuelta atrás.

`setCanvasSize` (`use-canvas.ts`) hace además dos cosas que antes no hacía: **reencaja el
fondo** —estaba ajustado contra la página anterior, y al pasar de cuadrado a historia se
quedaría cubriendo poco más de la mitad— y llama a este re-apilado.

#### Dos bugs que solo aparecieron al probarlo

- **El tamaño no se persistía.** `saveDesign` solo mandaba `canvas_json`; el `width`/`height`
  del diseño no se actualizaba nunca, así que al recargar volvía el formato original con la
  maqueta del nuevo. Ahora `useDesigns` recibe un `getCanvasSize` y lo envía (el endpoint
  `PUT /api/designs/:id` ya aceptaba ambos campos).
  **Y ese getter tiene que leer de un ref, no del estado**: lo consume el guardado
  *diferido*, de modo que quien llama a `scheduleSave()` justo después de cambiar de tamaño
  estaría usando todavía el callback del render anterior — a los 2 s se guardaba el tamaño
  viejo. Es el mismo tipo de fallo que §9.26 arregló en `page-canvas.tsx`, por otra puerta.
- **La píldora de precio se colocaba encima de su texto al re-apilar.** El z-order se
  calculaba con `moveObjectTo(backdrop, indexOf(texto))`, que funciona cuando el par se
  acaba de insertar pero no cuando ya venía colocado de un `loadFromJSON`: ahí dejaba el
  rectángulo tapando la palabra. Ahora se suben los dos al frente en orden, que es exacto en
  ambos casos (los bloques no se solapan entre sí, y el logo se recoloca al final).

#### El formato vertical va a "Imagen Story"

Comprobado por MCP: `eventCustom` tiene `imagenStory` además de `imagenEditada`; **`news`
no lo tiene**. Así que `TwentyObjectDef` gana un `storyImageField` opcional y
`setRecordEditedImage` recibe un `target` (`"feed" | "story"`) y **devuelve el campo que ha
escrito**. Si se pide historia sobre un objeto que no la tiene, cae al campo de siempre en
lugar de fallar — perder el trabajo por un campo que falta en el CRM sería peor.

El cliente decide el destino por la proporción del lienzo (`height >= width * 1.7`), que
separa con holgura los tres presets: 1080×1920 da 1.78 y el siguiente más alto, 1080×1350,
se queda en 1.25. El toolbar muestra en qué campo ha escrito, porque con tres formatos
disponibles esa es la única señal que distingue una subida correcta de haber exportado el
formato equivocado.

#### Dos temas con la paleta de El Faro

Azul noche `#0a2540`, ámbar `#f4a825` y crema `#fbf7f0`.

|  | tinta clara (foto oscura) | tinta oscura (foto clara) |
|---|---|---|
| titular, fecha | crema | azul noche |
| categoría | ámbar | azul noche |
| píldora | ámbar sobre azul noche | ámbar sobre azul noche |
| separación del fondo | sombra azul noche, desplazada | halo crema, sin desplazar |
| velo | oscuro | claro |
| brillo del fondo | se oscurece | se aclara |

No son "el mismo diseño en otro color": lo que cambia es de qué lado está el contraste. Con
tinta oscura, la sombra que separa el texto de la foto desaparece y hace falta lo contrario,
un halo claro; y el velo tiene que ir en el mismo sentido, o el tema oscuro pintaría letras
azul noche sobre una foto que acabamos de ennegrecer. Por eso `applyScrim` acepta ahora un
**tono** (`ScrimTone`, con `_scrimTone` registrado en `customProperties`) y `setScrim`
conserva el que hubiera puesto el tema: tocar la intensidad del velo desde el panel Bg no
debe devolverlo a oscuro y arruinar un diseño de tinta oscura.

El ámbar sobrevive en los dos temas pero de forma distinta: como **texto** solo funciona
sobre fondo oscuro (sobre crema se queda en ~2.5:1), así que en el tema oscuro se retira del
rótulo de categoría y se queda donde sí rinde, la píldora — un bloque sólido con texto azul
noche encima, que es un contraste holgado.

Como el modo, el tema se **deduce** del lienzo (`_tplTheme`) en vez de guardarse aparte.

#### Verificado contra el build de producción

`:8788` con CSP real, con Playwright y leyendo tanto el `canvas_json` persistido como el
registro en Twenty:

- Los tres formatos: 1080×1350 → 1080×1920 → 1080×1080, con el **margen inferior exacto de
  80 px en los tres** y cero solapes; el tamaño persiste en el diseño y el orden del stack
  se mantiene `… → priceBg → price`.
- Los dos temas: colores, dirección de la sombra (`offsetY 5` con sombra azul noche frente a
  `offsetY 0` con halo crema) y tono del velo (`rgba(0,0,0,.8)` frente a
  `rgba(251,247,240,.8)`) cambian los dos a la vez.
- Destino de publicación contra el Twenty real: 1080×1920 escribe en **`imagenStory`** y
  1080×1350 en **`imagenEditada`**, confirmado leyendo el registro de vuelta. Las dos
  escrituras de prueba revertidas a vacío después.
- Precio a 27 px (antes 34), sin errores de consola en ningún paso.

**El subtítulo sale solo del campo `subtitulo`.** Se probó a deducirlo del trozo que
hubiera detrás del separador del nombre o de la primera frase de `descripcion`, y las dos
fuentes se descartaron por lo mismo: son adivinanzas. La descripción está redactada para la
ficha web, no para un post, y lo que salía de ahí había que reescribirlo casi siempre. Si
nadie lo ha escrito en el CRM, **no hay subtítulo** y el bloque no se crea — que es
exactamente lo que la plantilla ya sabe hacer con cualquier campo vacío.

El nombre se sigue partiendo por el separador (`|`, guión suelto) para quedarse con la
parte de delante como titular: uno con `|` dentro no se lee bien a cuerpo grande. Lo de
detrás simplemente se descarta.

Como `descripcion` ya no la usa nadie, se dejó de pedir a Twenty: una llamada más ligera y
un campo menos que mantener en el tipo.


### 9.28 Plantilla de noticias (opcional)

> **Al día en §9.29**, que rediseñó tres cosas de esta sección: la franja pasó de sólida a
> translúcida con la foto desenfocada detrás, el chip bajó de 38 a 30 px y el formato por
> defecto de una noticia pasó a 1080×1350. Lo demás sigue tal cual se describe aquí.

Las noticias tenían el trato de siempre: foto a sangre y el titular como un cuadro de texto
suelto encima, que había que colocar, dimensionar y hacer legible a mano en cada post (velo,
sombra, «Mejorar titular»). Ahora hay una plantilla que hace ese trabajo de una vez, con un
diseño distinto al de los eventos y ya definido por el usuario: **foto arriba, franja de color
sólido abajo** con el chip de sección, el titular y el pie. El titular no puede superponerse a
la foto, así que ese trabajo de legibilidad desaparece.

**Es opcional, no automática**: abrir una noticia deja la página exactamente como siempre
—foto a sangre y el titular como cuadro de texto suelto— y la plantilla se pone y se quita
desde la sección «Noticia» del panel izquierdo. Es la diferencia deliberada con los eventos,
donde sí se compone sola. Los eventos no se tocan.

#### Lo que dicen los datos reales de `news` (verificado por MCP, 658 registros)

- **`categoria` es un enum de cuatro valores** —`ACTUALIDAD`, `DEPORTE`, `CULTURA`,
  `EDUCACION`— y a veces llega `null` (187 registros). Consecuencia directa: **no existe una
  sección «Sucesos»**, así que el rojo `#b3261e` de la guía de marca no tiene ningún valor al
  que aplicarse y se deja fuera.
- **Los titulares son largos de verdad**: 95-100 caracteres es lo normal. Eso es lo que
  decide las dos piezas más delicadas del diseño, la tipografía y el alto de la franja.
- `publicarEn` está casi siempre vacío, y el pie no lleva fecha (decisión del usuario: solo
  `@elfarodealicante`), así que no hay ninguna regla de zona horaria que mantener aquí.
- `news` **no tiene `imagenStory`**: una noticia en 1080×1920 cae a `imagenEditada`, que es
  lo que ya hacía `setRecordEditedImage` (§9.27) — no hizo falta tocar nada.

#### Barlow Condensed, un activo nuevo

`public/fonts/Barlow-Condensed/{400,500}.woff2` (subset latin, OFL, mismo camino que las 36
caras anteriores) + sus `@font-face` y la familia en `FONT_FAMILIES`, así que también está en
el desplegable del panel derecho.

No es un capricho de la guía: un titular de 98 caracteres en 952 px no entra en 3 líneas a
66 px con Inter o Montserrat (≈28 caracteres por línea) y sí con una condensada (≈34). Solo
los dos pesos que el diseño admite, regular y medio.

#### La franja se dimensiona a partir del contenido

El diseño fija la franja en el 62 % de la altura, el titular entre 96 y 66 px y un máximo de
3 líneas. Con los titulares reales las tres condiciones no siempre caben a la vez, y el
usuario eligió qué cede: **la franja crece hacia arriba**.

`layout()` (en [`lib/news-template.ts`](src/client/lib/news-template.ts)) lo resuelve en este
orden, que es lo que hace que la regla innegociable se cumpla por construcción:

1. Se mide todo lo que no es el titular (chip, cifra, línea, pie) y sus separaciones.
2. `fitHeadline` elige el **mayor** cuerpo entre 96 y 66 px que quepa en 3 líneas *y* en el
   hueco que deja la franja en su posición nominal. Las dos condiciones hacen falta: solo con
   "≤ 3 líneas", un titular corto se quedaría a 96 px empujando la franja muy por encima del
   62 %; solo con el hueco, uno largo se partiría en cinco líneas.
3. El contenido se ancla **por abajo** (el pie clavado a 48 px del borde) y la franja se
   calcula **después**, a partir de lo que ha ocupado: `bandTop = min(62 %, arriba del
   contenido − 64)`.
4. La foto se encaja en lo que queda: cover sobre la banda superior, centrada en horizontal y
   **anclada al tercio alto** (`PHOTO_ANCHOR = 0.25`, se descarta el 75 % del excedente por
   abajo), que es lo que salva las cabezas en una foto de prensa.

Medido: un titular de 63 caracteres deja la franja en el 62,0 % exacto con el titular a
82 px; uno de 98 la sube al 59,5 % con el titular a 66 px y 3 líneas. En los dos, margen
inferior de 48,0 px y ningún bloque por encima del borde de la franja.

#### Marca propia `_nwRole`, no la `_tplRole` de los eventos

Reutilizar la marca de la plantilla de eventos habría sido un bug garantizado:
`relayoutEventTemplate` corre sobre **todos** los lienzos desde `setCanvasSize` y le basta
encontrar un objeto con `_tplRole: "title"` para re-apilar la página como si fuera un evento.
Con propiedades distintas las dos plantillas no pueden interferir, y el registro clase por
clase repite el mismo cuidado que documenta §9.26 (`Rect` declara su propia
`customProperties` y **tapa** la de la clase base).

#### El z-order es un tramo contiguo encima de la foto, no un "subir al frente"

La franja es opaca, así que el orden importa más que en la plantilla de eventos. Los bloques
se mueven a posiciones consecutivas **justo encima de la foto** (`moveObjectTo`) en vez de
subirlos al frente: subirlos dejaría cualquier objeto que el operador haya añadido a mano por
*debajo* de la franja, y su trabajo desaparecería al cambiar de formato. Así lo añadido a
mano se queda arriba, que es lo que cualquiera espera.

#### El logo se deduce de la franja (y se mide por su parte opaca)

El diseño quiere la marca arriba a la izquierda, a 48 px de los dos bordes y con 66 px de
alto; hoy iba arriba a la derecha. No se puede resolver recolocándola desde la plantilla: la
capa del logo **no se persiste** (`withoutLogo` la saca de todo lo que se serializa) y
`applyLogoToCanvas` la reconstruye desde cero al abrir la página y en cada cambio de tamaño.

Por eso `positionLogo` **deduce** la colocación de si el lienzo tiene un objeto con
`_nwRole === "band"` — la franja sí viaja en el `canvas_json`, así que sobrevive a recargar
sin guardar nada nuevo. Se lee la propiedad a pelo y no se importa `news-template.ts`, que
importa `logo.ts` y sería un ciclo.

**Y hubo que medir el logo.** `public/logo.png` es un lienzo de 500×500 en el que el faro
ocupa 197×324 descentrado, así que pedir 66 px al objeto dejaba el faro en 43 px: en la
primera prueba era una mancha ilegible en la esquina. `measureOpaqueBounds` mide una vez por
sesión la parte no transparente y escala y desplaza a partir de ella, de modo que los 66 px y
el margen de 48 px son los del dibujo. Se mide en vez de anotar los números a mano para que
siga siendo cierto lo que promete `logo.ts`: cambiar el logo es sustituir el archivo.

La sombra suave del logo se pone **siempre** en esta colocación en vez de solo sobre fotos
claras. Medir la luminancia de esa esquina es posible (el lienzo no está *tainted*, para eso
existe el proxy de imágenes) pero añade un caso que se puede equivocar, y una sombra suave
bajo una marca crema sobre foto oscura no se ve.

#### Las dos variantes, y la única combinación prohibida

|  | navy (por defecto) | crema |
|---|---|---|
| franja | `#0a2540` | `#fbf7f0` |
| titular, pie | `#fbf7f0` | `#0a2540` |
| chip | ámbar con texto navy | navy con texto crema |
| cifra | `#f4a825` | `#0a2540` |

La regla que las gobierna es que **ámbar y crema nunca se tocan** (sobre crema el ámbar se
queda en ~2.5:1), así que en la variante clara el ámbar desaparece del todo y su papel lo hace
el azul noche.

Cambiar de variante **recolorea lo que ya hay, no recompone**: recomponer volvería a pedir el
registro a Twenty y descartaría los retoques manuales sobre los textos, que es un precio
absurdo por cambiar dos colores. Como el modo de los eventos, la variante se deduce del
lienzo (`_nwVariant`).

#### El dato destacado

La cifra grande no existe como campo en Twenty —los titulares sí traen cifras, pero
extraerlas dejaría el número dos veces y la unidad habría que adivinarla—, así que la escribe
el operador en dos casillas del panel. Vacías, el bloque no se crea y el titular sube. Se leen
de vuelta del lienzo al abrir el panel, para no tener el mismo dato en dos sitios que puedan
contradecirse. Confirman al perder el foco o con **Enter**.

#### Dónde se engancha

- **`page-canvas.tsx` no cambia de comportamiento**: una noticia en blanco sigue recibiendo
  el titular como cuadro de texto suelto. Lo único nuevo es que ese titular va **marcado**
  (`_isRecordTitle`), y ahí está la razón de la marca: al pulsar "Aplicar plantilla" hay que
  retirarlo, o se quedaría flotando sobre la foto duplicando el titular que la plantilla
  pinta en la franja. Es una marca aparte de `_nwRole` a propósito —si no, `hasNewsTemplate`
  diría que hay plantilla en una página que solo tiene el titular suelto— y **lo que el
  operador añade a mano no lleva ninguna marca, así que no se toca nunca** (verificado: un
  texto propio sobrevive a aplicar la plantilla y se queda por encima de la franja).
- **Aplicar la plantilla es una acción del operador, así que deja una entrada de historial**
  (no se sella nada, al contrario que la composición automática de los eventos): un solo
  `Ctrl+Z` devuelve exactamente lo que había antes del clic.
- **La foto se re-encaja a la banda en los cuatro sitios donde puede volver a la página
  entera**: el refresco desde Twenty de cada apertura, `setCanvasSize`, `setBackgroundImageFit`
  (Cover/Contain) y `setBackground` (subir otra foto). Si falta cualquiera, la foto se mete
  por debajo de la franja — el mismo patrón de §9.18, otra vez.
- **`DEFAULT_CANVAS_SIZE.news` se quedó en 1080×1080** mientras la plantilla fue solo una
  opción entre otras. **Revertido en §9.29**: hoy una noticia nace en 1080×1350, igual que un
  evento. El formato se sigue cambiando desde el toolbar y la plantilla se re-maqueta sola.
- **`revertNewsTemplate`** es el botón de vuelta: borra lo marcado, devuelve la foto a cover
  de página completa, la marca a su esquina y el titular a un cuadro de texto — exactamente
  el estado con el que nace una noticia. Una entrada de historial, así que `Ctrl+Z` devuelve
  la plantilla.

#### Verificado contra el build de producción

`:8788` con CSP real (regla de §9.11/§10.3), con Playwright, leyendo el `canvas_json`
persistido por la API y mirando los PNG exportados, no solo lo que se ve en pantalla:

- **Al abrir una noticia no se compone nada**: foto + un solo cuadro de texto con el titular,
  a 1080×1080, como siempre. Aplicar → plantilla y el titular automático retirado (cero
  textos sueltos). Volver → el titular otra vez. Aplicar de nuevo → **sin duplicados**.
  `Ctrl+Z` deshace la aplicación entera de una vez.
- Cuatro noticias reales de distinta longitud: cero solapes (medidos par a par), `x = 64` en
  todos los bloques, margen inferior 48,0 px exacto y ningún bloque por encima del borde de la
  franja.
- Sin sección y sin foto (`0ac8e6b8`): el chip no se crea, el titular sube a ocupar su sitio y
  el lienzo queda en azul de marca en vez de blanco.
- Las dos variantes cambian franja, chip, titular, línea y pie a la vez.
- La cifra se pone y se quita: al quitarla el titular vuelve a subir (franja del 46,7 % al
  59,5 %) y los dos bloques desaparecen del `canvas_json`.
- Los tres formatos: 1080×1350 → 1080×1920 (franja al 62,0 %, titular a 82 px) → 1080×1080
  (franja al 49,4 %), con la foto re-encajada a cada banda y el margen inferior siempre en 48.
- Revertir deja foto 2400×1350 a cover + un `Textbox`, y `Ctrl+Z` devuelve la plantilla entera.
- Persistencia: con la plantilla aplicada y guardada, abrir dos veces da un `canvas_json`
  **idéntico**, con una sola franja, una sola foto y un solo titular, y sin `data:image`.
- Barlow Condensed 400 y 500 llegan a `loaded`.
- "Guardar en Twenty" completa y escribe en `imagenEditada` (`target=feed`); la escritura de
  prueba se revirtió a su valor anterior.
- Sin regresión: un evento abierto en paralelo mantiene su sección, su plantilla y su modo
  cartel (624×766, proporción 0.814, sin pisar la ficha) y no aparece ninguna marca `_nwRole`;
  un diseño normal sin CRM sigue con el logo arriba a la derecha y sin sección «Noticia».
- Sin errores de consola en ningún paso.

#### Límites conocidos

- **El rojo `#b3261e` queda sin usar** — el enum no tiene «Sucesos». Si algún día se añade, es
  una entrada en `SECTION_LABELS` y otra en la tabla de colores del chip.
- **«Mejorar foto»** (panel Bg) sigue disponible con la plantilla puesta y añadiría velo y
  filtros a la fotografía, que es justo lo que este diseño prohíbe. No se bloquea —es decisión
  del operador— pero conviene saberlo.
- **Re-encajar la foto a la banda descarta un reencuadre manual** al cambiar de formato, igual
  que ya ocurría con el fondo de página completa: ese encuadre describía una banda que ya no
  existe.
- **`@elfarodealicante` es una constante del código**, no un campo del CRM; el cuadro de texto
  es editable en el lienzo como cualquier otro.

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

### 9.29 Franja translúcida, portrait por defecto y muestras de color

> **Superado en parte por §9.30**: la franja translúcida que describe esta sección duró un
> día. El usuario la vio y pidió quitar el color del todo —"la imagen difuminada sin más, sin
> azul ni nada por el estilo"— así que el bloque de color desapareció y la legibilidad se
> resolvió de otra manera. Lo que **sigue vigente** de aquí: el formato portrait por defecto,
> las muestras de color de los selectores, el chip a 30 px y la mecánica de la capa `glass`
> (cómo se construye, por qué es síncrona y por qué necesita `_srcUrl`). Lo que **ya no**: la
> opacidad de la franja y su deslizador, el `Palette.band`, y la geometría del cristal, que en
> §9.30 pasa a ser la misma que la de la foto.

Tres peticiones sobre lo que dejó §9.28.

#### El formato por defecto pasa a 1080×1350

`DEFAULT_CANVAS_SIZE.news` y el `POST /api/designs` del diseño en blanco (y el `DEFAULT` de
[`schema.sql`](src/server/schema.sql), que solo importa en una base nueva). §9.28 había dejado
el cuadrado a propósito, argumentando que la plantilla no se aplica sola; el usuario prefiere
lo contrario, y el 4:5 es el formato que más pantalla ocupa en el feed. **Solo afecta a
diseños nuevos**: los borradores ya guardados conservan su tamaño (verificado).

#### La franja deja de ser opaca: cristal esmerilado

El bloque de color donde vive el titular ahora deja ver la foto por detrás, desenfocada. Esto
tumba la premisa con la que se escribió §9.28 —«el texto vive en su propia franja opaca, así
que la fotografía se queda intacta»— pero **no** la regla que la sostenía: la fotografía sigue
sin filtros ni velos. Lo que se desenfoca es **una copia suya**, no ella.

**La capa `glass`** (`_nwRole: "glass"`, en
[`lib/news-template.ts`](src/client/lib/news-template.ts)) es una segunda imagen con el mismo
bitmap, un filtro `Blur(0.3)` —el mismo valor con el que la plantilla de eventos difumina el
fondo de su modo cartel— y un `clipPath` del tamaño exacto de la franja.

- **Se construye síncrona, desde `_originalElement`, no con `clone()`.** El cartel de los
  eventos usa `clone()`, que es asíncrono, y por eso `refreshPosterImage` tiene que llamarse a
  mano desde `page-canvas.tsx`. Aquí no: al ser síncrona cabe **dentro de `layout()`**, y
  `layout()` es el punto por el que ya pasan las cinco rutas que mueven la franja o cambian la
  foto (composición, `relayoutNewsTemplate` desde el refresco de Twenty, `setCanvasSize`,
  Cover/Contain y subir otra foto). Cero sitios nuevos que acordarse de tocar — que es
  exactamente el error que §9.18 costó encontrar cuatro veces.
- **`_srcUrl` es obligatorio.** Construir una `FabricImage` desde un elemento hace que
  `getSrc()` incruste el bitmap entero en base64 al serializar; el override de
  [`background.ts`](src/client/lib/background.ts) devuelve la URL solo si esa propiedad está
  puesta. Verificado: el `canvas_json` con plantilla son 7.791 bytes y no contiene `data:image`.
- **`_nwRole` hay que registrarlo también en `fabric.FabricImage`**, y el orden importa:
  `background.ts` *sobrescribe* `FabricImage.customProperties` con un array literal, así que el
  bucle de `news-template.ts` tiene que evaluarse después — lo garantiza el `import` de
  `background.ts` que ya había arriba (un módulo importado se evalúa antes que quien lo importa).
- **Geometría: misma escala y mismo `left` que la foto, anclada al borde inferior.** Así la
  franja enseña la continuación de la misma fotografía, al mismo zoom y encuadre, en vez de un
  recorte a otra escala que se leería como una segunda imagen. `fitPhotoToBand` deja siempre la
  foto con al menos el alto de la banda superior, que es mayor que el de la franja, así que
  cubre; hay un `max` para el caso degenerado.
- **Solo se re-filtra cuando cambia la foto.** Desenfocar un bitmap de 4096 px es lo caro de
  todo esto y mover la franja no lo necesita: si el `_srcUrl` coincide, se recolocan escala,
  posición y recorte y nada más.
- **Sin foto no hay cristal**: se elimina, en vez de dejar congelada la última imagen que hubo.

Además, el *fallback legacy* de `findBackgroundImage` (el que cubre los diseños guardados antes
de que el marcador se serializara) ahora **ignora las imágenes de plantilla** (`_nwRole` o
`_tplRole`). Sin eso podría devolver el cristal —o el cartel de un evento— y el refresco desde
Twenty sustituiría esa imagen en lugar de la fotografía.

**La opacidad es un deslizador del panel «Noticia»**, no una constante: 82 % por defecto en
navy y 86 % en crema. La variante clara necesita más cuerpo porque debajo hay una fotografía
que normalmente es más oscura que el crema. Como el modo y la variante, **se deduce del
lienzo** (del alfa del relleno de la franja, con el mismo `match` de `rgba(...)` que usa
`readScrim`) en vez de guardarse aparte. `applyNewsVariant` la conserva al cambiar de variante
—mismo criterio que `setScrim` con el tono del velo (§9.27)— salvo que siguiera en el valor por
defecto de la que deja, en cuyo caso adopta el de la nueva. Arrastrar el control repinta en
vivo; el historial y el guardado solo se escriben al soltar (`commit`).

**El chip baja de 38 a 30 px** (y sus márgenes con él): a 38 competía con el titular.

#### Muestras de color en los ocho selectores

[`lib/palette.ts`](src/client/lib/palette.ts) (nuevo) concentra los colores de marca —que
estaban duplicados como constantes locales en las dos plantillas— y añade la lista de muestras.
[`components/color-field.tsx`](src/client/components/color-field.tsx) (nuevo) sustituye el
bloque `input[type=color]` + campo hexadecimal repetido ocho veces y le cuelga la fila de
muestras: azul noche, ámbar, crema, blanco, negro y tres colores de marcado con la saturación
apagada del navy —rojo `#b3261e` (el que §9.28 dejó sin usar al no existir la sección
«Sucesos»), verde `#1e7d4f` y azul `#2f6d9e`.

Las muestras hacen **`preventDefault` en `onMouseDown` siempre**, lo pase o no el llamante: sin
eso, pulsar una saca al `Textbox` de edición y el color se aplicaría al cuadro entero en vez de
a la palabra seleccionada (§9.21). La primera fila de `BG_COLORS` del panel Bg son ahora los
colores de marca.

#### Verificado contra el build de producción

`pnpm run build` + `pnpm run start` en `:8788` con la CSP real (regla de §9.11/§10.3), con
Playwright, leyendo el `canvas_json` persistido por la API y midiendo píxeles del lienzo. Sobre
una copia aparte de la base de datos, no la del repo; **ninguna prueba escribió en Twenty**.

- **Portrait**: una noticia nueva nace en 1080×1350.
- **Cristal**: un solo objeto `glass` con `filters:[{Blur,0.3}]`, `clipPath` exactamente igual a
  la franja (`top=816 h=534`), misma escala que la foto (1.2089) y sin `data:image` en el JSON.
  La franja se pinta con `rgba(10,37,64,0.82)`.
- **La foto de arriba NO se contamina** (era el riesgo de compartir `_originalElement`): energía
  de bordes 13,23 en la zona alta de la foto frente a 0,55 en la franja limpia; y la franja mide
  55,2 de luminancia frente a los 33,2 del navy puro, o sea que la foto **sí** se ve a través.
- **Los tres formatos** (1350 → 1920 → 1080 → 1350): un solo cristal, siempre recortado a la
  franja vigente, foto reencajada, margen inferior de 48,0 px exacto, cero solapes medidos par a
  par, y volver al formato de partida reproduce la maqueta original.
- **Opacidad y variante**: el panel lee el 82 % del lienzo; bajar al 60 % deja
  `rgba(10,37,64,0.6)`; pasar a Crema lo conserva (`rgba(251,247,240,0.6)`); desde el valor por
  defecto, cambiar de variante sí adopta el nuevo (0.82 ↔ 0.86).
- **Ciclo completo**: aplicar → rehacer → volver al diseño normal, sin duplicados y sin tocar un
  texto añadido a mano. Un solo `Ctrl+Z` (o el botón) quita la plantilla entera, cristal
  incluido, y rehacer la devuelve.
- **Persistencia**: dos aperturas seguidas dan un `canvas_json` **idéntico** (una franja, un
  cristal, un titular, una foto). Exportación 2160×2700.
- **Muestra sobre una palabra**: con «tormentas» seleccionada dentro del titular, la muestra
  ámbar deja `styles:[{start:4,end:13,{fill:"#f4a825"}}]` y el `fill` del cuadro intacto.
- **Casos límite**: sin foto ni sección, no se crea cristal ni chip, el lienzo queda en azul de
  marca y la franja en el 62,0 %.
- **Sin regresión**: un evento abierto en paralelo conserva sus `_tplRole`, su velo y su tema, y
  no aparece ni un `_nwRole` en su lienzo.
- Cero errores de consola en todos los pasos.

#### Límites conocidos

- **El cristal duplica el bitmap de la foto en memoria** mientras la plantilla está puesta (el
  original y su copia desenfocada). Ambos van reducidos a 4096 px como mucho (§9.18), así que en
  la práctica es asumible, pero es el coste de este diseño frente a la franja opaca.
- **Con la opacidad muy baja** (el suelo del deslizador es el 50 %) el titular puede perder
  contraste sobre una foto clara. Es decisión del operador; el suelo existe para que no se pueda
  dejar ilegible del todo.
- Sigue vigente lo que §9.28 anotaba de **«Mejorar foto»**: añadiría velo y filtros a la
  fotografía, que es justo lo que este diseño evita al desenfocar solo la copia.


### 9.30 Sin corte y sin color: una sola foto, difuminada hacia abajo

Petición del usuario sobre la franja translúcida de §9.29: «que no parezca que haya un corte,
quiero la imagen difuminada sin más, sin color azul ni nada por el estilo, y que halles la
manera entonces de que las letras resalten».

Son dos problemas encadenados, y el segundo solo existe por culpa de resolver el primero.

#### Por qué había un corte, y qué lo quita

En §9.29 la copia desenfocada era **otro recorte de la misma foto**: la original se encajaba
contra la banda superior y el cristal se anclaba al borde inferior. Aunque las dos usaran la
misma escala, enseñaban trozos distintos de la fotografía, así que en el borde se veía un
salto — y encima el rectángulo de color remataba la línea.

Ahora hay **una sola imagen a página completa**, y el cristal tiene *exactamente su misma
transformación*: misma escala, mismo `left`, mismo `top`. Encima de cada píxel de la foto está
el mismo píxel, solo que desenfocado. Lo único que los separa es la máscara.

**La máscara es una imagen, y ahí está el truco.** Fabric dibuja un `clipPath` con
`drawObject(ctx, forClipping = true)`, y ese método **fuerza el relleno a negro opaco**
(`_setClippingProperties`), de modo que un degradado en el `fill` de un `Rect` se pierde y la
máscara sale opaca de borde a borde — un corte otra vez. Una `FabricImage`, en cambio, se pinta
con `drawImage` y **conserva el alfa de sus propios píxeles**; y como el recorte se aplica con
`globalCompositeOperation = 'destination-in'`, ese alfa se traduce en transparencia real. Así
que `fadeMask` genera un canvas de 1×512 con un degradado vertical de alfa y lo usa de
`clipPath`: el desenfoque no *empieza* en ninguna línea, va apareciendo a lo largo de 135 px
(el 10 % de la altura, `FADE_RATIO`) mezclándose con la foto nítida que tiene debajo.

Medido sobre los píxeles pintados, la energía de bordes por fila baja de forma continua
(12,6 → 5,2 → 4,6 → 1,2) en vez de caer de golpe. El único salto brusco que queda en toda la
página está dentro del titular, que es texto.

**Consecuencia en el encuadre**: la foto pasa de encajarse contra la banda superior a
`fitPhotoToPage` (cover de la página entera, con el mismo `PHOTO_ANCHOR = 0.25` que salva las
cabezas). Está más recortada que antes; es el precio de que la mitad de abajo sea la
continuación real de la de arriba y no un segundo encuadre.

#### Y entonces, ¿qué hace legible el titular?

Sin bloque de color, tres cosas a la vez, y ninguna de ellas es un velo:

1. **El desenfoque, que es la principal.** Lo que estorba a la lectura no es el brillo del
   fondo sino su **detalle**; un desenfoque fuerte lo elimina sin tocar el color de la foto. El
   valor por defecto sube de 0.3 a **0.45** y el deslizador del panel llega a 0.8.
2. **El peso de la letra.** Barlow Condensed solo tenía 400 y 500 autoalojados; se añadió el
   **600** (`public/fonts/Barlow-Condensed/600.woff2`, subset latin, mismo camino que las 38
   caras anteriores) y el titular y la cifra pasan a usarlo. A 500 el titular se deshacía sobre
   cualquier fondo con textura.
3. **Una sombra bajo la tinta** (`inkShadow`), proporcional al cuerpo. El chip es la excepción:
   va sobre su propia píldora opaca y una sombra ahí solo le ensuciaría el borde.

**La tinta la elige la propia fotografía.** `chooseInk` mide la luminancia media del bitmap
original —no del cristal: el desenfoque no cambia la media, y el original está disponible
siempre— en la franja que cae bajo el texto, a resolución mínima (un `drawImage` a 24×12).
Por encima de 165 pasa a tinta oscura. **El umbral está alto a propósito porque las dos tintas
no son simétricas**: la crema con sombra oscura aguanta un fondo medio mucho mejor que el azul
noche con halo claro. Leer píxeles exige que el lienzo no esté *tainted*, cosa que se cumple
porque la foto llega por el proxy (§9.3); si aun así lanzara, se cae a tinta clara.

En cuanto el operador toca los botones de tinta, manda él — también al rehacer la plantilla.

#### Lo que cambia de nombre sin cambiar de clave

- Las variantes siguen llamándose `navy` y `cream` en el `canvas_json` (están grabadas en los
  borradores guardados) pero ya no son "franja azul / franja crema": son **tinta clara** y
  **tinta oscura**, y así las llama el panel. Lo que cambian es de qué lado está el contraste,
  igual que los dos temas de la plantilla de eventos (§9.27).
- El rol `band` sobrevive **sin pintar nada** (`rgba(0,0,0,0)`): es el ancla de la maquetación y
  la señal por la que `logo.ts` coloca la marca arriba a la izquierda. Se fuerza transparente en
  cada pasada de `layout`, y eso es lo que **migra solos a los borradores** guardados cuando la
  franja sí era un bloque de color (verificado devolviendo un diseño a mano al formato anterior:
  al reabrirlo, franja transparente, cristal reconstruido y foto a página completa).
- El deslizador del panel deja de ser "Opacidad de la franja" y pasa a ser **"Desenfoque del
  fondo"**. Y ya no se aplica durante el arrastre sino **al soltar**: recolorear un rectángulo
  era barato, volver a filtrar el bitmap entero no lo es — el mismo criterio que los
  deslizadores de efectos del panel Bg (§9.14).
- Las opacidades de la tinta suben (0.72/0.22/0.68 → **0.9/0.45/0.88**). Las de la guía se
  eligieron contra un bloque de color liso; sobre una fotografía, aunque esté desenfocada, un
  texto al 68 % se deshace.

#### Una excepción a la regla de "nada de `data:image` en el JSON"

La máscara es un canvas generado, así que Fabric la serializa como data URL dentro de
`glass.clipPath`. Son **222 bytes** (un PNG de 1×512 en escala de grises) sobre un `canvas_json`
de 7,3 KB, y a cambio la máscara sobrevive a la recarga tal cual, sin un parpadeo sin recortar
entre `loadFromJSON` y el primer re-maquetado. Es la única data URL del documento: la foto y el
cristal siguen apuntando los dos a la URL del proxy.

#### Verificado contra el build de producción

`pnpm run build` + `pnpm run start` en `:8788` con la CSP real (regla de §9.11/§10.3), con
Playwright, sobre una copia aparte de la base de datos. **Ninguna prueba escribió en Twenty.**

- **Sin costura**: perfil de nitidez fila a fila continuo a través de toda la transición; el
  mayor salto de la página cae dentro del titular. Comprobado en dos fotos de carácter opuesto
  (un interior de estadio y un eclipse).
- **Foto y cristal alineados** (`scaleX`, `left` y `top` idénticos) y la foto cubriendo la
  página entera, en los tres formatos.
- **Legibilidad medida, no supuesta**: contraste del trazo del titular contra su fondo
  inmediato en cuatro noticias reales — **7,3 / 14,4 / 14,4 / 18,3 : 1**, todas por encima del
  4,5:1 de WCAG AA. La más ajustada es la de fondo más claro, y aun así sobra.
- **Tinta**: las cuatro eligieron clara sola; forzando la oscura, el titular pasa a azul noche
  con halo crema (`offsetY 0`) y el chip se invierte, todo a la vez.
- **Desenfoque**: el panel lee 0.45 del lienzo, subirlo al 75 % deja un solo cristal con
  `Blur(0.75)`, y volver a 0.45 lo reconstruye.
- **Los tres formatos** (1350 → 1920 → 1080 → 1350): máscara recolocada, foto reencajada,
  margen inferior de 48,0 px exacto, y volver al de partida reproduce la maqueta original.
- **Migración** de un borrador devuelto a mano al formato de §9.29, **ciclo** aplicar → rehacer
  → volver al diseño normal sin duplicados y sin tocar un texto añadido a mano, **undo/redo** de
  la plantilla entera de una vez, **persistencia** idéntica entre dos aperturas, exportación
  **2160×2700**, y **Barlow Condensed 400/500/600** los tres en `loaded`.
- **Sin foto**: no se crea cristal ni chip, el lienzo queda en azul de marca y el titular sale
  en crema a peso 600 con su sombra.
- **Sin regresión**: un evento conserva sus `_tplRole`, su velo y su tema, y no aparece ni un
  `_nwRole` en su lienzo.
- Cero errores de consola en todos los pasos.

#### Límites conocidos

- **El encuadre de la foto está más cerrado** que en §9.28/§9.29, porque ahora tiene que cubrir
  la página entera y no solo la banda superior. Se puede reencuadrar a mano como cualquier
  fondo, pero un cambio de formato lo descarta (lo de siempre).
- **`chooseInk` mide una media.** Una foto cuya mitad inferior sea mitad cielo y mitad sombra
  puede elegir mal; para eso están los dos botones.
- El cristal sigue **duplicando el bitmap en memoria** mientras la plantilla está puesta, con el
  añadido de que ahora se refiltra cada vez que se mueve el deslizador de desenfoque.
- Sigue vigente lo que anotaba §9.28 de **«Mejorar foto»**: añadiría velo y filtros a la
  fotografía, que es justo lo que este diseño evita.
