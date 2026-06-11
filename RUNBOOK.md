# RUNBOOK — пилотная дедуп-публикация в Geo (для Claude Code)

Ты выполняешь пилотную публикацию merge-правок в спейсы Geo (geobrowser.io)
от имени пользователя. Работай автономно, но соблюдай гардрейлы ниже.

## Контекст

Этот репозиторий — Geo Curator Copilot: dedup-движок + CLI (`geo-copilot`) +
MCP-сервер. Сканы уже выполнены, бесспорные дубли отобраны в файл
`pilot-edit.json` (лежит рядом с тарболлом, у пользователя). Спейсы:

- **Crypto datasets** `5908c73ad336472ccbd983491d2d17e4` — пилот №1 (tier b, 61 op)
- **Crypto** `c9f267dcb0d270718c2a3c45a64afd32` — пилот №2 (tier all, 116 ops), ТОЛЬКО после успеха №1

API-данные живут на `https://testnet-api.geobrowser.io` (network `TESTNET_V2`).

## ГАРДРЕЙЛЫ (нарушать нельзя)

1. **Ключ**: `GEO_PRIVATE_KEY` берётся ТОЛЬКО из переменной окружения. Никогда
   не печатай его, не пиши в файлы, не проси пользователя вставить его в чат —
   если env не задан, попроси пользователя выполнить
   `export GEO_PRIVATE_KEY=0x...` в этом же терминале и продолжай.
2. **Сначала dry-run, всегда.** Покажи пользователю `cid`, `editId`, `to`.
3. **Боевая публикация — только после явного «да» пользователя** на вопрос
   «Публикуем?». Одно подтверждение = один edit.
4. Спейс №2 (Crypto) — только после того, как пользователь подтвердит, что
   пилот №1 прошёл (применился / принят в governance).
5. Не меняй скоринг/пороги движка и состав `pilot-edit.json` без явной просьбы.
6. Любая ошибка — покажи её целиком и предложи следующий шаг; при проблемах с
   RPC попробуй `--rpc-url https://rpc-geo-test-zc16z3tcvf.t.conduit.xyz`.

## Шаг 0 — самопроверка (ОБЯЗАТЕЛЬНО, до любых действий)

1. В корне репо ДОЛЖНЫ существовать `CONTEXT.md` и `RUNBOOK.md`, а в
   `packages/client/src/graphql.ts` — слово `postgraphile`. Если чего-то нет —
   у тебя УСТАРЕВШАЯ копия репозитория: остановись и сообщи пользователю,
   ничего не переписывай и не «переоткрывай» схему.
2. Данные живут ТОЛЬКО на `https://testnet-api.geobrowser.io`.
   `hypergraph-v2.up.railway.app` — демо с фейковыми данными; не адаптируй код
   под него. Если testnet-api временно отвечает 503 — подожди и повтори, не
   переключайся на демо.
3. Если нет node/pnpm:
   `curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs && corepack enable`

## Шаги

```bash
# 1. Сборка и тесты (из корня репо)
corepack enable && pnpm install && pnpm build
./node_modules/.bin/vitest run     # ожидается 34 passed

# 2. Проверка плана без сети
node packages/cli/dist/main.js fix \
  --plan ../pilot-edit.json --tier b \
  --space 5908c73ad336472ccbd983491d2d17e4 \
  --out /tmp/pilot-ops.json
# ожидается: "61 GRC-20 ops (0 advisory skips)"

# 3. DRY-RUN (нужен GEO_PRIVATE_KEY в env; транзакция НЕ отправляется)
node packages/cli/dist/main.js fix \
  --plan ../pilot-edit.json --tier b \
  --space 5908c73ad336472ccbd983491d2d17e4 \
  --publish --dry-run --network TESTNET_V2 \
  --edit-name "Dedup pilot: merge 58 duplicate entities"

# 4. Покажи пользователю cid/editId/to и СПРОСИ: «Публикуем?»

# 5. После «да» — та же команда БЕЗ --dry-run. Покажи txHash.

# 6. Верификация: дождись ~1-2 мин индексации и проверь, что дубль слился:
node - <<'EOF'
const q = `{ entity(id: "ID_ОДНОЙ_ИЗ_DELETE_СУЩНОСТЕЙ_ИЗ_PILOT_LIST", spaceId: "5908c73ad336472ccbd983491d2d17e4") { id name } }`;
fetch('https://testnet-api.geobrowser.io/graphql', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:q})})
  .then(r=>r.json()).then(d=>console.log(JSON.stringify(d)));
EOF
# Если спейс DAO-управляемый, edit мог уйти в голосование — тогда сущность
# ещё на месте; сообщи пользователю проверить вкладку governance спейса.

# 7. Доложи итог. Crypto (пилот №2) — только по подтверждению пользователя:
#    те же команды с --space c9f267dcb0d270718c2a3c45a64afd32 --tier all
#    и --edit-name "Dedup pilot 2: merge duplicate entities in Crypto".
```

## Если что-то пошло не так

- `pnpm install` ругается на ignored builds esbuild — уже разрешено в
  `pnpm-workspace.yaml`; при необходимости `pnpm config set verify-deps-before-run false --location project`.
- Валидация ID упала — это известный кейс (прод-ID не RFC v4), lenient-fallback
  уже встроен; если всё равно падает — покажи ошибку пользователю.
- 4xx от `/ipfs/upload-edit` или `/edit/calldata` — покажи тело ответа; не
  ретрай больше двух раз.
