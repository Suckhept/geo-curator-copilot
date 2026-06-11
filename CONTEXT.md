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
6. Вшить excludedTypeIds (тип Proposal 490a7c90…) в core-движок, чтобы
   governance-сущности не попадали в кластеры ещё на скане — см. правило
   ниже; пока закрыто фильтром CLI `fix --exclude`.

## ДЕПЛОЙ: https://geocheck.space (2026-06-11)

- `packages/web` — публичная демо-витрина (шаг 3 стратегии «Упаковка»):
  лендинг EN с цифрами пилота, live-статус proposal (прокси
  `/api/proposal/{id}`), живой скан спейса `/api/scan/{spaceId}`
  (cap 3000 сущностей, кэш 10 мин, ~1.5 мин на полный datasets-скан).
- Хостинг: этот VPS (31.77.199.12). Node-сервер на 127.0.0.1:8080 (и
  публично 31.77.199.12:8080 как превью), держится кроном
  `/root/run-geocheck.sh` (@reboot + контроль каждые 5 мин,
  лог /var/log/geocheck.log). nginx проксирует 443→8080
  (/etc/nginx/sites-available/geocheck), TLS Let's Encrypt для
  geocheck.space + www (авто-продление certbot.timer/cron).
- В лендинге вшит PROPOSAL_ID действующего пилота — при следующих пилотах
  обновлять константу в packages/web/static/index.html.

## ПРАВИЛО ДЕДУПА: сущности governance-предложений не трогать

Тип Proposal `490a7c90ad4b4029b2b4d85d22fe203a` ВСЕГДА исключён из дедупа:
одинаковый заголовок предложений ≠ дубль. Известные сущности перечислены в
`/root/exclude-ids.json` (2 в Crypto datasets + 3 в Crypto), CLI:
`fix --exclude /root/exclude-ids.json`. При упаковке (шаг 3 стратегии)
вшить `excludedTypeIds` с этим типом прямо в core-движок, чтобы такие
сущности вообще не попадали в кластеры (добавлено в хвосты).

## СТАТУС ПИЛОТА №1 (2026-06-11): v2 ОПУБЛИКОВАН, ждёт голоса editors

- ДЕЙСТВУЮЩИЙ proposal `c8acd570ca364c7d81e2c1aede02d154` («Dedup pilot v2:
  merge 56 duplicate entities»): tx
  `0x19f7c8e83da998ae057413b86b0e4451a5d1bf136b66cf6cb053d17450243df2`,
  блок 147087, SUCCESS. cid
  `ipfs://bafkreic2gx4l3komynnwxa4grj632joeo2rarm5c22lneulfj2qp7ojo6m`,
  editId `daca18c7db794745a47b7b4435d47519`. 59 ops (57 deleteEntity +
  1 deleteRelation + 1 createRelation), --exclude применён, round-trip
  decode 0.4.1 ок, индексер показывает имя. Кворум 1 голос editor,
  окно 24 ч (~до 2026-06-12 11:45 UTC).
  Мониторинг: /root/watch-proposal.sh (cron, лог /root/proposal-status.log).
- МЁРТВЫЕ proposals, не голосовать, истекут сами 2026-06-12 утром:
  `7e66ee0bdd214c709bf508492ee49319` (битая кодировка 0.33) и
  `7d117259183042198e036e6ad6fe974c` (удалял 2 governance-сущности).
- Пилот №2 (Crypto, tier all) — только после принятия v2 и явного «да»;
  обязательно с `--exclude` (3 известных governance-id в Crypto).

## Находки сессии 2026-06-11 (раскопки публикации, всё проверено live)

**Identity пользователя на TESTNET_V2-стеке** (чейн 19411, testnet-RPC):
- Реальный Geo-аккаунт = Safe-прокси `0xe232AC6533201e12304bCfe694d4EDC56b8c9285`
  (поле Accounts профиля). VERSION 1.4.1, threshold 1,
  owner = EOA из GEO_PRIVATE_KEY (`0x0157d12f96363A388091252C9b73cF7bAfA27704`).
- masterCopy НЕканонический: `0x639245e8476e03e789a244f279b5843b9633b2e7`
  (кастомный деплой Safe 1.4.1 на Geo-чейне) → counterfactual-вычисление
  SDK даёт ДРУГОЙ адрес (`0xD073…04DF`) — не использовать.
- Включён 4337-модуль `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226` (он же
  fallback handler). ЛОВУШКА: адрес совпадает с каноническим Safe4337Module
  v0.2.0 (EP 0.6), но это кастомная сборка под EntryPoint **0.7**
  (`SUPPORTED_ENTRYPOINT()` = `0x0000000071727De2…a032`) — конфигурить
  permissionless строго под EP 0.7, с 0.6 validateUserOp ревертит.
- Личный спейс Safe: `dc306031c372ade013965c9ae22ad474`
  (SpaceRegistry.addressToSpaceId). В Crypto datasets `5908…17e4` он
  **member, НЕ editor** (editors 18 шт.) → edit пойдёт как proposal
  через governance, не применится мгновенно.

**Инфраструктура публикации TESTNET_V2:**
- Роута `/space/{id}/edit/calldata` на testnet-api НЕТ (404; подтверждено
  по `/openapi`) — Encoding.getEditCalldata из SDK 0.33 мёртв для этого стека.
  Есть только `/ipfs/upload-edit` (+ proposals/profile/search/versioned).
- Calldata собирается клиентски как GOVERNANCE-PROPOSAL (не EDITS_PUBLISHED —
  тот принимается только от самого спейса, для чужого даёт InvalidAction()
  0x4a7f394f). Формат (раскопан из собственных tx пользователя, проверен
  eth_call-симуляцией; реализован в publish.ts):
  `SpaceRegistry.enter(fromSpaceId=личный спейс, toSpaceId=цель,
  action=0xcf4356ed126c00d2e547ace2f69991a972d322b45371d61ce5478b1cb9acb4c2,
  topic=proposalId(bytes16, влево в bytes32), payload, sig=0x)` на
  `0xB01683b2f0d38d43fcD4D9aAB980166988924132` (есть ТОЛЬКО на 19411).
  payload = abi(bytes16 proposalId, uint256 proposalType, (address,uint256,
  bytes)[] actions), один action = вызов DaoSpace.publish(0x0,
  abi(string cid), 0x) (селектор 0x6b47f61a) на адрес контракта спейса
  (spaceIdToAddress). proposalType: 0 = member-proposal (на голосование
  editors) — наш случай; 1 = editor (авто-исполняется), для member ревертит
  0x196f9913. Голос editors: action 0x4ebf5f29…, payload (proposalId, 1).
- Чейны: genesis 80451 (Safe-фабрика 1.4.1 есть, SpaceRegistry НЕТ),
  testnet 19411 (SpaceRegistry есть, канонической Safe-фабрики НЕТ).
- Бандлер Pimlico для 19411 РАБОТАЕТ: `https://api.pimlico.io/v2/19411/rpc`
  с дефолтным ключом SDK (`pim_KqHm63txxhbCYjdDaWaHqH`, gas-limited);
  eth_supportedEntryPoints = [0.6, 0.7, …], gas-price отвечает.
- `getSmartAccountWalletClient` SDK 0.33 принимает ТОЛЬКО {privateKey, rpcUrl},
  жёстко: chain 80451 + бандлер v2/80451 + counterfactual Safe → для testnet
  непригоден. Нижележащий `toSafeSmartAccount` (permissionless) принимает
  `address` готового Safe — путь: toSafeSmartAccount({address: 0xe232…,
  entryPoint 0.7}) + бандлер v2/19411 (опция --safe-address / GEO_SAFE_ADDRESS;
  реализовано в publish.ts: publishEditViaSafe, dry-run делает eth_call-
  симуляцию enter() от имени Safe). Спонсорство Pimlico на 19411 подтверждено
  (pm_sponsorUserOperation подписал userOp при prepareUserOperation).
- Балансы на 19411: EOA и Safe по 0 ETH → без спонсорства бандлера
  не публикуем (с голого EOA не публиковать — права у Safe).

## Грабля: кодировка edit (вскрыта после публикации пилота, 2026-06-11)

- Проявление: geobrowser на странице proposal показывает «Encoding error —
  The edit data failed validation and cannot be decoded»; tx и proposal ок.
- Причина: `Ipfs.publishEdit` из @graphprotocol/grc-20@0.33 кодирует GRC2
  со СТАРЫМ wire-форматом ops (поколение @geoprotocol/grc-20 0.1.x). Фронт
  TESTNET_V2 декодит кодеком 0.4.x: на нашем файле он падает
  (`[E005] unexpected end of input`), эталонные edits geobrowser читает
  (73 ops). Оба формата носят magic `GRC2` — отличить можно только декодом.
- Фикс (publish.ts): @geoprotocol/grc-20 поднят до ^0.4.1; ops собираются
  только его билдерами (deleteEntity/deleteRelation/createRelation);
  edit = createEdit({id, name, author=Id ЛИЧНОГО СПЕЙСА (не адрес!),
  createdAt в МИКРОсекундах, ops}) -> encodeEdit -> decodeEdit (само-проверка)
  -> POST FormData('file') на {origin}/ipfs/upload-edit -> ipfs://CID.
  parseId 0.4.1 лоялен к не-RFC прод-ID (lenientId-хак больше не нужен).
- Первый proposal 7e66ee0b… с битым контентом: не трогаем, истечёт сам
  (24 ч). Перепубликация — новым кодеком после подтверждения пользователя.

## Гардрейлы

См. RUNBOOK.md. Ключевые: GEO_PRIVATE_KEY только из env и никогда не
печатается; всегда dry-run; боевой запуск — после явного «да»; пилот №2 —
после подтверждения, что №1 прошёл; скоринг и состав пилота не менять без
просьбы пользователя.
