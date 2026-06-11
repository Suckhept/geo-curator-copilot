# CONTEXT — полный handoff (читать первым, вместе с RUNBOOK.md)

Ты продолжаешь работу, начатую в чате claude.ai. Здесь — всё, что было добыто
и решено. Пользователь: Saurois, общение по-русски, кратко, без воды. Дал
полный карт-бланш («ты главарь операции») — действуй автономно, спрашивай
только на необратимых шагах (публикации) и развилках стратегии.

## Миссия

Geo Curator Copilot — QA-инфраструктура для кураторов Geo (geobrowser.io,
GRC-20). Цель пользователя: полезный сервис, который команда Geo оценит и
применит. Стратегия зафиксирована, порядок менять нельзя без его решения:

1. **Пилот №1**: опубликовать merge бесспорных дублей в Crypto datasets
   (tier b, 58 кластеров / 61 op) — см. RUNBOOK.md. ← ТЕКУЩИЙ ШАГ
2. **Пилот №2**: Crypto (tier all, 116 ops) — только после успеха №1.
3. **Упаковка**: публичный GitHub-репо, README EN, GIF-демо, отчёты как кейс.
4. **Питч Geo**: пост в комьюнити + контакт с командой; формула — receipts
   first: «нашёл и починил 618 дублей в ваших флагманских спейсах, вот
   инструмент». Предложить Governance QA-бота как следующий этап под
   грант/bounty.
5. **Governance-бот** — строить ТОЛЬКО после сигнала интереса команды
   (без бай-ина бот, комментирующий чужие правки, читается как спам).

## Что построено (этот репозиторий)

pnpm-монорепа, TS strict, 34 теста зелёные (`./node_modules/.bin/vitest run`):
- `packages/core` — dedup-движок (zero-deps): сигналы, скоринг, кластеризация,
  fix-план. Документация скоринга — в README.md.
- `packages/client` — GraphQL (два диалекта, см. ниже), снапшоты (cursor),
  CSV-драфты, publish через @graphprotocol/grc-20@0.33.
- `packages/cli` — `geo-copilot`: snapshot | scan | lint | fix
  (fix умеет `--plan pilot-edit.json --tier a|b|all`).
- `packages/mcp-server` — 5 tools; publish_edit требует env GEO_PRIVATE_KEY и
  confirm:true.
- `queries/confirm-schema.md` — вся история раскопок схемы.

## Добытые константы (всё проверено на живых данных 2026-06-11)

**Origins / диалекты** (клиент автодетектит по validation-ошибкам):
- `https://testnet-api.geobrowser.io` — РЕАЛЬНЫЕ данные, его использует сам
  geobrowser.io. Диалект `postgraphile`: entities(spaceId, first, offset,
  typeIds), Entity { typeIds, valuesList{propertyId text},
  relationsList{id typeId toEntityId}, backlinksList }, пагинация offset ≤ 1000
  → для больших спейсов ТОЛЬКО `entitiesConnection` (cursor, реализовано).
- `https://hypergraph-v2.up.railway.app` — ДЕМО-деплой (фейковые адреса), не
  использовать для данных. Диалект `hypergraph`: limit/offset, values{value},
  relations{toId}, types{id}, search(query, threshold).

**Спейсы**: Crypto `c9f267dcb0d270718c2a3c45a64afd32`,
Crypto datasets `5908c73ad336472ccbd983491d2d17e4` (ID работают и dashed, и
dashless — Postgres uuid ест оба).

**Property/type ID** (вшиты в core/src/system-ids.ts → ObservedCryptoIds):
- Report URL = `0998ac0f753247ea872d3e7cadd98e62` (identity-тир дедупа)
- Тип Audit = `beaca72fca1b4c5699e04bea0369eefd`
- LinkedIn = `cdf139bce610446cac42d57cd7967478` (profile-тир)
- системные: Website eed38e74…, X 0d625978…, Web URL 412ff593…, Name a126ca53…

**Публикация**: ops → Ipfs.publishEdit → POST {origin}/space/{id}/edit/calldata
→ tx через smart-account (газ спонсируется). network=TESTNET_V2 соответствует
testnet-api.geobrowser.io. RPC: mainnet
`https://rpc-geo-genesis-h0q2s21xx8.t.conduit.xyz`, testnet
`https://rpc-geo-test-zc16z3tcvf.t.conduit.xyz` — наш publish сам мапит по
network (SDK по умолчанию всегда бьёт в mainnet-RPC — это исправлено).

**Грабли, уже закрытые в коде** (не наступать заново):
- Прод-ID бывают НЕ RFC-4122 v4 (variant-нибл «7») → строгая Id() SDK их
  режет; в publish.ts есть lenient-fallback через @geoprotocol/grc-20 parseId.
- offset > 1000 запрещён API → cursor-пагинация.
- Report URL иногда заполнен ссылкой на ПАПКУ audits → hub-guard по df URL.
- url.exact по Website/X склеивал разнотипное → двухтировая система
  identity/profile + гейт по типам.
- Разные аудиторы при общем URL → relation.conflict, cap 0.55 (с identity-URL
  → ровно 0.85, ревью).
- Транзитивная кластеризация по likely слепила 25 Lido-аудитов → кластеры
  только по duplicate-рёбрам (≥0.9), likely → reviewPairs.

## Результаты сканов (полный дамп: geo-dump.json у пользователя, 15 МБ)

- Crypto datasets (1826 сущностей, полный): 184 кластера, 284 авто-дубля,
  25 review-пар.
- Crypto (15 000 — ОБРЕЗАН лимитом сниппета, в спейсе больше): 122 кластера,
  334 авто-дубля, 261 review-пара.
- Пилоты (файл pilot-edit.json, лежит рядом с репо): datasets tier B 58 кл/61
  op; crypto tier A 2 кл/8 op + tier B 16 кл/108 op.
- Отчёты сканов у пользователя: crypto-dedup-report.{md,json},
  crypto-datasets-dedup-report.{md,json}.

## Открытые хвосты (после пилотов, по приоритету)

1. Добрать хвост Crypto (>15k): снапшот по `--type beaca72f…` (аудиты) и
   company-типам через CLI snapshot (cursor уже умеет), пере-скан.
2. 261+25 review-пар — прогнать с пользователем глазами, спорное оформить
   отдельными правками.
3. GitHub-репо: вычистить, README EN, лицензия MIT, CI (vitest), GIF-демо
   (пользователь сам умеет GIF/видео — попроси у него).
4. Питч: черновик поста (EN) с цифрами 618 дублей; найти актуальные каналы
   Geo (Discord/форум The Graph/Geo) свежим поиском — не полагайся на память.
5. MCP live-режим и поиск по имени на postgraphile (фильтр
   name.includesInsensitive — TENTATIVE, не проверен).

## Гардрейлы

См. RUNBOOK.md. Ключевые: GEO_PRIVATE_KEY только из env и никогда не
печатается; всегда dry-run; боевой запуск — после явного «да»; пилот №2 —
после подтверждения, что №1 прошёл; скоринг и состав пилота не менять без
просьбы пользователя.
