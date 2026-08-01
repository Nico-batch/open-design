# Node ≥ 22.5 hace falta por node:sqlite (ver CLAUDE.md §1); usamos la LTS 24, la misma
# que en desarrollo. Nada de better-sqlite3 aquí, así que no hace falta toolchain nativo
# (python/make/g++) en ninguna etapa.

# ── Etapa 1: build del cliente (Vite) ───────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /app
RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# ── Etapa 2: runtime ─────────────────────────────────────────────────────────
# El servidor corre con tsx directamente sobre src/server/*.ts (mismo mecanismo que en
# desarrollo, ver CLAUDE.md §2) — no hay paso de compilación propio para el backend.
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/dist ./dist
COPY src/server ./src/server

# Usuario no-root + directorio para los volúmenes (data.db + uploads/), montados por
# Dokploy en /data (Fase 4 — ver CLAUDE.md). DB_PATH/UPLOADS_DIR apuntan ahí en vez de a
# rutas dentro del código fuente.
RUN groupadd --system editor \
  && useradd --system --gid editor --home-dir /app --no-create-home editor \
  && mkdir -p /data/uploads \
  && chown -R editor:editor /app /data

USER editor

ENV DB_PATH=/data/data.db
ENV UPLOADS_DIR=/data/uploads
ENV PORT=8787

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["pnpm", "run", "start"]
