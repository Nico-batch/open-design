# Open Design — el editor del arte de Instagram de El Faro

Fork de [`clawnify/open-design`](https://github.com/clawnify/open-design)
convertido en el editor interno de El Faro de Alicante: se abre desde una noticia
o un evento de Twenty CRM, compone el arte del post o de la story en el navegador
y devuelve la URL de la imagen terminada al registro.

Este fichero es la fuente de las instrucciones para cualquier agente; `CLAUDE.md`
solo lo importa. El contexto que comparten todos los proyectos está en
`../AGENTS.md`, y el sistema completo —CRM, n8n, redes y contratos— en
`../DOCUMENTACION.md`. El porqué de cada decisión de este código, con sus bugs y
sus verificaciones, está en [`docs/HISTORIAL.md`](docs/HISTORIAL.md): los
comentarios del código lo citan por sección («§9.21»).

## Lo que no es tuyo

Este repositorio es **el editor de imágenes**. Produce arte y lo sirve por URL.
No publica, no modera y no reparte.

- **n8n** — la ingesta, la cola horaria y la publicación en Instagram y Facebook.
  Este editor no llama a n8n: n8n le llama a él, o descarga de su `/api/uploads/`.
- **Twenty CRM** — la moderación y la fuente de verdad editorial.
- **WordPress y el tema hijo** (`../web/`) — el sitio público y las APIs `faro/v1`.
- **Directus** — se evaluó como sustituto de Twenty y se **descartó el
  30/8/2026** (motivo en `../contexto-proyecto.md`; archivo en
  `../archivo/DirectusCMS/`). El código conserva la capacidad de servirle
  (`FUENTE=directus`, `docs/HISTORIAL.md` §12), pero la única instancia
  desplegada corre con `FUENTE=twenty`.

Si el problema está en la ingesta, en la cola o en la publicación en redes,
**dilo y para**. Desde aquí solo se ve el síntoma.

## `GET /api/uploads/…` es público a propósito

Toda la app exige Basic Auth salvo dos rutas, exceptuadas a mano en
[`src/server/index.ts`](src/server/index.ts): `GET /api/uploads/…` y
`GET /api/health`.

**Las stories de Instagram dependen de la primera.** A diferencia del post de
feed, que re-sube la imagen a la mediateca de WordPress, el flujo de story le pasa
a Meta directamente la URL de este servidor, y **Meta descarga el arte desde
aquí**. Twenty también la lee sin credenciales. Si algún día se protege este origen
con Traefik o con cualquier otro middleware, las stories dejan de salir — y el
fallo aparece en el log como un problema de red.

**No es un descuido, y no se «arregla».** Si hay que cerrarlo, primero hay que
volver a meter el arte vertical por `POST /faro/v1/imagenes` y actualizar
`../DOCUMENTACION.md` §4.1. Con `FUENTE=directus` la excepción se cierra sola,
porque el arte lo sirve Directus.

## Stack y estructura

Preact + TypeScript + Tailwind + Vite en el cliente; **Fabric.js 6** para el
lienzo; Hono sobre Node para la API; SQLite nativo con **`node:sqlite`** (Node ≥
22.5; se usa la 24, sin compilación nativa). Fuentes autoalojadas en
`public/fonts/`, nunca de Google en tiempo de ejecución.

```
src/server/   index.ts (rutas y auth) · db.ts · serve.ts · uploads.ts · auth.ts
              fuentes/  twenty.ts · directus.ts · index.ts (elige por FUENTE)
src/client/   hooks/use-canvas.ts (toda la lógica de Fabric) · components/
              lib/      plantillas (event-template, news-template), palette.ts,
                        efectos, capas, guías, formato de texto
public/       fonts/ · logo.png
docs/         HISTORIAL.md · PLAN-ORIGINAL.md
```

El mapa fichero a fichero, en `docs/HISTORIAL.md` §3.

## Cómo se arranca

```bash
pnpm install
pnpm run dev                      # interfaz en :5173, API en :8787
pnpm run build && pnpm run start  # el build de producción, servido por la API en :8787
```

`.env` a partir de `.env.example`; sin `EDITOR_USER` y `EDITOR_PASSWORD` el
servidor no arranca. `data.db` y `uploads/` se crean solos y no se versionan.

En Windows, `concurrently` + `tsx watch` pierde la salida del servidor: por eso
`dev` usa `tsx` sin `watch` y hay que reiniciarlo a mano al tocar `src/server/`.

## Cómo se verifica

Es la regla que más bugs ha cazado aquí: **se prueba en un navegador real, no solo
con el compilador**.

- **Lo que dependa de la CSP se prueba contra el build de producción**, nunca en
  `pnpm run dev`: en desarrollo el HTML lo sirve Vite sin las cabeceras. Un
  `fetch()` sobre una URL `data:` pasó varias rondas de pruebas y solo falló ya
  desplegado (`docs/HISTORIAL.md` §9.11).
- Las pruebas de las secciones del historial se hicieron con Playwright contra
  `pnpm run build && pnpm run start`, leyendo de vuelta el `canvas_json` guardado y
  el registro en Twenty.
- **Toda escritura de prueba en el CRM se revierte** al terminar, y se comprueba
  que no queda ninguna URL de `localhost` en los registros.
- **Nada de `data:image` en el `canvas_json`**: los fondos van por el proxy
  `/api/twenty/:type/:id/image`.

## Convenciones del editor

- **El formato lo decide el enlace, no la proporción del lienzo.**
  `…/edit?recordId=<id>&objectType=news|event&format=post|story`. Post y story son
  dos borradores distintos del mismo registro; el de story escribe en
  `imagenStory` aunque se cambie el tamaño.
- **Las rutas se siguen llamando `/api/twenty/…`** aunque la fuente fuera otra: los
  borradores guardados llevan esa URL dentro y renombrarla los dejaría sin fondo.
- **Fabric no serializa lo que no está registrado**: toda propiedad propia
  (`_tplRole`, `_nwRole`…) va en `customProperties`, o se pierde al guardar.
- **La paleta vive en `src/client/lib/palette.ts`** y es una de las cinco copias de
  la marca (`../DESIGN.md` §3.3). La regla de las plantillas: **ámbar y crema nunca
  se tocan**.
- Los comentarios explican el porqué y citan la sección del historial que lo
  cuenta. Una decisión nueva se apunta como sección nueva en `docs/HISTORIAL.md`.

## Despliegue

**`git push` a `main` despliega**: Dokploy construye el `Dockerfile` y sustituye el
contenedor de `opendesign.elfarodealicante.com`. Una acción de GitHub copia `main`
en `master`. No hay entorno de pruebas: lo que se empuja, sale.

- Un único volumen en **`/data`** (base de datos y `uploads/`). Sin él, cada
  despliegue borra todos los diseños y el arte.
- Variables en el editor de Environment de Dokploy, nunca en un `.env` del
  servidor: `TWENTY_API_URL`, `TWENTY_TOKEN`, `PUBLIC_BASE_URL`, `EDITOR_USER`,
  `EDITOR_PASSWORD`.
- Health check: `GET /api/health`, puerto 8787.

El detalle, en `docs/HISTORIAL.md` §11.

## Pendiente

- **Los eventos no traen enlace al editor en vertical**: el workflow `Nuevo
  Evento` de Twenty solo escribe `editarImagen`, no `editarImagenStory`
  (`../DOCUMENTACION.md` §4.6). Mientras, la story se abre añadiendo
  `&format=story` a mano.
- **`pnpm audit`**: el ruido viene de `fabric` → `jsdom`, que no corre en
  producción. Falta automatizar las actualizaciones (`docs/HISTORIAL.md` §6).
