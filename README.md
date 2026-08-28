# Open Design

Editor interno de imágenes para las publicaciones de Instagram de El Faro de
Alicante. Lee noticias y eventos de Twenty CRM, permite componer el arte en el
navegador y guarda el resultado en `imagenEditada` o `imagenStory`.

El editor no modera ni publica. La publicación en Instagram y Facebook la hace
n8n a partir de los campos actualizados en Twenty.

## Stack

- Preact, TypeScript, Tailwind CSS y Vite
- Fabric.js 6 para el lienzo
- Hono y Node.js para la API
- SQLite nativo mediante `node:sqlite`
- Fuentes autoalojadas y Basic Auth

## Desarrollo local

```bash
pnpm install
pnpm run dev
```

La interfaz queda en `http://localhost:5173` y la API en `http://localhost:8787`.
La configuración se carga desde `.env`; usa `.env.example` como referencia.

Para probar producción localmente:

```bash
pnpm run build
pnpm run start
```

## Integración con Twenty y Directus

Este editor sirve a dos fuentes editoriales, elegidas por la variable `FUENTE`
(`twenty` por defecto, o `directus`) — ver `.env.example` y `CLAUDE.md` §12. La
entrada habitual es la misma en las dos:

```text
/edit?recordId=<id>&objectType=news|event&format=post|story
```

Variables necesarias con `FUENTE=twenty` (o ausente):

- `TWENTY_API_URL`
- `TWENTY_TOKEN`
- `PUBLIC_BASE_URL`

Variables necesarias con `FUENTE=directus`:

- `DIRECTUS_URL`
- `DIRECTUS_TOKEN`
- `DIRECTUS_ARTE_PUBLICO_FOLDER`

Siempre, en las dos:

- `EDITOR_USER`
- `EDITOR_PASSWORD`

El token de Twenty solo se usa en el servidor. Las imágenes de origen se
proxifican para evitar exponer URLs firmadas al navegador.

## Funcionalidades

- Plantillas automáticas para noticias y eventos
- Formatos de feed y story de Instagram
- Texto editable, estilos por rango, emojis y efectos
- Imagen de fondo reencuadrable, filtros y capas
- Guardado de borradores en SQLite
- Exportación PNG para descarga y JPEG para guardar en Twenty
- API de health check en `GET /api/health`

## Estructura

```text
src/server/       API Hono, SQLite, autenticación e integración con Twenty
src/client/       editor Preact y componentes del lienzo
public/fonts/     fuentes autoalojadas
Dockerfile        imagen de producción para Dokploy
```

## Despliegue

Se despliega como una Application de Dokploy mediante el `Dockerfile`. Es
necesario montar un volumen en `/data` para conservar la base SQLite y las
imágenes subidas. La configuración detallada está en `CLAUDE.md`.

## Licencia

MIT
