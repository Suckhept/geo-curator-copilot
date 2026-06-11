# Статус схемы: ПОДТВЕРЖДЕНА (интроспекция 2026-06-11)

Снято с живого API `https://hypergraph-v2.up.railway.app/graphql`:

```
Query    { entities(filter, limit, offset, spaceId)
           entity(id, spaceId)
           search(query, spaceId, filter, limit, offset, threshold)
           relations(spaceId, filter, limit, offset)
           properties(filter, limit, offset)   property(id)
           types(spaceId, limit, offset)       spaces(filter, limit, offset)
           space(id)  account(address)  relation(id)  meta }

Entity   { id name description blocks createdAt createdAtBlock updatedAt
           updatedAtBlock values(spaceId, filter): [Value]
           relations(spaceId, filter): [Relation]
           backlinks(spaceId, filter): [Relation]   # инбаунды нативно!
           types: [Entity]  spaces: [String] }

Value    { id propertyId entityId spaceId value language format unit timezone
           entity: Entity  property: Property }     # данные в одном поле `value`

Relation { id entityId spaceId typeId fromId toId toSpaceId position verified
           type: Property  from: Entity  to: Entity  relationEntity: Entity }
```

Код синхронизирован: билдеры в `packages/client/src/graphql.ts`
(qSpaceEntities / qSearch / qEntityById / qBacklinks), нормализатор принимает
и live-форму (`value`, `toId`, `types`), и легаси-снапшоты
(`text`, `toEntityId`, `valuesList`/`relationsList`).

## Осталось неизвестным (не блокирует)

1. **Формы input-типов `filter`** у entities/search/relations — пока не
   используем (фильтрация по типам делается на клиенте).
2. **Почему `search` вернул пусто** по запросу "Aave Certora audit" в спейсе
   `c9f267dcb0d270718c2a3c45a64afd32`: вероятно, семантический `threshold`
   по умолчанию слишком высок, либо индекс не покрывает спейс. Не блокер —
   снапшот собирается прямым `entities`-дампом.
3. **Максимальный `limit`** на страницу (используем 100).
4. **propertyId поля "Report URL"** — достаётся одним дампом (см. сниппет
   в переписке): среди values аудита берём ту пару, где `value` — URL отчёта.

## Открытие (2026-06-11, вечер): реальный origin

- `hypergraph-v2.up.railway.app` — **демо-деплой**: 4 спейса с плейсхолдер-адресами
  (`0x1234…`, `0xFedCba…`), реальных данных нет.
- Продакшн geobrowser.io ходит в **`https://testnet-api.geobrowser.io/graphql`**
  (= TESTNET_V2 в константах grc-20-ts). Дефолтный origin в CLI/MCP переключён.
- ID спейсов на этом API — **dashed UUID** (`8ef40bdd-cf69-…`); у спейса есть
  и `id` (спейса), и `entity { id name }` (его сущность). assertGeoId принимает
  обе формы.

## Финальная картина: ДВА диалекта

| | `testnet-api.geobrowser.io` (РЕАЛЬНЫЕ данные) | `hypergraph-v2.up.railway.app` (демо) |
|---|---|---|
| пагинация | `first` / `offset` | `limit` / `offset` |
| values | `valuesList { propertyId text … }` | `values { propertyId value }` |
| relations | `relationsList { id typeId toEntityId }` | `relations { id typeId toId }` |
| типы | скаляр `typeIds` + `entities(typeIds: [...])` серверно | `types { id }` |
| поиск | filter `name.includesInsensitive` (TENTATIVE) | root `search(query, threshold)` |

Клиент: `Dialect = 'postgraphile' | 'hypergraph'`, дефолт postgraphile,
автодетект по тексту validation-ошибок («Did you mean "limit"/"first"»),
нормализатор принимает обе формы. 29 тестов.
