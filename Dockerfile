FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

# Нативные зависимости для better-sqlite3 (кэшируются отдельно от npm)
# Ставим только на этап сборки и удаляем после компиляции чтобы уменьшить образ/поверхность атаки
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# Сначала пробуем prebuild, затем fallback на сборку из исходников. Любая ошибка — фейл сборки (без || true)
RUN npm ci --omit=dev --ignore-scripts=false \
    && (npm rebuild better-sqlite3 --build-from-source || (echo "better-sqlite3 build failed" >&2 && exit 1)) \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Копируем код (config.json теперь без секретов — секреты только через .env)
COPY src ./src
COPY webpanel ./webpanel
COPY config.json ./config.json
COPY main.js ./main.js

# Секреты — только через переменные окружения (см. .env.example), не бейкать
# ENV DISCORD_TOKEN intentionally not set here — compose env_file has priority

ARG PANEL_HOST=0.0.0.0
ENV PANEL_HOST=${PANEL_HOST}
ENV PANEL_PORT=17890
ENV DB_DIR=/app/state
ENV DATA_DIR=/app/state

# Создаём директорию состояния до VOLUME чтобы Docker не затирал её при монтировании
RUN mkdir -p /app/state && chown -R node:node /app/state

# Здоровье и том — VOLUME после COPY, healthcheck использует реальный эндпоинт /api/status
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PANEL_PORT||17890)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
VOLUME ["/app/state"]

EXPOSE 17890
EXPOSE 8765

USER node

CMD ["node", "src/main.js"]