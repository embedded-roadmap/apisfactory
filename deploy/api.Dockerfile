# API ve arka plan işçisi (outbox) için tek imaj. Bağlam: depo kökü.
#   docker build -f deploy/api.Dockerfile -t apisfactory-api .
# Çalıştırma komutu compose'ta belirlenir: api (sunucu), worker (kuyruk), migrate (tek seferlik).
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable

WORKDIR /app
# Önce yalnız bağımlılık tanımları → katman önbelleği kod değişince bozulmaz.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
# --prod=false: çalıştırıcı tsx devDependency'dir; NODE_ENV=production iken pnpm onu atlardı ("tsx: not found").
RUN pnpm install --frozen-lockfile --prod=false --filter "@apisfactory/api..."

COPY packages/shared packages/shared
COPY apps/api apps/api

# Nesne depolama (STORAGE_BACKEND=local) için kalıcı dizin; compose'ta birime bağlanır.
RUN mkdir -p /data/objects && chown -R node:node /data /app
USER node
WORKDIR /app/apps/api
ENV STORAGE_LOCAL_DIR=/data/objects PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "start"]
