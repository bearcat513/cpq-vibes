# syntax=docker/dockerfile:1

# Build context is the repo root (see docker-compose.yml), so the paths below
# are relative to the project root, not to docker/.
ARG BUN_VERSION=1.4.0

FROM oven/bun:${BUN_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
# NOT --production: bun-plugin-tailwind (wired up in bunfig.toml) pulls in
# `tailwindcss`, a devDependency that is needed at serve time to bundle CSS.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

FROM oven/bun:${BUN_VERSION}-alpine AS release
WORKDIR /app

# Disables HMR + browser console echo in src/index.ts.
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json bunfig.toml components.json ./
COPY styles ./styles
COPY src ./src

# Bun.serve() bundles src/index.html and its React tree on demand, so there is
# no separate `bun run build` step here — build.ts only exists for static output.
USER bun
EXPOSE 3000

# Liveness only: this asks whether the server is answering, not whether
# PocketBase is (GET /api/meta reports that).
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["bun", "src/index.ts"]
