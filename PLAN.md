# Plan de proyecto — Editor de imágenes para publicaciones de Instagram (fork de open-design)

> Documento de arranque para desarrollar con Claude Code en VS Code.
> Base: fork de [`clawnify/open-design`](https://github.com/clawnify/open-design) (Preact + Fabric.js v6 + Tailwind + Hono + SQLite, MIT).

---

## 1. Objetivo

Adaptar open-design a un **editor interno de composición de imágenes** para las publicaciones que ya se gestionan en **Twenty CRM**. El operador abre el editor desde una publicación, la imagen se carga con el **logo ya fijado en la esquina superior derecha**, escribe el texto (pudiendo **resaltar una palabra en negrita**), lo coloca, y al guardar el PNG final vuelve a Twenty; **n8n** lo recoge y publica en Instagram (reutilizando el flujo de historias ya existente, extendido a posts de feed).

Humano en el bucle por diseño: el texto y el énfasis cambian en cada publicación y requieren criterio; se automatiza todo lo demás.

## 2. Contexto y restricciones

- **VPS compartido** (~8 GB RAM) donde ya corren Twenty + n8n (~3 GB en uso). El editor **no puede** añadir carga pesada.
  - Exportación de PNG **siempre en cliente** (canvas), nunca render headless / Puppeteer en el servidor.
  - Base de datos: mantener **SQLite** (la de open-design), no introducir MongoDB ni servicios extra.
- **Seguridad / datos**: el CRM contiene datos personales de contactos. El editor debe quedar **aislado**, **no expuesto a Internet**, y **nunca** debe tocar datos de pacientes. Solo trabaja con imágenes de marketing.
- **Credenciales**: el token de la API de Twenty y las credenciales de Instagram viven **solo en el servidor / n8n**, jamás en el navegador.
- Autoalojado, sin dependencias cloud de terceros para el editor.

## 3. Arquitectura objetivo

Se conserva la estructura de open-design (front Preact + backend Hono fino + SQLite), pero el backend pasa a ser también el **proxy seguro** que habla con Twenty/n8n con el token server-side.

```
Twenty (ficha de publicación)
   │  botón/enlace: /edit?recordId=<id>
   ▼
Editor (Preact + Fabric.js, en el navegador del operador)
   │  1) GET /api/publication/:id  ──►  Backend Hono  ──►  Twenty GraphQL (token server-side)
   │        (devuelve imagen de origen + texto por defecto)
   │  2) carga imagen en canvas (tamaño IG) + logo como capa fija bloqueada
   │  3) operador ajusta texto / negrita / posición
   │  4) exporta PNG 2x en cliente
   ▼
   POST /api/publication/:id/render  ──►  Backend Hono  ──►  Webhook n8n
                                                              │
                                                              ├─ escribe el PNG en la ficha de Twenty
                                                              └─ publica en Instagram (flujo existente)
```

Todo lo sensible (token de Twenty, credenciales IG, publicación) queda del lado servidor/n8n. El editor solo produce el PNG.

**Alternativa más estricta (opcional):** editor 100% cliente (estático) sin backend propio, delegando toda persistencia y proxy a n8n. Menos superficie aún, pero se pierde la persistencia de borradores de open-design. Decidir en §8.

## 4. Alcance: qué se añade y qué se quita

**Se añade**
- Presets de tamaño de Instagram: feed cuadrado 1080×1080, feed vertical 1080×1350 (4:5) y story 1080×1920.
- **Logo fijo** como capa Fabric bloqueada, siempre arriba-derecha, reposicionado al cambiar de tamaño de canvas, incluido en la exportación.
- **Énfasis por palabra**: botón "negrita en selección" usando estilos por carácter de Fabric (`Textbox`/`IText`).
- Fuentes de marca **autoalojadas** (no cargar Google Fonts en runtime).
- Ajuste de la imagen de origen al lienzo (cover/contain + color de fondo).
- Integración con Twenty (fetch de datos) y n8n (publicación) vía backend.
- Punto de entrada desde Twenty (`?recordId`).

**Se quita / desactiva**
- Plantillas y tamaños orientados a LinkedIn que no se usen.
- Librería de stickers/SVG si no es necesaria (reduce superficie de XSS por SVG).
- Modo agente (`?agent=true`) si no se va a usar; si se mantiene, protegerlo igual que el resto de la API.

## 5. Fases y tareas

### Fase 0 — Fork y baseline
- [ ] Forkear `clawnify/open-design` y clonarlo en local.
- [ ] `pnpm install` y arrancar (`pnpm run dev`); verificar editor en `localhost:5178` y API en `:3006`.
- [ ] Leer y documentar en `CLAUDE.md`: estructura (`src/server`, `src/client`, `use-canvas.ts`, `context.tsx`, `schema.sql`), endpoints y modelo de datos.
- [ ] Fijar versiones en el lockfile y correr `pnpm audit`; anotar vulnerabilidades.

### Fase 1 — Editor a medida
- [ ] Añadir presets IG (1080×1080, 1080×1350, 1080×1920) en el contexto de tamaños de canvas.
- [ ] Cargar el logo como `fabric.Image` bloqueado (`selectable:false`, `evented:false`, `hasControls:false`, `lockMovementX/Y:true`), posicionado arriba-derecha con padding relativo, traído al frente y recolocado en cada cambio de tamaño.
- [ ] Botón "negrita en selección" (estilos por carácter) para el énfasis por palabra.
- [ ] Autoalojar las fuentes de marca; quitar la carga remota de Google Fonts.
- [ ] Lógica de encaje de la imagen de origen (cover/contain + fondo).
- [ ] Retirar plantillas/tamaños/stickers no usados.

### Fase 2 — Integración Twenty + n8n
- [ ] Endpoint backend `GET /api/publication/:id`: consulta Twenty GraphQL con token server-side y devuelve `{ imageUrl, text, ... }`.
- [ ] **Proxy de la imagen de origen** por el backend (mismo origen) para evitar *tainted canvas* al exportar.
- [ ] El editor lee `?recordId`, hace el fetch y monta el lienzo (imagen + logo + texto por defecto).
- [ ] Endpoint `POST /api/publication/:id/render`: recibe el PNG exportado y lo reenvía al webhook de n8n.
- [ ] En n8n: escribir el PNG en la ficha de Twenty + disparar la publicación en Instagram (extender el flujo de historias a posts).
- [ ] Punto de entrada desde Twenty: enlace/botón en la ficha hacia `/edit?recordId=<id>` (campo de enlace o botón vía Apps framework).

### Fase 3 — Seguridad y hardening
- [ ] Proteger **toda** la API `/api/*` (hoy sin auth): secreto compartido / sesión; nada abierto sin autenticar.
- [ ] Usar el **Traefik de Dokploy** (TLS automático); **no** exponer sin auth: middleware de basic auth/forward-auth + allowlist de IP, o sin dominio público y acceso por VPN (ver Fase 4).
- [ ] Saneado de subidas: whitelist de MIME, límite de tamaño, nombres aleatorios, servir con content-type correcto + `Content-Disposition`; **denegar o sanear SVG**.
- [ ] Cabeceras CSP (incl. `frame-ancestors` = origen de Twenty si se embebe por iframe) y validación de origen en `postMessage`.
- [ ] Secretos por variables de entorno; `.env` fuera del control de versiones; token de Twenty con **permisos mínimos** dedicados.

### Fase 4 — Despliegue en el VPS con Dokploy
> Dokploy usa **Traefik** como reverse proxy con TLS/Let's Encrypt automático y gestiona dominios, red y entorno. No añadimos proxy propio ni gestionamos certificados a mano.
- [ ] Añadir un `Dockerfile` al fork (app Node: Hono + better-sqlite3, Node 20+) y desplegar como **Application** en Dokploy (build por Dockerfile). **No** usar el `wrangler.toml` del repo: ese es el target de Cloudflare Workers y no aplica aquí (better-sqlite3 no corre en Workers).
- [ ] **Variables de entorno**: definirlas en el **editor de Environment de Dokploy** (no crear `.env` a mano; Dokploy lo gestiona): `TWENTY_API_URL`, `TWENTY_TOKEN`, `N8N_WEBHOOK_URL`, `EDITOR_SHARED_SECRET`, `LOGO_PATH`.
- [ ] **Volúmenes/mounts** en Dokploy para `data.db` y `uploads/` (si no, se pierden en cada redeploy).
- [ ] **Acceso del operador**: asignar dominio en Dokploy (Traefik + TLS) **pero protegido** con middleware Traefik de auth (basic auth para empezar; forward-auth/SSO como Authelia/Authentik más adelante) y, si hay IPs fijas, middleware de allowlist. Alternativa: sin dominio público y acceso solo por VPN (Tailscale/WireGuard). La auth propia de la API (`EDITOR_SHARED_SECRET`) se mantiene **además** de esto.
- [ ] **Llamadas internas editor→n8n y editor→Twenty** por la red interna de Docker (nombre de servicio en `dokploy-network`), no por el dominio público, para que el tráfico con el token no salga a Internet.
- [ ] Si usas **Isolated Deployments** de Dokploy (cada app en su red propia), abre explícitamente una ruta controlada del editor hacia n8n/Twenty (red compartida) o asume que esas llamadas van por dominio interno. Decidir en §8.
- [ ] Backend detrás de proxy: honrar `X-Forwarded-Proto/Host` (trust proxy) para esquema/host correctos.
- [ ] Límite de **memoria** del servicio en Dokploy (el editor es ligero; deja margen sobre los ~3 GB ya en uso).
- [ ] Contenedor **no-root**, sin acceso a los volúmenes/DB de Twenty.
- [ ] Backup opcional del volumen de SQLite (Dokploy soporta backups; los borradores son de bajo valor). Health check y logs sin datos sensibles.

### Fase 5 — Extras (opcional)
- [ ] Borrador de texto automático: n8n/LLM genera un texto por defecto a partir de la ficha; el editor abre ya con ese borrador y el humano solo lo retoca.
- [ ] Automatizar dependencias (Renovate/Dependabot).
- [ ] QA: pruebas de exportación en los tres tamaños, con logo y con énfasis.

## 6. Checklist de seguridad (consolidado)
- [ ] API autenticada (nada de `/api/*` accesible sin credencial).
- [ ] No expuesto sin auth: Traefik de Dokploy con middleware de auth + allowlist, o VPN/red interna.
- [ ] Subidas saneadas; SVG denegado o saneado; tamaños y tipos limitados.
- [ ] Token de Twenty y credenciales IG **solo** en servidor/n8n.
- [ ] Contenedor aislado, no-root, sin acceso al CRM ni a su DB.
- [ ] `pnpm audit` limpio y versiones fijadas; plan de actualización propio (upstream no parcheará).
- [ ] Sin datos de pacientes en el editor (solo marketing); fuentes autoalojadas.
- [ ] CSP `frame-ancestors` y validación de origen si hay iframe.

## 7. Notas técnicas y gotchas
- **open-design usa Fabric.js v6**: la API difiere de v5 (revisar métodos de estilos y de serialización antes de copiar snippets antiguos).
- **Tainted canvas**: si la imagen de origen se carga cross-origin sin CORS, `toDataURL` falla. Solución: servir la imagen por el proxy del backend (mismo origen).
- **Énfasis**: en Fabric se hace con estilos por carácter sobre la selección, no con markdown en el texto.
- **Logo**: recolocar en cada cambio de tamaño de canvas y asegurar que va incluido en el export (traer al frente).
- **Export**: mantener el 2x que ya trae open-design; verificar nitidez en cada preset.
- **RAM**: nada de render en servidor; SQLite y export en cliente son la razón por la que esto cabe en el VPS.
- **SVG**: es el vector de XSS más probable aquí; si no se necesitan stickers SVG, quitarlos simplifica la seguridad.
- **Dokploy / `wrangler.toml`**: el repo trae `wrangler.toml` (Cloudflare Workers). Ignóralo para el self-host: desplegamos como app Node con Dockerfile + volumen. No mezcles ambos targets.
- **Dokploy / red**: para que el editor llame a n8n y a Twenty por dentro, deben resolverse por nombre de servicio en `dokploy-network`; con Isolated Deployments cada app va en su propia red y hay que compartir red a propósito.
- **Dokploy / entorno**: las variables se ponen en el editor de Environment de Dokploy, no en un `.env` commiteado.
- **Trust proxy**: detrás de Traefik, honra `X-Forwarded-*` o el esquema/host saldrán mal.

## 8. Decisiones pendientes de confirmar
1. **Backend sí o no**: mantener el Hono+SQLite de open-design (recomendado, con hardening) vs. editor 100% cliente + n8n para todo.
2. **Entrada desde Twenty**: abrir en pestaña nueva con un botón (recomendado para empezar) vs. iframe embebido en la ficha.
3. **Write-back**: enrutar la publicación vía **n8n** (recomendado, ya tiene el flujo) vs. escribir a Twenty directamente desde el backend.
4. **Formatos IG** realmente necesarios (¿solo cuadrado? ¿vertical? ¿story?).
5. **Fuentes de marca** a incluir.
6. **Método de acceso** al editor: solo VPN, basic auth (middleware Traefik), o forward-auth/SSO.
7. **Red en Dokploy**: red compartida (`dokploy-network`) para llamadas internas editor↔n8n↔Twenty, vs. Isolated Deployments con ruta abierta a propósito.

## 9. Ficheros a añadir en el fork
- `CLAUDE.md` — contexto del proyecto y convenciones para Claude Code (este plan resumido + mapa del código).
- `.env.example` — documentar las variables (`TWENTY_API_URL`, `TWENTY_TOKEN`, `N8N_WEBHOOK_URL`, `EDITOR_SHARED_SECRET`, `LOGO_PATH`, tamaños IG) **como referencia**; los valores reales van en el editor de Environment de Dokploy, no en un `.env` commiteado.
- `Dockerfile` — app Node (Hono + better-sqlite3) para desplegar como Application en Dokploy. (El `wrangler.toml` del repo no se usa en este despliegue.)

## 10. Prompt de arranque para la primera sesión de Claude Code

> Este repo es un fork de `clawnify/open-design` (Preact + Fabric.js v6 + Tailwind + Hono + SQLite). Vamos a convertirlo en un editor interno para componer imágenes de Instagram a partir de publicaciones de Twenty CRM, siguiendo `PLAN.md`. Empieza por la **Fase 0**: arranca el proyecto, recorre el código (`src/server`, `src/client`, `use-canvas.ts`, `context.tsx`, `schema.sql`, endpoints y modelo de datos) y escríbeme un `CLAUDE.md` con el mapa del código, los puntos donde tocaremos (presets de tamaño, inicialización del canvas, exportación, API) y las vulnerabilidades que veas al correr `pnpm audit`. No cambies funcionalidad todavía; primero entendamos la base. Cuando termines, propón el plan concreto de la Fase 1.