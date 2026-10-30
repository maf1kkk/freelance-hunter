# freelance-hunter v2 — план разработки

> Цель: из «агрегатора, который агрегирует» сделать **универсальный агрегатор заказов и вакансий**
> с честной фильтрацией мусора, единым управлением аккаунтами и автооткликом.

---

## Статус: выполнено ✅

| Стадия | Состояние | Проверка |
|---|---|---|
| 0. Аудит | ✅ | 11 источников изучены, 6 старых багов найдены |
| 1. Ядро (`src/core/`) | ✅ | http, html, rss, model, dedupe, quality, settings, store, accounts, profile, notify, pipeline, time, text, ai, ai-profile, resume |
| 2. Источники (`src/sources/`) | ✅ | 11 из 11 работают, опрос 220–320 заказов за цикл |
| 3. Аккаунты и куки | ✅ | 5 форматов импорта, обзор по всем площадкам |
| 4. Автоотклик (`src/apply/`) | ✅ | dry-run + реальная отправка (fl.ru, kwork) |
| 5. Web UI | ✅ | 6 вкладок, 26 API-эндпоинтов |
| 6. MCP | ✅ | 26 инструментов |
| 7. CLI | ✅ | 20+ команд, включая `ai …` |
| 8. Тесты и документация | ✅ | 89 unit + 7 e2e-наборов = 286 проверок |
| 9. ИИ-подбор | ✅ | любые провайдеры, разбор резюме, подбор, советы |
| 10. Полный прогон | ✅ | найдено и починено 9 багов, все наборы зелёные |
| 11. SQLite-хранилище | ✅ | node:sqlite, миграция со старого JSON, индексы, WAL |
| 12. Подготовка к публикации | ✅ | LICENSE, CI, .env.example, SECURITY.md, CONTRIBUTING.md, личные данные убраны |
| 13. Фильтры и поиск | ✅ | инверсия источников, ранжирование поиска, покрыто тестами |

Проверка: `node test/run-all.js` → **286 проверок ок, 0 сломанных**.

### Баги, найденные и починенные в полном прогоне

1. `MCP set_settings` принимал только плоские параметры — вложенные (`{search:{…}}`) игнорировались.
2. `ai` без подкоманды показывал статус вместо справки.
3. `priceOverlap` считал пересечение диапазонов как длину → одинаковые точечные цены считались несовпадающими.
4. Дедуп склеивал разные заказы («Project Manager» ⊂ «Бизнес-аналитик / Project Manager»).
5. Дедуп не склеивал словоформы («Сверстать лендинг» ≠ «Вёрстка лендинга»).
6. Потеря данных при параллельной записи (CLI + веб-сервер) → файловая блокировка, затем `BEGIN IMMEDIATE`.
7. `max_tokens: 20` в тесте провайдера съедался reasoning-моделями → ложная «ИИ недоступен».
8. Уточняющий вопрос в отклике не различал бота и лендинг.
9. `stems`/`tokenize` дублировались в двух модулях → перенесены в `model.js`.

### Баги, найденные при переходе на SQLite

10. `LOWER()` в SQLite не работает с кириллицей → поиск сломался; добавлена колонка `search_text` с lowercase-текстом.
11. `BEGIN DEFERRED` давал «database is locked» при параллельной записи → `BEGIN IMMEDIATE`.
12. Recovery-ветка считала блокировку повреждением и переименовывала живую базу → проверка по коду ошибки.
13. `CREATE INDEX` по новой колонке ломал открытие старой базы → ALTER TABLE-миграция схемы.
14. Переоценка 1900 заказов занимала 28 с → кэш основ слов + отпечаток настроек: **1.2 с** (x22).
15. Название источника терялось при переезде в SQLite → колонка `source_label` + бэкфилл.

### Баги, найденные при разборе фильтров

16. **Чекбоксы источников работали наоборот**: снимаешь галочку с Telegram — остаётся **только** Telegram.
    Семантика переписана: `sources = null` = включены все, `[]` = не выбрано ничего.
17. Пустой фильтр источников/вердиктов трактовался как «фильтр не задан» → показывалось всё.
18. Чипы вердиктов дублировали состояние в HTML → теперь рисуются из состояния (один источник истины).
19. Поиск не ранжировался по релевантности → добавлена колонка `title_search` и сортировка:
    «заголовок начинается с запроса» → «целое слово в заголовке» → «слово в теле» → «остальное».
20. Telegram-опрос занимал **100 с** (отдельный Python-процесс на каждый канал) → один процесс на все
    каналы: **2.7 с**.
21. Таймаут Telegram-источника (45 с) не учитывал его специфику → свой лимит 120 с.

---


## Стадия 0. Аудит (сделано)

- [x] Разобрана вся кодовая база (20 файлов)
- [x] Проверены живые эндпоинты всех кандидатов-источников
- [x] Найдены баги: сломанный TG (неверный путь `.env`), `/api/poll` всегда 400,
      TG-id не открываются в UI/MCP, фильтр бирж сломан префиксом `alot:`, `npm test` без каталога
- [x] `freelance.habr.com` — **сервис закрыт навсегда** (410), выкидываем
- [x] `weblancer` / `freelanceru` / `youdo` — Cloudflare / таймаут / mobile-only API → отложить

### Источники (статус на 2026-08)

| Источник | Тип | Доступ | Реализация |
|---|---|---|---|
| alot.pro | биржа | сессия живая | `src/sources/alot.js` |
| Telegram (5 каналов) | чат | починить `.env` | `src/sources/telegram.js` |
| fl.ru | биржа | HTML + куки | `src/sources/flru.js` |
| kwork.ru | биржа | HTML + куки | `src/sources/kwork.js` |
| hh.ru / career.habr | вакансии | HTML + куки | `src/sources/hh.js` |
| remoteok.com | вакансии | JSON API | `src/sources/remoteok.js` |
| remotive.com | вакансии | JSON API | `src/sources/remotive.js` |
| arbeitnow.com | вакансии | JSON API | `src/sources/arbeitnow.js` |
| jobicy.com | вакансии | JSON API | `src/sources/jobicy.js` |
| himalayas.app | вакансии | JSON API | `src/sources/himalayas.js` |
| weworkremotely.com | вакансии | RSS | `src/sources/weworkremotely.js` |

---

## Стадия 1. Ядро (`src/core/`)

### 1.1 `core/http.js` — сетевой слой
- [ ] `request()` — обёртка над `fetch`: таймаут (AbortController), N ретраев с backoff
- [ ] per-host rate-limit (пауза между запросами к одному хосту)
- [ ] ротация User-Agent, заголовки Referer/Origin
- [ ] `getText`, `getJson`, `postJson` — sugar
- [ ] обработка 429/5xx с `Retry-After`

### 1.2 `core/html.js` — лёгкий парсер без зависимостей
- [ ] `stripTags`, `decodeEntities`, `collapse`
- [ ] `pickAll(html, regex)`, `between()`, `attr()`
- [ ] «мягкий» DOM: `htmlToBlocks` — выдёргивание повторяющихся карточек по классу

### 1.3 `core/rss.js`
- [ ] парсер RSS 2.0 + Atom (regex, без XML-библиотеки)
- [ ] нормализация в `Job`

### 1.4 `core/model.js` — единая модель заказа
```
Job = {
  id,               // "source:externalId"
  source, sourceLabel, externalId,
  title, body, url, urlDirect,
  price: { min, max, currency, text },
  publishedAt, deadline, category[], tags[],
  client: { name, id, rating, reviews, orders, ageDays, verified },
  stats: { responses, views },
  quality: { score, verdict, reasons[], flags[] },
  dedupe: { key, groupId, duplicates[] },
  raw
}
```
- [ ] `makeJob(source, partial)` — нормализация всех полей
- [ ] `salaryPerHour()` — оценка часовых по объёму текста
- [ ] `fingerprint()` — ключ для дедупа

### 1.5 `core/dedupe.js`
- [ ] нормализация заголовка (lowercase, без пунктуации, синонимы)
- [ ] `fuzzyTitle()` — Levenshtein-подобное сравнение + token overlap (Jaccard)
- [ ] объединение дублей в группы, выбор «лучшего» представителя

### 1.6 `core/quality.js` — **главная ценность**
Сигналы заказа:
- [ ] `responses` — конкуренция (порог настраивается, > N → penalize)
- [ ] цена: адекватность ставки, `priceMin/Max`, валюта
- [ ] срочность/дедлайн
- [ ] объём текста (признак «размытого» ТЗ)

Сигналы клиента:
- [ ] `rating` (порог, напр. ≥ 30)
- [ ] `reviews` (порог, напр. ≥ 3)
- [ ] `orders` — опыт
- [ ] `ageDays` — свежесть аккаунта
- [ ] `verified` — верификация

Антифрод/антиспам:
- [ ] blacklist-слова (пользовательские + встроенные)
- [ ] «срочно/дёшево/без опыта/тестовое/напишите в личку» — penalize
- [ ] CAPS-lock, эмодзи-спам, повтор символов, latin+cyrillic mix
- [ ] копипаст-детект (одинаковые тексты у разных заказов)
- [ ] «без отзывов/без истории» — penalize

Итог:
- [ ] `score` 0–100, `verdict`: `prime` (≥80) / `good` (60–79) / `meh` (40–59) / `bad` (<40) / `blocked`
- [ ] `reasons[]` — человекочитаемые объяснения
- [ ] `flags[]` — машинные теги

### 1.7 `core/settings.js`
- [ ] схема настроек с дефолтами и типами
- [ ] `validate(patch)` — приведение типов, отсев мусора
- [ ] группы: `search`, `quality`, `sources`, `accounts`, `notify`, `apply`, `profile`
- [ ] миграция старых настроек (`keywordsPlus` и т.д.)

### 1.8 `core/store.js` (v2)
- [ ] `jobs` (по `id`) + `projects` (legacy) + `groups` + `appliedLog` + `stats`
- [ ] миграция `schemaVersion: 1 → 2` (проекты → jobs)
- [ ] deep-merge настроек
- [ ] индексы: по source, по verdict, по дате
- [ ] `stats`: за день/неделю, по источникам, средняя цена

### 1.9 `core/accounts.js`
- [ ] `data/accounts.json`: `{ <name>: { type, ... } }`
- [ ] импорт cookie-файлов — **5 форматов**:
  1. Netscape `cookies.txt`
  2. Chrome/EditThisCookie/Cookie-Editor JSON
  3. Playwright `storageState.json`
  4. JSON `{cookies:[...]}` / `{name,value,domain}`
  5. сырая строка `name=value; name2=value2`
- [ ] авто-детект домена → привязка к сервису (fl.ru / kwork.ru / hh.ru)
- [ ] `cookieHeader(name, domain)`, `applyCookies(name)`
- [ ] `checkAll()` — проверка живости каждого аккаунта (см. 3.2)

### 1.10 `core/profile.js` — профиль исполнителя
- [ ] навыки, ставка, портфолио, опыт, шаблоны откликов
- [ ] используется в генераторе откликов вместо хардкода

---

## Стадия 2. Источники (`src/sources/`)

- [ ] Контракт источника: `{ id, label, kind, enabledByDefault, needsAuth, fetch(ctx) → Job[] }`
- [ ] `sources/index.js` — реестр, включение/выключение, per-source настройки
- [ ] Реализовать все 11 источников из таблицы стадии 0
- [ ] Каждый источник: `fetch` + `parse` + `normalize` (в отдельных функциях, тестируемых)
- [ ] Таймауты и изоляция: падение одного источника не роняет опрос
- [ ] Кэш «последний успешный опрос» в `data/source-state.json`

### Отдельно: Telegram
- [ ] **починить** `src/tg/tg_fetch.py` — путь `.env` → `D:/opencode/mcp-servers/telegram-mcp/.env`
- [ ] авто-поиск `.env` рядом с интерпретатором (без хардкода)
- [ ] поддержка нескольких `.session` (Telethon file)
- [ ] классификация постов: заказ / резюме / вакансия / спам

---

## Стадия 3. Аккаунты и «везде сразу»

### 3.1 Импорт
- [ ] UI: загрузить cookie-файл → авто-определение сервиса → предпросмотр → сохранить
- [ ] CLI: `hunter accounts import flru cookies.txt`
- [ ] поддержка Netscape / Chrome / Playwright / raw
- [ ] валидация: есть ли нужные для сервиса куки

### 3.2 Единый обзор аккаунтов
- [ ] `alot` → `checkSession` → имя, id, аватар
- [ ] `flru` → страница профиля → имя, рейтинг, кол-во отзывов
- [ ] `kwork` → профиль → имя, рейтинг, баланс, кворки
- [ ] `hh` → профиль → имя, откликов отправлено
- [ ] `telegram` → проверка сессии
- [ ] Единая таблица: сервис / статус / кто я / рейтинг / баланс / последняя проверка

---

## Стадия 4. Автоотклик (`src/apply/`)

- [ ] Playwright + persistent context на сервис (`data/profiles/<service>/`)
- [ ] `flru`: открыть заказ → отправить отклик
- [ ] `kwork`: открыть проект → отправить предложение
- [ ] `dry-run` по умолчанию, лимит в день, whitelist/blacklist заказов
- [ ] журнал попыток, скриншоты при ошибке
- [ ] подстановка текста из `profile` + шаблона по категории

---

## Стадия 5. Web UI (`web/`)

- [ ] **Дашборд**: сколько заказов за день, по источникам, средняя цена, топ-категории
- [ ] **Лента**: все источники сразу, фильтры (источник, вердикт, цена, текст), сортировка, поиск
- [ ] **Карточка**: полное описание, метрики клиента, причины вердикта, дубликаты, черновик отклика
- [ ] **Аккаунты**: импорт куки, статус, обзор «кто я на всех площадках»
- [ ] **Настройки**: все группы настроек
- [ ] **Канбан**: new → draft → sent → replied → done
- [ ] Переписать `web/index.html` в модульный вид (вынести CSS/JS), тёмная тема OWA

### API (`web/server.js`)
- [ ] `GET /api/health`, `/api/stats`, `/api/sources`
- [ ] `POST /api/poll` — **исправить 400** (сейчас `r.ok` не существует)
- [ ] `GET /api/jobs` — с фильтрами (источник/вердикт/цена/q/статус)
- [ ] `GET /api/jobs/:id` — **исправить regex** (поддержка строковых TG-id)
- [ ] `POST /api/jobs/:id/apply`, `/api/jobs/:id/status`
- [ ] `GET/POST /api/settings`
- [ ] `GET /api/accounts`, `POST /api/accounts/import`, `POST /api/accounts/check`
- [ ] `POST /api/apply/auto` — автоотклик
- [ ] `GET /api/profile`

---

## Стадия 6. MCP (`mcp/server.js`)

- [ ] `poll_all` — опрос всех источников
- [ ] `poll_source` { source }
- [ ] `list_jobs` { source, verdict, status, minPrice, q, limit }
- [ ] `get_job` { id }
- [ ] `draft_response` { id, customText }
- [ ] `mark_applied` { id, responseText } — **исправить** (строгие id → NaN)
- [ ] `set_settings` — расширенная схема
- [ ] `get_settings`
- [ ] `accounts_status` / `import_cookies` { service, path }
- [ ] `quality_report` { id } — разбор скоринга
- [ ] `stats`
- [ ] `whoami` — обзор по всем сервисам
- [ ] `generate_product_cards` — оставить

---

## Стадия 7. CLI (`bin/hunter.js`)

- [ ] `poll [--source s]`, `list`, `show`, `apply`, `settings`, `set`, `whoami`
- [ ] `sources` — список источников и их статус
- [ ] `accounts` / `accounts import` / `accounts check`
- [ ] `stats`
- [ ] `doctor` — диагностика окружения (python, playwright, .env, сессии)

---

## Стадия 8. Качество и тесты

- [ ] `test/` — unit-тесты `node --test`:
  - [ ] `quality` (скоринг, антифрод)
  - [ ] `dedupe`
  - [ ] `settings` (валидация)
  - [ ] `accounts` (5 форматов cookie-файлов)
  - [ ] `model` (нормализация)
  - [ ] `rss`/`html` (парсеры)
  - [ ] `store` (миграция v1→v2)
- [ ] `npm test` зелёный
- [ ] README переписан под v2
- [ ] `.bat`-лаунчер — поправить путь `D:\freelance` → `D:\opencode\hunter`

---

## Порядок работ (зависимости)

```
1. core/http, html, rss, model, dedupe
2. core/settings, core/store(v2)
3. core/quality
4. sources (11 шт)
5. core/pipeline
6. core/accounts, core/profile
7. web/server.js + web UI
8. mcp/server.js
9. bin/hunter.js
10. apply/*
11. тесты, README, .bat
```

## Критерии готовности

- [ ] `npm test` — зелёные
- [ ] `node bin/hunter.js poll` — опрос ≥ 9 источников, ≥ 100 заказов в базе
- [ ] `node bin/hunter.js accounts` — видно статус всех сервисов
- [ ] UI открывается, лента показывает заказы из разных источников с вердиктами качества
- [ ] MCP-сервер отдаёт все новые инструменты
- [ ] Telegram-поллинг реально приносит посты
- [ ] Ни одного бага из списка стадии 0
