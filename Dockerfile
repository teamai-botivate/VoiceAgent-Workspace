FROM oven/bun:1.4.0-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.4.0-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100 HEALTH_PORT=3100
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile --ignore-scripts
COPY --from=build --chown=bun:bun /app/dist ./dist
USER bun
EXPOSE 3100 3200
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e 'const r = await fetch(`http://127.0.0.1:${process.env.HEALTH_PORT}/health/live`); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "dist/server.js"]
