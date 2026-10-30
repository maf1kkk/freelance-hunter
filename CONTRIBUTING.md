# Как contribute

## Быстрый старт

```bash
npm install
npm test          # юнит-тесты
npm run test:all  # полный прогон (юнит + e2e + критерии)
npm start         # веб-интерфейс на http://localhost:3410
```

## Что можно улучшать

- **Новые источники** — добавьте модуль в `src/sources/` с контрактом
  `{ id, label, kind, needsAuth, enabled, fetch(ctx), check(ctx) }` и зарегистрируйте его
  в `src/sources/index.js`. Парсеры покрыты тестами в `test/sources.test.js`.
- **Новые провайдеры ИИ** — поддерживаются любые OpenAI-совместимые, Anthropic и Ollama.
  Нужна только реализация в `src/core/ai.js` (уже есть) и запись в `data/ai-providers.json`.
- **Критерии качества** — `src/core/quality.js`, веса в начале файла, покрыт тестами.
- **Фильтры/настройки** — схема в `src/core/settings.js`, автоматически подхватывается UI и CLI.

## Правила

1. Любое изменение — с тестом. `npm test` должен оставаться зелёным.
2. Не коммитьте `data/`, `output/` и ключи — см. [SECURITY.md](SECURITY.md).
3. Не ломайте публичный интерфейс MCP: список инструментов используют внешние агенты.
4. Комментарии и логи — по-русски (проект русскоязычный).

## Полезные команды

```bash
node bin/hunter.js doctor      # диагностика окружения
node bin/hunter.js poll       # разовый опрос всех источников
node test/verify.js            # проверка критериев готовности
node scripts/final-check.js   # визуальная проверка UI
```
