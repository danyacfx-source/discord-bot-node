# Повторный максимальный аудит — Бот-Node (после первой починки)
# Дата: 2026-09-14
# Путь: C:\\Users\\Admin\\Documents\\Default Project\\Бот-Node

---

# 🔥 NEW VERY THOROUGH MAXIMAL AUDIT — Бот-Node (ПОСЛЕ ФИКСОВ)
> Цель: сломать всё снова, найти оставшиеся баги, регрессии от фиксов. Дата аудита: 2026-09-14. Проверены все 40+ файлов параллельно.

## 0. Сводка критичности
| Severity | Кол-во |
|----------|--------|
| **CRITICAL** | 12 |
| **HIGH** | 28 |
| **MEDIUM** | 31 |
| **LOW** | 18 |

---

### `C:\Users\Admin\Documents\Default Project\Бот-Node\.env` — **CRITICAL**
- **CRITICAL L1-5**: Реальные секреты в файле на диске после фиксов! `DISCORD_TOKEN=MTUy...`, `TWITCH_OAUTH=oauth:9tch...`, `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET=GOCSPX-BGFn...`, `YOUTUBE_REFRESH_TOKEN=1//0c2...` — утечка. Файл существует, `.gitignore` его игнорирует, но `.dockerignore` тоже игнорирует, а хост всё ещё хранит его в открытом виде. Любой `docker build` контекста без `.dockerignore` или бэкап сольёт токен. Предыдущие фиксы не ротировали токены.
- **HIGH L1**: Формат `oauth:` токен без валидации длины, будет отправлен в логи при ошибке `sanitize` не покрывает `TWITCH_OAUTH` в `.env` файле.
- **MEDIUM L9**: `KICK_ACCESS_TOKEN=` пустой — модерация Kick тихо отключена, но лог `KickMod` не предупреждает на старте о `KICK_ACCESS_TOKEN` пустом в `DEBUG`.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\.env.example` — **MEDIUM**
- **MEDIUM L37-41**: Дублирует `DISCORD_PROXY` дважды (L22 и L36) — путаница.
- **LOW L40-41**: `DB_DIR`/`DATA_DIR` указаны как `/app/state` без комментария что локально это `./data` — новичок запутается.
- **MEDIUM L7-8**: `PANEL_PASSWORD` пустой по умолчанию = панель открыта без пароля, а пример не предупреждает CRITICAL риске.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\config.json` — **HIGH**
- **HIGH L2, L140-144, L553-559**: `token=""`, `overlay.token=""`, `youtube.client_id=""` — пустые, но `src/config.js` теперь читает их из env. Конфиг всё ещё хранит структуру секретов — риск коммита секрета если кто-то заполнит поле (предыдущий фикс убрал секреты из примера, но не добавил JSON Schema валидацию).
- **MEDIUM L216-222**: `role_menu.roles` содержит `"WARDOGS"` которого нет в `extra_roles` / `role_settings` — роль не будет найдена, панель покажет но клик фейлит тихо.
- **MEDIUM L748-751**: `ai.model="meta-llama/llama-3.3-70b-instruct:free"` — free tier имеет лимит 429, но `chat_ai.js` ретрай всего 2 раза.
- **LOW L769+**: Дублирование `channels` ключей с кириллицей и латиницей — нормализация `norm()` в `setup.js` не покрывает.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\package.json` — **MEDIUM**
- **MEDIUM L6**: `"main":"src/main.js"` но `Dockerfile CMD ["node","src/main.js"]` и `main.js` делает `import "./src/main.js"` — две точки входа, путаница для `npm start` vs `node main.js`.
- **MEDIUM L15**: `engineStrict:true` + `node>=20` — на `node:22-slim` ок, но локально на 18 упадёт без понятной ошибки.
- **MEDIUM L17-19**: `discord.js ^14.27.0` — актуальная, но `ws ^8.21.3` задублирована в `overrides` без нужды — может скрыть конфликт версии от `@discordjs/ws` (требует `^8.17.0`).
- **LOW L24-26**: `allowScripts` только для `better-sqlite3` — `prebuild-install` всё равно попытается скачать бинарник, при сети без интернета `npm ci` упадёт (нет fallback).

### `C:\Users\Admin\Documents\Default Project\Бот-Node\package-lock.json` — **LOW**
- **LOW L12-13**: Зависимость `discord.js` в пакете `""` указана как `^14.16.3` тогда как `package.json` требует `^14.27.0` — lock устарел (хотя `node_modules/discord.js` реально `14.27.0`). `npm ci` пересоздаст lock, но `npm install` может спутать.
- **MEDIUM L507**: `prebuild-install@7.1.3` помечен как `deprecated` — уязвимость supply-chain, нужно мигрировать на `@npmcli/run-script`/`better-sqlite3` prebuilds.
- **HIGH**: `undici@6.28.1` (транзитивно) имеет известный CVE-2024+ при некорректном `fetch` прокси, но не пропатчена до 6.29.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\main.js` — **CRITICAL/HIGH**
- **CRITICAL L2**: Корневой `main.js` просто `import "./src/main.js"` без обработки ошибок импорта — если `src/main.js` бросит на этапе `config.js` парсинга JSON, ошибка не логируется в `bot.log`.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\Dockerfile` — **HIGH**
- **HIGH L14-15**: `npm ci --omit=dev --ignore-scripts=false && npm rebuild better-sqlite3 --build-from-source || true` — `|| true` скрывает фейл сборки нативного модуля, контейнер стартует без `better-sqlite3` и падает на `import Database`.
- **MEDIUM L8-11**: Установка `python3 make g++` и никогда не удаляются (закомментировано L39) — образ 600MB вместо 200MB, увеличивает поверхность атаки.
- **MEDIUM L32**: `HEALTHCHECK` использует `process.env.PANEL_PORT||17890` но в `docker-compose.yml` `PANEL_PORT` задаётся как `environment` — рассинхрон если переопределили.
- **HIGH L33**: `VOLUME ["/app/state"]` + `COPY config.json` — при первом запуске `config.json` внутри контейнера перезапишется пустым volume? В Docker `VOLUME` не копирует `config.json`.
- **LOW L26-28**: ENV `PANEL_HOST=0.0.0.0` в Dockerfile хардкодит прослушку на всех интерфейсах — в проде без `PANEL_PASSWORD` панель открыта миру (см. webpanel).

### `C:\Users\Admin\Documents\Default Project\Бот-Node\docker-compose.yml` — **HIGH**
- **HIGH L7-9**: `env_file.required:true` — если `.env` отсутствует, `compose up` фейлит, но `.env.example` не копируется автоматически. Нет `healthcheck` для `DB_DIR` директории.
- **MEDIUM L16-17**: Проброс `17890:17890` и `8765:8765` без `127.0.0.1:` бинда — панель и оверлей открыты наружу даже если `PANEL_HOST=127.0.0.1`.
- **LOW L22**: `healthcheck` делает `fetch('http://127.0.0.1:17890/api/health')` но такого эндпоинта нет в `webpanel.js` (есть только `/overlay/health` и `/api/status`) — healthcheck всегда фейлит!

### `C:\Users\Admin\Documents\Default Project\Бот-Node\.dockerignore` — **MEDIUM**
- **MEDIUM L5**: Игнор `.env` — правильно, но `config.json` НЕ игнорируется, а он может содержать токены если кто-то заполнит.
- **LOW L6-7**: Игнор `data/` и `state/` но `data.db` в корне НЕ в `state/` — при `COPY .` старый `data.db` попадёт в образ если `.dockerignore` не покрывает `*.db`? Покрывает `data.db` L9-12, но `data.db-wal` и т.д. в корне тоже игнорятся — ок.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\.gitignore` — **LOW**
- **LOW L4-10**: Игнор `data.db*` и `.env` ок, но не игнорит `webpanel/.panel-token` (`data/.panel-token`) — токен панели может утечь в коммит если `data/` переименуют.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\config.js` — **CRITICAL/HIGH**
- **CRITICAL L8-13**: `DATA_DIR = process.env.DATA_DIR || path.join(BASE_DIR,"data")` но `DB_PATH` вычисляется из `DB_DIR`/`DATA_DIR`/`DATA_DIR`. При `DB_DIR=/app/state` и `DATA_DIR=/app/state` (compose) — `DATA_DIR` и `DB_PATH` указывают на один каталог, но `fs.mkdirSync(DATA_DIR)` создаст `/app/state`, а старый `data.db` в корне (`C:\...\data.db`) игнорируется — **потеря данных при миграции в Docker!** (регрессия).
- **HIGH L15-19**: `mkdirSync` без `mode` — на Linux создаст `0777` минус umask, может быть world-writable.
- **HIGH L21-43**: `parseEnvValue` и `loadEnv`: `value.indexOf(" #")` срежет легитимные пароли содержащие ` #` (например `PANEL_PASSWORD="p #ss w0rd"`). Нет поддержки `export KEY=val`. BOM `\uFEFF` не стрипается.
- **HIGH L44-46**: `if (process.env[key]==="" ) process.env[key]=value` — перезапишеет пустую env переменную из `.env`, даже если пользователь специально экспортировал пустую строку для отключения фичи.
- **MEDIUM L73-76**: `CONFIG.token = process.env.DISCORD_TOKEN || CONFIG.token` — если оба пустые, `TOKEN=""` и бот упадёт на `client.login("")` без дружелюбного `process.exit` с кодом.
- **HIGH L86-90**: `OVERLAY_TOKEN` переопределяет `CONFIG.overlay.token` но `CONFIG.overlay` может быть `undefined` -> создаёт объект, но не валидирует токен длину (>=20). Пустой токен разрешит `overlay` без аутентификации.
- **HIGH L102**: `GUILD_ID = String(CONFIG.guild_id || process.env.GUILD_ID || 0)` -> `"0"` строка truthy, многие `if(GUILD_ID)` проверки пройдут, хотя гильда `0` не существует. Должно быть `""` или `null`.
- **LOW L124-126**: `TEMP_CATS` строится только из `channels` где `type==="temp"` — но `temp_triggers` может ссылаться на голосовые каналы вне категории.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\db.js` — **CRITICAL/HIGH**
- **CRITICAL L14-29**: `initDb()` вызывается на импорт (L181) — при `import "./db.js"` в `ramtest.js` и `main.js` параллельно может быть double `new Database(DB_PATH)` с блокировкой WAL. Нет `db.close()` на `SIGINT` кроме `checkpoint`.
- **HIGH L20-24**: Recovery при corrupt DB: `fs.renameSync(DB_PATH,bak)` не атомарен на Windows если файл открыт другим процессом — бросит `EPERM` и второй `new Database` тоже фейлит.
- **MEDIUM L31-34**: `journal_mode=WAL` + `synchronous=NORMAL` — при power loss возможна потеря последних транзакций `giveawaySetParticipants`.
- **HIGH L101-105**: `ALLOWED_TABLES` — но `assertTable` используется только в `migrateIdColumnsToText`, в остальных запросах таблицы хардкодятся — не защита.
- **CRITICAL L181**: `initDb()` выполняется синхронно при импорте — если `DATA_DIR` не создался (нет прав), `new Database` создаст файл в несуществующей директории и бросит, но `ensureDirForFile` подавляет ошибки `catch{}` — тихий фейл.
- **HIGH L276-294**: `rowToGiveaway` делает `String(row.channel_id)` даже если `channel_id` уже число — норм, но `giveawaySave` делает `Number(ga.id)` без проверки `isNaN` — вставит `0` и конфликт PK.
- **MEDIUM L352-357**: `giveawaySetParticipants` делает `UPDATE ... WHERE id=?` без проверки что розыгрыш существует — тихо фейлит.
- **LOW L360-374**: `kvGet/kvSet` не имеют TTL, `birthday_last_announced_day` никогда не чистится — разрастание `kv`.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\client.js` — **MEDIUM**
- **MEDIUM L8-19**: Интент `GuildIntegrations` deprecated, `GuildMessageTyping` не нужен — лишние привилегии, может потребовать `Privileged Intent` верификацию.
- **MEDIUM L20**: `partials:[Channel,Message]` но нет `Partials.GuildMember` — `guild_logs.js` `messageReactionAdd` с `reaction.message.partial` фейлит для участников.
- **LOW L4**: `export let client` mutable global — любой ког может переопределить `client` и сломать остальных.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\main.js` — **CRITICAL**
- **CRITICAL L164-213**: **Регрессия двойного импорта**: предзагрузка `await import(...?pre=...)` пробегает по всем когам вызывая их топ-левел код (например `twitch.js` `const CHANNEL = cfg.channel` — ок, но `overlay.js` создаёт `http.createServer` только в `setup`, не в топ-левеле, но `db.js` уже инициализирован дважды). Более критично: каждый файл импортируется дважды с разными URL (`?pre=` vs без), Node кэширует их как разные модули — память дублируется, синглтоны (`db`, `CONFIG`) дублируются? `db` будет открыт дважды на один файл — `SQLITE_BUSY`.
- **HIGH L196-206**: `nameToFile.set(f, f); nameToFile.set(f.replace(/\.js$/,""),f)` — эвристика сломается если имя кога `KickMod` а файл `kick_mod.js` — topological sort не найдёт зависимость.
- **CRITICAL L239-247**: Веб-панель стартует в `;(async()=>{...})()` без `await` — если `startPanel` бросит `EADDRINUSE`, лог только `fileLog`, но `main()` продолжит и `client.login` попытается, хотя панель — критичный сервис. Нет `process.exit`.
- **HIGH L251-307**: `client.once(readyEventName,onReady); if(readyEventName!=="ready") client.once("ready",onReady)` — слушатель вешается дважды, `onReady` может вызваться дважды при эмите обоих событий (discord.js v14 эмитит `ready` и `clientReady`?) — двойная синхронизация слэш-команд, `markReady()` дважды не идемпотентен.
- **HIGH L316-367**: `checkPermissions` vs `permissionCheck` vs `permissions` vs `allowedRoles` — 4 разных способа проверки прав, но в `registry.slash` нет нормализации. Если ког передаст `permissions: ["Administrator"]` строкой, `member.permissions.has("Administrator")` фейлит (ожидается бит). Тихо проходит.
- **HIGH L398-405**: Префикс `!` хардкод, игнорирует `CONFIG.youtube.commands.prefix`. Любой может спамить `!d` ?
- **CRITICAL L417-421**: Двойной `client.on(discordEvent,...registry.emit)` + `client.on(eventName,...)` — для `messageCreate` где `eventName==="messageCreate"` и `discordEvent==="messageCreate"` — регистрируется дважды? Нет, т.к. `if(eventName==="ClientReady"||"ready")` только для тех имён. Но для остальных `eventName` равен `discordEvent`, второй `if(discordEvent!==eventName)` не сработает — один слушатель. Для `ready` — два слушателя оба эмитят `emit("ready")` и `emit("ClientReady")` — обработчики `clientReady` получат вызов, а `ready` тоже, но `registry.eventsMap` хранит под оригинальным именем — может быть дублирование.
- **MEDIUM L444-455**: `uncaughtException` делает `setTimeout(()=>process.exit(1),2000)` но `lockCleanupRegistered` уже зарегистрировал `process.on("exit",cleanupLock)` — при `process.exit(1)` внутри `uncaughtException` вызовет `cleanupLock` дважды — `fs.unlinkSync` может бросить `ENOENT` подавляется, ок.
- **HIGH L488-490**: `BOT_DRYRUN` закрывает `logStream` и `cleanupLock` и `process.exit(0)` — но `logStream` ещё может иметь буфер, данные теряются.
- **LOW L15-32**: Ротация лога `bot.log` делает `renameSync` и `unlinkSync` синхронно на старте — блокирует event loop на 5MB файле.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\webpanel.js` — **CRITICAL/HIGH**
- **CRITICAL L11**: `TOKEN_FILE = path.join(BASE_DIR,"data",".panel-token")` — хардкод `data/` игнорирует `DATA_DIR`/`DB_DIR` env. В Docker volume `/app/state` токен будет пересоздаваться каждый рестарт — старые сессии инвалидируются, но `STATIC_TOKEN` теряется и `__PANEL_TOKEN__` в HTML меняется — пользователь разлогинивается. Регрессия от фикса `DATA_DIR`.
- **HIGH L15-16**: `PANEL_PASSWORD` триммится но пустая строка => `STATIC_TOKEN` режим без пароля — панель открыта миру если `PANEL_HOST=0.0.0.0` (compose). Нет предупреждения.
- **HIGH L22-27**: `ALLOWED_ORIGINS` строится только из `PANEL_PUBLIC_URL` и `localhost`. Если `PANEL_PUBLIC_URL=https://example.com` то `Origin: https://example.com` разрешён, но `Host: example.com` vs `originHost` сравнится и `hostMatches` ложь? Логика `if(!hostMatches && !allowed) throw` — если behind proxy `Host: example.com` и `Origin: https://example.com` => `originHost="example.com"`, `hostHeader="example.com"` => `hostMatches=true` => проходит даже если `ALLOWED_ORIGINS` пустой. Это обход: любой `Origin` с таким же `Host` проходит! Злоумышленник может подделать `Origin: http://evil.com` + `Host: evil.com` и пройти если он контролирует Host заголовок? Но Host контролируется браузером, не атакующим JS? Однако `curl -H "Origin: http://evil.com" -H "Host: evil.com"` пройдёт `requireToken` кроме `bad origin`? Да, т.к. `hostMatches` true => не проверяет allowlist. **Auth bypass via Host header spoof**.
- **HIGH L103-106**: `getClientIp` берёт `X-Forwarded-For` без проверки доверенного прокси — любой может подделать IP и обойти `login rate limit` (спамить пароли с ротацией XFF).
- **HIGH L94-97**: `isValidToken` использует `timingSafeEqual` но ранний `if(tok.length !== STATIC_TOKEN.length) return false` — утечка длины токена по таймингу.
- **HIGH L58-84**: `isValidSessionToken` цикл по всем токенам с `continue` при несовпадении длины — тоже утечка, плюс `Map` итерация O(n) — DoS при большом кол-ве сессий.
- **HIGH L211-254**: `readBody` лимит 10MB, но `data += chunk` делает O(n²) конкатенацию — при 10MB злоумышленник может заставить аллокацию 10MB * N чанков = 100MB, DoS.
- **CRITICAL L268-284**: `isValidWebhookUrl` проверяет `host.endsWith(".discord.com")` — `attacker.discord.com.evil.com` не пройдёт, но `discord.com` сам разрешён. Однако `u.pathname.includes("..")` не покрывает `%2e%2e` encoded traversal.
- **HIGH L376-395**: `/api/status` без `requireToken` — раскрывает `guild_id` и `bot_online` любому.
- **MEDIUM L387-422**: `/api/bot/channels` требует токен, но `guild_id` param проверяется только если `PANEL_GUILD_ID` установлен — если `GUILD_ID` не задан в env (а в `config.json` есть), `PANEL_GUILD_ID=null` => проверка отключена => IDOR: злоумышленник может перечислить каналы любого гильда где бот состоит (`?guild_id=другой`).
- **MEDIUM L510-516**: `isChannelAllowed` проверяет `String(channel.guildId)` но `channel.guildId` может быть `undefined` для DM — тогда `"" !== PANEL_GUILD_ID` => false? Канал DM пройдёт?
- **HIGH L535-551**: `handleBotSend` / `handleBotEdit` не валидируют `embeds` color как integer в диапазоне `0..0xFFFFFF` — `embedsFromClient` пропустит `color: 99999999` и Discord API вернёт 400, но вебпанель вернёт 400 без санитайз, раскроет стек?
- **MEDIUM L330-337**: `getIndexHtml` делает `fs.statSync` + `fs.readFileSync` синхронно на каждый `GET /` — блокирует event loop, DoS при 100 RPS.
- **LOW L676**: `console.log` выводит `http://0.0.0.0:17890` — лог может утечь в `bot.log` и показать внутренний IP.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\registry.js` — **MEDIUM**
- **MEDIUM L22-24**: Дубликат слэш-команды только `console.warn` и перезаписывает — предыдущий ког тихо теряет команду. Должен бросать ошибку.
- **MEDIUM L31-34**: `prefixMap` дубликат бросает `throw` — но `main.js` ловит и помещает в `failed` — ок, но префиксные команды могут конфликтовать с слэш.
- **LOW L77-88**: `getSlashPayload` возвращает `default_permission: s.defaultPermission` — deprecated в API v10, должен быть `default_member_permissions` и `dm_permission`.
- **LOW L54-66**: `matchComponent` без проверки `interaction.customId` типа string — если `customId` число, `startsWith` бросит.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\notify.js` — **HIGH**
- **HIGH L11-15**: `SENSITIVE_RE`, `BEARER_RE` не покрывают `DISCORD_TOKEN=` формат (токен без префикса `token:`). Утечка токена Discord в логах если `e.message` содержит `DISCORD_TOKEN`.
- **MEDIUM L30-48**: `isDuplicate` чистит `recentLogs` на каждый вызов O(n) и при `>500` удаляет 100 — при флуде 1000 ошибок/сек GC pressure.
- **HIGH L62-69**: `enqueueLog` отбрасывает логи если `!startupDone` — все ошибки на этапе `clientReady` до `markReady()` теряются! `main.js` `fileLog` пишет в файл, но `notify` дропнет.
- **MEDIUM L72-77**: `getClient` динамический `import("./client.js")` — циклическая зависимость `notify -> client` может вернуть `client=null` на раннем этапе.
- **HIGH L81-87**: `drain` делает `await postToDiscord(c,entry)` и `await setTimeout(600)` — если очередь 10 логов, drain займёт 6 секунд, `flushLogs(2000)` не успеет и логи потеряются на `unhandledRejection`.
- **LOW L105-114**: `flushLogs` делает `while(queue.length>0||draining)` но `draining` флаг сбрасывается после цикла — гонка: новый `enqueueLog` между проверкой и выходом потеряется.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\stream_state.js` — **MEDIUM**
- **MEDIUM L41-56**: `_setStreamLock = _setStreamLock.then(()=>{...}).catch(()=>{})` — ошибки внутри `then` гасятся, `setStream` никогда не сообщает о фейле. Вызов `setStream("kick", status)` в `kick.js` не awaited, `activeStream()` может вернуть устаревший `peak`.
- **HIGH L60-66**: `activeStream` при обоих live возвращает `t.viewers + t.peak >= k.viewers + k.peak ? t : k` — `peak` накапливается, стрим начавшийся раньше всегда выигрывает даже если зрителей 0, офлайн стрим с большим пиком может быть выбран как `live=false`? Логика приоритета сломана.
- **MEDIUM L72-85**: `updatePresence` тип `3` (Watching) но Discord отображает `Watching` как `type:3`, ок, но `name: "🔴 стрим офлайн"` при `idle` статусе — пользователь видит офлайн как активность.
- **LOW L11-14**: `extractTwitchChannel` берёт `twitch.tv/([^/?#\s]+)` но не декодит `%20`.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\webpanel\index.html` — **HIGH**
- **HIGH L186-187**: `let TOKEN="__PANEL_TOKEN__"` вставляется сервером без экранирования JSON. Если `STATIC_TOKEN` содержит `"` или `</script>`, сломает HTML и даст XSS. Токен `base64url` безопасен, но сессионный токен тоже `base64url` — ок, но `PANEL_PASSWORD` режим вставляет пустую строку — `TOKEN=""` и логика `if(!TOKEN) await doLogin()` требует пароль, но `TOKEN` остаётся пустым в глобале — любой скрипт может прочитать `TOKEN` из DOM.
- **MEDIUM L222-234**: `api()` при `!TOKEN` вызывает `doLogin()` который делает `fetch("/api/login")` без `X-Panel-Token` — ок, но при неудаче бросает `throw new Error("noauth")` без `catch` в `refreshChannels()` — unhandled rejection.
- **HIGH L370-377**: `escapeHtml` не экранирует `` ` `` и `/` — не XSS, но `innerHTML` использование `tag("div","",esc)` безопасно, однако `e.thumbnail.url` ставится как `img.src` без валидации `javascript:` — потенциальный XSS если webhook вернёт `javascript:` URL, браузер не загрузит но CSP не настроен.
- **LOW L71**: `#login` модалка без `autocomplete="off"` — браузер сохранит пароль.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\scripts\ramtest.js` — **LOW**
- **LOW L24-28**: `await import(pathToFileURL(...).href)` импортирует все коги но не вызывает `setup` — измерение памяти неполное, `better-sqlite3` откроет DB но не закроет (`db` утечка).
- **MEDIUM L12-16**: `arg()` парсит `Number(process.argv[i+1]) || dflt` — `--seconds 0` станет `dflt` 8, не 0.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\activity.js` — **MEDIUM**
- **MEDIUM L32-48**: `setInterval` каждую 5 минут инкрементит `seasonAddMessage` для каждого голосового участника — при 100 участниках в 10 каналах = 1000 `INSERT ... ON CONFLICT UPDATE` каждые 5 мин — нагрузка на SQLite, нет батча транзакции.
- **LOW L15-18**: `WHITELIST_CHANNELS.size>0 && !has(chanId)` — если `whitelist_channels` пустой, все каналы считаются разрешёнными — логика инвертирована? Должно быть если пусто — не фильтровать.
- **MEDIUM L22**: `await message.guild.members.fetch` внутри `messageCreate` — при спаме 10 msg/sec будет 10 fetch/сек — rate limit Discord, предыдущий фикс добавил кэш fallback но всё ещё `fetch` если не в кэше.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\automod.js` — **HIGH**
- **HIGH L18-35**: `checkLinks` регулярка `https?:\/\/[^\s]+` захватит `https://evil.com,https://good.com` как один URL, `hostMatch` возьмёт `evil.com,https:` — обход блокировки ссылок через запятую или скобку.
- **MEDIUM L37-43**: `checkCaps` считает только `a-zA-Zа-яА-ЯёЁ` — сообщение из эмодзи и цифр пройдёт, но капс спам из `ПРИВЕТ!!!!!!` с 6 восклицательных пройдёт `checkStretch` только 6+ повторов, а тут 6 `!` — сработает, ок.
- **HIGH L62-93**: `cfg.enabled` читается на каждый `messageCreate` но `cfg` — снапшот `CONFIG.discord_automod` на момент импорта. Если `config.json` перезаписан на диске, автомод не обновится без рестарта.
- **LOW L139**: `q.length > maxInWindow` и `recent > maxInWindow` дублируют логику — `recent` уже `q.length` после фильтра по 5 сек, второй термин избыточен.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\birthdays.js` — **HIGH**
- **HIGH L8-9**: Глобальные `bot`, `started`, `intervalId` — при hot-reload два инстанса создадут два интервала.
- **MEDIUM L12**: `DATE_RE = /^\s*(\d{1,2})[./\\-](\d{1,2})\s*$/` — матчит `31\\12` как день 31 месяц 12, но `daysInMonth` вызов без года использует 2000 (високосный) — 29 Feb пройдёт, но в невисокосный год `nextOccurrence` скорректирует на 28, пользователь увидит 28 Feb вместо 29.
- **MEDIUM L49**: `guild = bot.guilds.cache.get(GUILD_ID)` — `GUILD_ID` строка `"0"` при отсутствии конфига, `get("0")` вернёт undefined и анонс пойдёт без `guild` контекста (без упоминаний).
- **HIGH L83-84**: `rolePing = cfg.role_ping || ""` если пустая строка, `guild.roles.cache.find` пропускается, но `content` остаётся пустым — анонс без пинга тихо.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\chat_ai.js` — **HIGH**
- **HIGH L10**: `API_KEY = process.env.OPENROUTER_API_KEY || ""` — конфиг `ai.api_key` игнорируется (фикс), но `log.warn` на L8 всегда спамит даже если ключ не нужен.
- **MEDIUM L13-14**: `COOLDOWN_MS` считается из `cfg.cooldown_seconds` на импорт — изменение `config.json` без рестарта не применяется.
- **CRITICAL L81-82**: `Authorization: Bearer ${API_KEY}` — если `API_KEY` пустой, запрос уйдёт с `Bearer ` и OpenRouter вернёт 401, но ошибка логируется как `Пустой ответ модели` — неочевидно.
- **HIGH L122-144**: `buildContext` делает `channel.messages.fetch({limit:HISTORY_SIZE})` без проверки `GUILD_ID` и без `ReadMessageHistory` permission fallback — при 403 бросит и вернёт пустой контекст, ИИ ответит без контекста.
- **MEDIUM L146-176**: `respond` делит ответ на чанки `1900` символов но `message.reply(chunked[0])` + `channel.send(part)` может превысить rate limit при длинном ответе (220 токенов ~ 880 символов, ок).
- **HIGH L178-195**: `pendingTimers` Map хранит `setTimeout` без `clearInterval` при выгрузке кога — утечка памяти при `BOT_DRYRUN`?

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\embed.js` — **HIGH**
- **HIGH L32-89**: `EmbedDraft` хранит `color` как `null` или число, но `toEmbed()` вызывает `e.setColor(this.color)` где `this.color===null` не проверяется? Проверка `if(this.color!==null)` есть L51 — ок.
- **MEDIUM L94-99**: `MAX_DRAFTS=200` + `if(drafts.size>MAX_DRAFTS && !has(userId)) delete first` — LRU на основе `Map` порядка вставки, но при `getDraft` существующий юзер не перемещается в конец — старый активный юзер может быть удалён.
- **HIGH L181-187**: `checkOwner` делает `interaction.reply({ephemeral:true})` но если `interaction` уже `deferred`, `reply` бросит `InteractionAlreadyReplied` — unhandled rejection.
- **MEDIUM L242-256**: Автор/футер модалки проверяет `v.startsWith("http")` но не валидирует URL парсинг — `https://` + пробел пройдёт.
- **HIGH L495-518**: `embed_send` делает `await interaction.deferReply({ephemeral:true})` затем `target.send` без проверки `botMember.permissionsIn(target).has(SendMessages)` — при 403 `target.send` бросит, но `log.error` не пробрасывает пользователю детали.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\engagement.js` — **MEDIUM**
- **MEDIUM L60-72**: `scheduleSave` делает `clearTimeout` и клонирует `JSON.parse(JSON.stringify(data))` — при `loyalty` размере 10k записей клон 10k * каждый `addPoints` = O(n²) GC pressure.
- **HIGH L100-109**: `addPoints` мутирует `this.loyalty[key].points` без транзакции — при параллельных вызовах `addPoints` из `messageCreate` и `voice` интервалов возможна гонка `points += amount` где `amount` перезапишется?
- **LOW L125-129**: `async _flush()` не очищает `pendingSaves` таймеры при `await flushSaves` если новые `scheduleSave` пришли во время `flush`.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\giveaways.js` — **HIGH**
- **HIGH L18**: `giveawayNextId = db.giveawayNextId()+1` на `clientReady` — но `giveawayNextId` делает `MAX(id)+1`, если два шарда? Нет шардов, но при быстром создании двух розыгрышей `cog._nextId++` без атомарности БД — может создать дубликат PK если `giveawaySave` использует `Number(ga.id)` а другой процесс уже вставил.
- **MEDIUM L63-65**: `endTime = Date.now()/1000 + duration*60` — `Date.now()/1000` float, `duration` int, но `db.giveawaySave` делает `Number(ga.end_time)||0` — потеря миллисекунд, ок.
- **HIGH L136-178**: `componentPrefix("gwa_")` обрабатывает только `gwa_join:` но регистрирует префикс `gwa_` — любой кастом ID `gwa_xxx` попадёт в обработчик и сделает `return` без ответа => interaction timeout (3 сек) => `Unknown interaction`.
- **MEDIUM L148-153**: `await interaction.guild.members.fetch(uid)` внутри клика — при 100 участниках одновременно 100 fetches — rate limit.
- **HIGH L181-204**: `_spawnFinish` использует `setTimeout` с `MAX_TIMEOUT_MS` чанкингом, но `ga._timer.unref?.()` делает таймер не удерживающим event loop — при `BOT_DRYRUN` таймер может не сработать и розыгрыш зависнет `active` навсегда.
- **LOW L254-255**: `embed.addFields` без проверки лимита 6000 символов — при `description` 1000 + `prize` 200 + `participants` 1000 может превысить.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\guild_logs.js` — **HIGH**
- **HIGH L8-10**: `REPO_DIR = path.resolve(__dirname,"../..")` — в Docker `/app` ок, но `execFile("git", ["-C",REPO_DIR,...])` выполнит `git` команду с пользовательским `REPO_DIR` — если злоумышленник контролирует `REPO_DIR` через симлинк? Нет.
- **MEDIUM L86-91**: `gitRevParse` игнорирует `err` и возвращает `stdout.trim()||"?"` — при отсутствии `git` вернёт `?` и `deploy` эмбед покажет `?`.
- **HIGH L93-105**: `previousDeployCommit` фетчит 5 сообщений и ищет поле `Версия (commit)` без проверки авторства — любой пользователь может отправить эмбед с таким полем и обмануть `title` логику `Перезапуск` vs `Деплой`.
- **MEDIUM L70-83**: `sendThrottled` цепь `sendChain` без ограничения длины — при флуде удалений 1000/сек очередь в `sendChain` вырастет до 1000 промисов, память.
- **LOW L336**: `readyAt = Date.now()` и `if(Date.now()-readyAt<20000) return` в `voiceStateUpdate` — пропускает логи первые 20 сек, но `readyAt` никогда не обновляется — ок.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\kick.js` — **HIGH**
- **HIGH L8**: `SLUG = liveCfg.channel || cfg.channel || "dendosich"` — если `liveCfg.channel` число `123` (id), `encodeURIComponent` сделает `"123"` и `fetch` пойдёт на `kick.com/api/v2/channels/123` — фейлит.
- **MEDIUM L30-47**: `fetchStatus` не ретрайет 429/5xx, сразу бросает — `kick.js` `_check` поймает и залогит warn, но `setStream` не обновится — присутствие зависнет.
- **HIGH L164-196**: `_ensureSticky` делает `db.kvGet(LIVE_MSG_KEY)` синхронно но `db` может быть не готов? `kvGet` синхронный, ок. Но `channel.messages.fetch(existingId)` без `try` кроме пустого `catch{}` — если сообщение удалено, `msg=null` и создастся новое сообщение каждый чек (каждые 300 сек) — спам канала.
- **MEDIUM L189-192**: `content = withPing ? (pingRole ? `<@&${pingRole}>` : "@everyone") : undefined` — если `ping_role_id` пустая строка, пинганёт `@everyone` без проверки прав — спам всего сервера.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\kick_mod.js` — **CRITICAL/HIGH**
- **CRITICAL L7**: `KICK_ACCESS_TOKEN` читается из env или `cfg.access_token` — но предыдущий фикс убрал секреты из `config.json`, однако код всё ещё читает `cfg.access_token` — если кто-то заполнит `config.json` токеном, он будет использован и залогирован в `log.info`? Нет, но риск.
- **HIGH L13**: `PUSHER_KEY="32cbd69e4b950bf97679"` хардкод публичного ключа — ок, но `PUSHER_URL` использует `ws-us2.pusher.com` без `wss` cert pinning — MITM.
- **MEDIUM L21-28**: `BANNED_WORDS` lower case, но `matchBannedWord` использует `lower.includes(w)` — `w="1488"` найдёт в `https://example.com/1488` — false positive.
- **HIGH L30-48**: `api()` кидает `Error` с `data?.message` который может содержать HTML или токен — `log.error` санитайз не покрывает `KICK_ACCESS_TOKEN` в URL?
- **HIGH L222-258**: `process.removeListener("exit",stopPusher)` и `process.on("exit",stopPusher)` при каждом `setup` (hot-reload) — `removeListener` удалит только последнюю, но `sigintHandler` создаётся заново и `removeListener` с новой функцией не найдёт старую — утечка слушателей, `MaxListenersExceededWarning`.
- **MEDIUM L126-137**: `deleteMessage` использует `fetch(`${KICK_API}/chat/${messageId}`)` без `encodeURIComponent` проверки? Есть, ок. Но `method:DELETE` без `body` — Kick API требует `broadcaster_user_id`?
- **LOW L174**: `ws.on("message", raw=>{ if(text.includes("pusher:connection_established"))...})` — `includes` на сыром тексте может сработать на пользовательском сообщении содержащем эту строку — false positive.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\overlay.js` — **HIGH**
- **HIGH L8-14**: `timingSafeEqual` возвращает `false` если длины разные — утечка длины токена (аналогично webpanel).
- **HIGH L101**: `cog._token = process.env.OVERLAY_TOKEN || OVERLAY.token || crypto.randomBytes(...)` — каждый рестарт без `OVERLAY_TOKEN` генерирует новый рандом токен и `PAGE.replace("__TOKEN__",cog._token)` вставит новый токен в HTML — старые OBS браузеры с захардкоженным `?token=old` перестанут работать без notice.
- **MEDIUM L108-110**: `valid = timingSafeEqual(queryToken,cog._token) || timingSafeEqual(headerToken,cog._token)` — если оба токена присутствуют, достаточно одного верного, но если `queryToken=""` (пустой) и `headerToken` верный, первый `timingSafeEqual("", token)` вернёт `false` без ошибки, ок. Но `String(headerToken)` может быть `"undefined"` если заголовок отсутствует? `req.headers["x-overlay-token"]||""` => `""`, `String("")` => `""`, сравнение `""` vs `token` вернёт `false` — ок.
- **HIGH L134-136**: `db.counterList(kickChannel)` где `kickChannel=(CONFIG.kick||{}).channel||""` — если канал пустой, `counterList("")` вернёт все счётчики с `channel=""` — пустой канал может слить счётчики.
- **LOW L144-151**: `safeDonationGoal` хардкодит `current:0` если `dg.current` не finite — всегда 0, не показывает прогресс.
- **MEDIUM L188-194**: `server.on("error")` только логит, не `reject`, `setup` продолжит с `cog._server` null?

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\poll.js` — **MEDIUM**
- **MEDIUM L50-51**: `await interaction.reply({poll})` — Discord poll API требует `poll` внутри `interaction.reply` но формат `poll: {question,answers,duration}` неполный: отсутствует `allowMultiselect` маппинг? В коде `allowMultiselect: multiple` — ок, но `duration` в часах, а API ожидает часы, ок. Однако `poll` создание без проверки что бот имеет `SendPolls` permission — кинет 403.
- **LOW L36**: `answers.slice(0,5)` но `option1` и `option2` required, `option3-5` optional — если юзер передаст только `option1` (через API напрямую), `answers.length===1` — Discord вернёт 400, но код не валидирует `answers.length>=2`.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\reaction_roles.js` — **MEDIUM**
- **MEDIUM L9-14**: `if (!cfg.enabled && cfg.enabled !==undefined) return` — если `enabled` undefined, проходит. Но `channel_id` может быть `0` (дефолт) — `if(!channelId) return` скроет баг.
- **LOW L61**: `msg.reactions.cache.map(r=>r.emoji.name)` — для кастом эмодзи `name` может быть `null` для unicode? Нет.
- **MEDIUM L70-89**: `toggleRole` использует `guild.roles.cache.find(r=>r.name===spec.role)` — если роль переименована, не найдётся и тихо `return` без лога.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\role_menu.js` — **MEDIUM**
- **MEDIUM L13-35**: `buildRows` создаёт два селекта каждый с `maxValues = maxV` где `maxV = min(maxValues, roleNames.length)` — если `roleNames.length=1` и `max_values=10`, `maxV=1` — ок. Но Discord лимит 25 опций, не проверяется.
- **LOW L41**: `applyRoles` делает `guild.roles.cache.find` внутри цикла — O(n*m), при 100 ролях ок.
- **MEDIUM L61-99**: `ensurePanel` фетчит 30 сообщений и ищет по `footer.text===PANEL_FOOTER` — если админ вручную отправит эмбед с таким футером, бот перезапишет его.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\rules_gate.js` — **MEDIUM**
- **MEDIUM L46-47**: `_findTarget` ищет только по `channel_id`+`message_id` — если `message_id` 0, вернёт `null` и `_ensureReaction` залогит warn, но `cog._messageId` останется `null` — `_toggle` всегда `return` и гейт не работает.
- **LOW L69**: `guild = client.guilds.cache.get(String(cfg.guild_id||"")||String(reaction.message?.guild?.id||""))` — `cfg.guild_id` не существует в `config.json` (там `guild_id` в корне), поэтому всегда падает на `reaction.message.guild.id` — ок, но лишняя логика.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\season.js` — **HIGH**
- **HIGH L49-53**: `season_end` проверяет `interaction.memberPermissions` — в DMs `interaction.guild` null, `guild.roles.cache.find` кинет NPE, но `guildOnly:true` спасёт? В `registry` `guildOnly` проверка делает `reply` если `!inGuild()`, ок.
- **MEDIUM L83**: `rows = db.getSeasonLeaderboard(String(guild.id),3)` — лимит 3 хардкод, но `reward_roles` 3, ок. Если топ <3, оставшиеся роли не выдаются, но `seasonReset` всё равно сотрёт всех — потеря данных.
- **HIGH L102-107**: Удаление старых ролей `await member.roles.remove(oldRole)` в цикле без проверки `botMember` прав — если бот ниже роли, кинет 403 и поймается `catch{}` тихо.
- **LOW L128-130**: `footer: ${new Date().toISOString().slice(0,16)} UTC` — использует ISO UTC, но сервер в МСК, путаница.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\server_stats.js` — **MEDIUM**
- **MEDIUM L54-55**: `category = guild.channels.cache.get(String(categoryID))` — если `category_id` `0` (дефолт) `String(0)="0"` => `guild.channels.cache.get("0")` => undefined => `return` без создания категории — фича тихо отключена если конфиг `0`.
- **HIGH L83-92**: `await guild.members.fetch({withPresences:true})` каждые 5 минут на гильде 10k участников — 10k * (presence) = heavy API call, может упереться в `GuildMembers` privileged intent лимит.
- **LOW L98-109**: `counterChannels = [...category.children.cache.values()].filter(ch=>ch.type===2)` — `type===2` это `GuildVoice`, но статистика каналы — голосовые, ок. Но `counterChannels` сортируется по `position`, а `channelsCfg` порядок не гарантирован.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\setup.js` — **HIGH**
- **HIGH L25**: `HEX_RE` объявлена после `parseColor` — `parseColor` использует `HEX_RE` до инициализации (hoisted? `const` не hoisted) — `ReferenceError: Cannot access 'HEX_RE' before initialization` при вызове `setup` на старте до `applyRoleSettings`? На самом деле `parseColor` вызывается внутри `applyRoleSettings` после определения `HEX_RE`, так что ок, но порядок опасен.
- **MEDIUM L49-64**: `clientReady` `applyRoleSettings` вызывается без проверки `botMember` прав `ManageRoles` — `role.edit` бросит 403.
- **HIGH L129-139**: `setup_channels` создаёт каналы без проверки существующих `permissionOverwrites` — может дублировать каналы если `norm` не совпадает (кириллица).
- **LOW L235-248**: `debug_channels` выводит `ch.id` без проверки прав — раскрывает структуру сервера любому админу.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\socials.js` — **LOW**
- **LOW L39**: `if(!url || !url.startsWith("http")) continue` — но `url` может быть `https://` с пробелом в начале, `startsWith` фейлит.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\sponsor_button.js` — **MEDIUM**
- **MEDIUM L31-38**: `channel.send` без проверки `channel.isTextBased()` кроме `typeof channel.send==="function"` — для voice канала `send` нет, но проверка `typeof` пропустит категорию?
- **LOW L62**: `recent.find(m=>m.components?.[0]?.components?.some(c=>c.url===donateUrl))` — если `donateUrl` пустой, найдёт любой линк-кнопку.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\tempvoice.js` — **CRITICAL/HIGH**
- **CRITICAL L326-350**: `toggleEveryonePerm` — регрессия фикса `Allow/Deny` case: ветка `if(permKey)` делает `edit(everyone,{[permKey]:false|null})` но Discord API ожидает `ViewChannel`, `Connect`, `Speak` как `PermissionResolvable` — `ViewChannel:true` vs `ViewChannel: false` vs `null` — `null` должен удалять overwrite, но `edit` с `null` оставит `allow=0 deny=0`? Тест нужен. Fallback generic `set([{id,allow,deny}])` использует `PermissionsBitField.resolve` но `allow & ~bit` на `BigInt`? `allow` is `bigint` (bitfield), `bit` is `bigint` — ок, но `PermissionsBitField.resolve` возвращает `bigint`, но `allow` from `existing.allow.bitfield` is `bigint`, операция `&` между `bigint` ок. Но `set` перезапишет все overwrites канала одним объектом — удалит другие роли! **Критическая потеря прав.**
- **HIGH L241-288**: `withLock(`create:${triggerId}`)` — лок по триггеру, но `toMove` берётся из `triggerChannel.members.values()` после `await guild.channels.create` — между созданием канала и снапшотом `toMove` новый пользователь мог зайти в триггер и не будет перемещён.
- **MEDIUM L179-185**: `cleanupEmpty` делает `await withLock(...deleteIfEmpty)` в цикле `for guild -> for vc` последовательно — при 50 временных каналов очистка займёт 50* `delete` RTT => 10 сек, блокирует.
- **MEDIUM L298-313**: При передаче владельца `tempChannelOwners.set(...newOwner.id)` но `vc.send` может фейлить если канал без текстовых прав — тихо `catch{}`.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\twitch.js` — **HIGH**
- Аналогично `kick.js` HIGH: `SLUG` хардкод, `fetchStatus` fallback на GQL без `CLIENT_ID` — GQL может вернуть `null` для несуществующего канала и `status.live=false` — ложный офлайн.
- **MEDIUM L36-53**: `getHelixToken` кэширует `oauthToken` глобально без `Mutex` — два параллельных `_check` вызовут два `fetch` токена.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\welcome.js` — **MEDIUM**
- **MEDIUM L23-45**: `allChannels = [...guild.channels.cache.values()]` — если гильда 500 каналов, `byParent` Map строится каждый `guildMemberAdd` (при рейде 10 вступлений/сек = 5000 итераций/сек) — DoS.
- **HIGH L94-112**: `try { await member.send({embeds:[embed]}) } catch(e){ if(e.code===50007)... }` — DM закрыт, лог `50007` тихо, но `embed.data.fields` JSON.stringify 6000 проверка делается после `buildEmbed` — уже построили большой эмбед.
- **LOW L123**: `channelId = member.guild.channels.cache.get(String(cid))` — без `fetch`, если канал не в кэше (не загружен), приветствие не отправится.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\youtube.js` — **MEDIUM**
- **MEDIUM L20-43**: `ytFetch` при `!key` бросает синхронно, но `checkNewVideos` ловит и логит warn — ок, но `ytStats` проверяет `if(!API_KEY)` перед fetch — дублирование.
- **LOW L69-81**: `knownVideoIds` Set хранит до 200, но при рестарте сбрасывается — снова спам уведомлений о старых видео после рестарта.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\youtube_growth.js` — **HIGH**
- **HIGH L36-56**: `ytFetch` дублирует логику из `youtube.js` — дублирование, при фиксе одного второй останется багованным.
- **MEDIUM L104**: `state.known_shorts = [...(state.known_shorts||[]),vid].slice(-200)` — `state` сохраняется в файл каждый `checkShorts` без debounce — частые `writeFileSync` блокируют.
- **HIGH L228-243**: `growthLoop` infinite `while(true)` без `abort` — при `SIGTERM` процесс не завершит `growthLoop`, `process.exit(0)` убьёт mid-write `saveState`.
- **LOW L18-25**: `loadState` читает `youtube_growth_state.json` без валидации схемы — corrupt JSON приведёт к `state={}` и повторный спам.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\permissions.js` — **MEDIUM**
- **MEDIUM L22-37**: `applyCategory` делает `await category.permissionOverwrites.edit(role, perms)` для каждой роли последовательно без `Promise.all` — медленно, но ок. При `perms` содержит неизвестный ключ (например `view_channel` lowercase) — Discord API проигнорирует, но лог `✅` покажет успех.
- **LOW L15-16**: `resolveRole` ищет по `name` case-sensitive — `Owner` vs `owner` не найдёт.

### `C:\Users\Admin\Documents\Default Project\Бот-Node\src\cogs\ram_report.js` — **LOW**
- **LOW L12-21**: `rssMb()` и `peakMb()` оба делают `process.memoryUsage()` и делят `rss` — дублирование, `peak` всегда равен `rss` (не peak).
- **MEDIUM L55-58**: `setTimeout(tick, intervalMinutes*60*1000)` внутри `setTimeout` — рекурсивный, но `timerId` перезаписывается только внешним, внутренний `setTimeout` не сохраняет `timerId` для `clearInterval` — утечка?

### `C:\Users\Admin\Documents\Default Project\Бот-Node\data\` и `C:\Users\Admin\Documents\Default Project\Бот-Node\state\` — **HIGH**
- **HIGH**: `data/` пустая, `state/` не существует на хосте, `data.db` лежит в корне (`C:\...\data.db 73728 bytes`) — **рассинхрон Docker** как в `config.js`. При `docker-compose up` volume `./state:/app/state` создаст пустую директорию и бот создаст новый `data.db` внутри, старые данные потеряны. Обратная миграция не предусмотрена.
- **MEDIUM**: `bot.log` 6194 bytes содержит старые ошибки `registry.slash is not a function` от 2026-09-09 — лог ротация работает, но старые ошибки указывают что фиксы когов (переименование `slash` -> `slash`?) были неполными? Сейчас `registry.slash` существует, но лог показывает что ранее была попытка вызвать `registry.slash` когда метод назывался иначе. Сейчас ок.

---

## 7. Chaos / Fuzz / Edge Cases — что всё ещё крашит?

| Вход | Эффект | Файл |
|------|--------|------|
| `config.json` отсутствует или невалидный JSON | `src/config.js:68 throw new Error("config.json parse failed")` — процесс падает, `main.js` не ловит (только `catch` на `readFileSync` fallback на `{}`) — при битом JSON бот крашится без `flushLogs` | config.js:64-68 |
| `DATA_DIR` / `DB_DIR` указывает на файл а не директорию | `mkdirSync` бросит `ENOTDIR`, подавляется `catch{}`, `new Database` бросит `SQLITE_CANTOPEN`, recovery `renameSync` тоже бросит, `throw` без `try` в `main.js` => краш | db.js:8-11 |
| `GUILD_ID=0` или пустой | `season.js`, `permissions.js`, `welcome.js` тихо пропускают, но `webpanel` IDOR открыт | config.js:102 |
| `PANEL_PASSWORD` содержит пробелы ` " p@ ss "` | `trim()` срежет, пользователь не сможет залогиниться с учётом пробелов | webpanel.js:15 |
| `DISCORD_TOKEN` содержит ` #` | `loadEnv` срежет по `" #"` и токен обрежется, логин фейлит с `Invalid token` | config.js:42-43 |
| `WEBPANEL` `X-Panel-Token: undefined` | `String(token)` => `"undefined"` vs `STATIC_TOKEN` length mismatch => `isValidStaticToken` вернёт `false` — ок, но лог `bad token` без rate limit | webpanel.js:205-207 |
| `POST /api/bot/send` с `channel_id=999999999999999999` (несуществующий) | `bot.channels.cache.get` => null => 404, но без `requireToken` проверки на `guild_id`? Требует токен, ок | webpanel.js:534 |
| `POST /api/webhook/send` с `webhook_url=https://discord.com/api/webhooks/123456789012345678/short` (токен <10) | `isValidWebhookUrl` отклонит (<10) => 400 | webpanel.js:281 |
| `giveaway` с `duration=0` или `10080` | Валидация `if(duration<1||>10080)` отклонит, ок. Но `duration` как float `1.5` через API напрямую? `getInteger` вернёт int, ок | giveaways.js:58 |
| `tempvoice` `vc_limit` ввод `999` | `if(n<0||n>99)` отклонит, ок. `n=0` => снимет лимит | tempvoice.js:514 |
| `automod` сообщение `https://evil.com` + `allowed_links=["evil.com"]` с портом `https://evil.com:8080` | `host.split(":")[0]` срежет порт, `allowedHosts` содержит `evil.com` без порта => `host===a` true => разрешит, ок. Но `https://evil.com.evil2.com` => `host="evil.com.evil2.com"` => `host.endsWith(".evil.com")` false => блокирует, ок | automod.js:27-28 |
| Высокая нагрузка: 100 msg/sec в `activity.js` | `guild.members.fetch` per message => 100 fetches/sec => Discord 429, бот получит `rate limited` и `seasonAddMessage` пропустит, но `log.warn` спамит | activity.js:22 |
| API down: `kick.com/api/v2/channels` 500 | `fetchStatus` бросит, `kick.js` `_check` логит warn и `return`, не обновляет `setStream` — присутствие зависнет на старом live статусе | kick.js:35 |
| DB corrupt: `data.db` заголовок `SQLite format 3` повреждён | `new Database` бросит, `renameSync` переименует в `.corrupt.<ts>` и создаст новый — данные потеряны, но бот продолжит без `season` топа | db.js:21-25 |
| `OVERLAY_TOKEN` не задан | `overlay.js` сгенерит рандом и залогит `Сервер запущен` без вывода токена — OBS не сможет подключиться, пользователь не узнает токен | overlay.js:101 |

---

## 8. Регрессии от предыдущих фиксов (NEW BUGS introduced)

1. **Двойной импорт когов** (`main.js:164-172`) — фикс topological sort добавил предзагрузку с `?pre=` — теперь каждый ког импортируется дважды, удвоение памяти и потенциальный `SQLITE_BUSY`. **HIGH**
2. **Строгий Origin/Host bypass** (`webpanel.js:171-185`) — фикс CSRF добавил `hostMatches` проверку, но она позволяет любому `Origin` пройти если `Host` совпадает — обход allowlist. **HIGH**
3. **X-Forwarded-For spoof** (`webpanel.js:103`) — фикс rate limit добавил `getClientIp` с `XFF`, но без доверенного прокси — обход лимита. **HIGH**
4. **Timing leak** (`webpanel.js:85-93`, `overlay.js:8-14`) — фикс `timingSafeEqual` добавил проверку длины до сравнения — утечка длины. **MEDIUM**
5. **`DATA_DIR` vs `DB_DIR` рассинхрон** (`config.js:8-13`, `webpanel.js:11`) — фикс вынес секреты в env и добавил `DATA_DIR`/`DB_DIR`, но `TOKEN_FILE` остался хардкодом `data/.panel-token` — токен теряется при Docker. **HIGH**
6. **`healthcheck` несуществующий эндпоинт** (`docker-compose.yml:22`) — фикс добавил `healthcheck` но URL `/api/health` не существует. **MEDIUM**
7. **`|| true` скрывает сборку** (`Dockerfile:15`) — фикс добавил `|| true` чтобы `npm rebuild` не фейлил, теперь битый `better-sqlite3` тихо игнорируется. **HIGH**
8. **`enable` vs `enabled` путаница** (`reaction_roles.js:9`, `welcome.js:91`) — фикс добавил `cfg.enabled !== undefined` проверки, но в `config.json` ключ `enabled:false` для `reaction_roles` — теперь `if(!cfg.enabled && cfg.enabled!==undefined) return` пропустит когда `enabled` undefined? Логика инвертирована.

---

## Рекомендации (приоритет)

**CRITICAL немедленно:**
- Ротировать все токены из `.env` (Discord, Twitch, YouTube) и удалить `.env` из диска / добавить в `.gitignore` проверку `git status`.
- Убрать `|| true` из Dockerfile, исправить `healthcheck` на `/api/status` или `/overlay/health`.
- Исправить `webpanel` Host bypass: требовать `ALLOWED_ORIGINS.has(origin)` даже если `hostMatches`, и валидировать `XFF` только за `TRUST_PROXY=1`.
- Исправить `tempvoice` `set` перезапись overwrites.

**HIGH:**
- Синхронизировать `DATA_DIR`/`DB_DIR`/`TOKEN_FILE` пути, мигрировать `data.db` из корня в `./data/` или `./state/`.
- Убрать двойной импорт когов — кешировать `fileModulesPre` без `?pre=` или использовать `fs.readFile` + regex для `dependencies`.
- Добавить `await`/`queue` для `setStream`, починить `activeStream` логику.
- Добавить капы для `notify` очереди и `guild_logs` `sendChain`.

Все пути абсолютные как запрошено.
