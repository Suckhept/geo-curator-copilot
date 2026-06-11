# Geo Curator Copilot

Dedup-движок, CLI и MCP-сервер для кураторов [Geo](https://www.geobrowser.io)
(GRC-20 / The Graph). Ловит дубли **до** публикации (lint CSV-батча) и **после**
(скан существующего спейса), предлагает merge-план и умеет публиковать его одним
edit'ом через `@graphprotocol/grc-20`.

Построен на реальных кейсах bounty «Add all smart contract audits»:

| Кейс | Сигнал | Вердикт |
|---|---|---|
| `Aave - Sigma Prime - V3 core audit` ×2, один Report URL | `url.exact` | duplicate 1.0 (авто) |
| `MixBytes` / `Mixbytes`, `Pashov Audit Group` / `Pashov audit group` | `name.exact` (casefold) | duplicate 0.9 |
| `Aave - Certora - Core v3.1 Audit` vs `Aave v3.1 audit by Certora` | `name.fuzzy` + `shape.relations` (+`url.exact`, если URL совпал) | likely 0.85 / duplicate 1.0 |
| `...v3.0...` vs `...v3.1...` | `version.veto` | cap 0.35 — **не** сливается |

## Структура

```
packages/core        движок (zero-deps): сигналы, скоринг, кластеризация, fix-план
packages/client      GraphQL-транспорт, снапшоты, CSV-драфты, publish (grc-20)
packages/cli         geo-copilot: snapshot | scan | lint | fix
packages/mcp-server  geo-copilot-mcp: 5 tools для AI-куратора
examples/            мини-снапшот Crypto-спейса, CSV-батч, маппинг колонок
queries/             3 GraphQL-запроса для подтверждения схемы (2 TENTATIVE-места)
```

## Быстрый старт

```bash
pnpm install && pnpm build && pnpm test   # 26 тестов

# скан примера: 4 кластера, replaceRelation+deleteEntity для Mixbytes-дубля
node packages/cli/dist/main.js scan \
  --space sample-crypto \
  --snapshot examples/snapshot.sample.json \
  --unique-url-prop aaaa0000000040008000000000000001

# pre-publish lint CSV-батча
node packages/cli/dist/main.js lint \
  --space sample-crypto \
  --snapshot examples/snapshot.sample.json \
  --draft examples/batch.audits.csv \
  --map examples/mapping.audits.json \
  --unique-url-prop aaaa0000000040008000000000000001
```

Exit-коды: `0` чисто, `2` найдены дубли (удобно для CI), `1` ошибка.

## Реальный спейс

```bash
# 1) снапшот (live; или вставь ответ GraphQL из браузера — loadSnapshot поймёт)
node packages/cli/dist/main.js snapshot \
  --space c9f267dcb0d270718c2a3c45a64afd32 \
  --out crypto.snapshot.json

# 2) скан с настоящим propertyId "Report URL" (достань его запросом Q2 из queries/)
node packages/cli/dist/main.js scan \
  --space c9f267dcb0d270718c2a3c45a64afd32 \
  --snapshot crypto.snapshot.json \
  --unique-url-prop <reportUrlPropertyId>

# 3) merge-план -> GRC-20 ops; публикация — отдельным осознанным шагом
node packages/cli/dist/main.js fix --report geo-copilot-out/report.json
GEO_PRIVATE_KEY=0x... node packages/cli/dist/main.js fix \
  --report geo-copilot-out/report.json \
  --publish --space c9f267dcb0d270718c2a3c45a64afd32 --dry-run
```

`GEO_PRIVATE_KEY` — из geobrowser.io/export-wallet. Только env, никогда в файлы/чат.

## MCP-сервер

```jsonc
// конфиг клиента (Claude Desktop / Cursor / ...)
{
  "mcpServers": {
    "geo-copilot": {
      "command": "node",
      "args": ["<repo>/packages/mcp-server/dist/main.js"],
      "env": {
        "GEO_SPACE": "c9f267dcb0d270718c2a3c45a64afd32",
        "GEO_UNIQUE_URL_PROPS": "<reportUrlPropertyId>",
        // оффлайн-режим (полная проверка спейса без сети):
        "GEO_SNAPSHOT": "<repo>/crypto.snapshot.json"
        // live-режим: убери GEO_SNAPSHOT; опционально GEO_API_ORIGIN
        // для публикации: GEO_PRIVATE_KEY
      }
    }
  }
}
```

Tools: `search_entities`, `check_duplicates`, `resolve_canonical_id`,
`generate_ops`, `publish_edit` (единственный мутирующий: требует
`GEO_PRIVATE_KEY` **и** `confirm:true`; есть `dryRun`).

## Скоринг (пороги: duplicate ≥0.9, likely ≥0.6, weak ≥0.4)

- `url.exact` — общий канонический URL на уникальном property (Report URL):
  **1.0, перебивает всё**, включая version-veto. Канонизация: без схемы/www/
  трекинг-параметров/фрагмента/хвостового слэша, query отсортирован, регистр
  пути сохранён (GitHub).
- `name.exact` (casefold + пунктуация) — +0.9.
- `name.fuzzy` = 0.6·max(tokenSort, tokenSet) + 0.4·jaccard; стоп-слова
  audit/report/by/of/…; вклад 0.7 / 0.5 / 0.2 по порогам 0.95 / 0.85 / 0.7.
- `shape.relations` — +0.35·jaccard по парам (typeId→toEntityId), TYPES
  исключён; типы совместимы, если пересекаются или у одной стороны пусто.
- `version.veto` — дизъюнктные версии (v3.0 vs v3.1) режут счёт до 0.35.

Canonical в кластере: существующий > драфт, затем богатство
(2·relations+values), затем lexicographic id. `replaceRelation` = delete+create:
в GRC-20 v2 `UpdateRelation` не умеет перенаправлять `toEntity` (проверено по
`@geoprotocol/grc-20` types).

## Известные допущения

- `relationsList` в GraphQL и `entities` без `typeIds` — TENTATIVE, см.
  `queries/confirm-schema.md` (есть graceful-fallback и оффлайн-режим).
- Эндпоинты mainnet: GraphQL `https://hypergraph-v2.up.railway.app/graphql`,
  публикация `…/ipfs/upload-edit` → `…/space/{id}/edit/calldata` → tx через
  smart-account (газ спонсируется) — по коду grc-20-ts 0.33.

## Гарды точности (по итогам прогона на живых Crypto-спейсах)

- **Hub-guard**: URL, общий для >3 сущностей (папка audits, сайт протокола в свободном поле) — не identity; >10 — игнор.
- **relation.conflict**: один relation-тип, непересекающиеся цели (аудитор Certora vs ABDK) → cap 0.55; вместе с общим Report URL → ровно 0.85 (ревью, не авто-merge).
- **Кластеры только по duplicate-рёбрам (≥0.9)**: транзитивные мега-кластеры через likely-связи запрещены; likely-пары идут в секцию `reviewPairs`.
