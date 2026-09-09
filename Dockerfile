FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

# Сначала копируем только манифесты — кэш слоя для зависимостей
COPY package.json package-lock.json ./
# лучше-sqlite3 — нативный модуль: ставим build-tools на случай, если нет prebuilt-бинарника
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm ci --omit=dev

# Копируем код
COPY src ./src
COPY webpanel ./webpanel
COPY config.json ./config.json
COPY main.js ./main.js

# Токен и секреты — через переменные окружения (см. .env.example)
ENV DISCORD_TOKEN=""

# Веб-панель
ENV PANEL_HOST=0.0.0.0
ENV PANEL_PORT=17890

# Данные (БД, логи) — том
ENV DB_DIR=/app/state
ENV DATA_DIR=/app/state
VOLUME ["/app/state"]

EXPOSE 17890

CMD ["node", "src/main.js"]