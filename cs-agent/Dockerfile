# Build stage: frontend
FROM node:20-bookworm-slim AS frontend-build
WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm install
COPY index.html vite.config.ts tsconfig.json tsconfig.node.json ./
COPY src ./src
# Production serves same-origin /api/v1 via the nginx proxy
ENV VITE_API_URL=
RUN npm run build

# Production stage: PostgreSQL + nginx + Node backend
FROM node:20-bookworm-slim
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    postgresql \
    postgresql-contrib \
    nginx \
    gettext-base \
    curl \
    ca-certificates \
    locales \
  && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
  && locale-gen en_US.UTF-8 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/lib/postgresql/data /var/log/nginx /etc/nginx/templates /run/nginx \
  && chown -R postgres:postgres /var/lib/postgresql

# Backend dependencies
COPY backend/package.json backend/package-lock.json* ./backend/
RUN cd backend && npm install --omit=dev

# Application code
COPY backend ./backend
COPY --from=frontend-build /build/dist ./dist
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    PORT=8080 \
    BACKEND_PORT=3000 \
    PGDATA=/var/lib/postgresql/data \
    POSTGRES_DB=csagent \
    POSTGRES_USER=csagent \
    POSTGRES_PASSWORD=database123456

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -f http://127.0.0.1:8080/api/v1/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
