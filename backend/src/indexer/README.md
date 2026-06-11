# Event Indexer

Watches Chain A for two on-chain events and mirrors their effects into the
database so the rest of the backend (orders/fills/admin/simulate routes) can
read order state from Postgres instead of the chain.

## What it watches

| Event                  | Emitted by             | Effect in DB |
|-------------------------|-------------------------|--------------|
| `PartialFillExecuted`   | `PartialFillReactor`    | Insert a row into `fills`, then recompute the order's `status` (`active` or `filled`) by summing all fills against `orders.input_amount`. |
| `FallbackExecuted`      | `FallbackExecutor`      | Mark the order `status = 'filled'`. |

## Checkpointed polling (not `contract.on()`)

The indexer does **not** use `contract.on(eventName, listener)`. That API
subscribes via block-polling, and on its very first poll it checks the
*current* chain head — so on every backend restart it can re-emit whatever
event happens to sit in the latest block (e.g. a fill from your last test
session), causing `Fill detected → order updated to active` to print again
even though nothing new happened.

Instead:

1. On startup, `ensureIndexerStateTable()` creates `indexer_state`
   (`name TEXT PRIMARY KEY, last_block BIGINT`) if it doesn't exist.
2. `getCheckpoint(name, currentBlock)` reads the last processed block for
   `'reactor_partial_fill'` and `'fallback_executed'`. If a watcher has never
   run before, its checkpoint is **seeded to the current block** — i.e. it
   starts watching from "now", not from chain genesis.
3. `provider.on('block', ...)` fires for every new block. For each watcher,
   if `blockNumber > lastBlock`, it calls
   `contract.queryFilter(filter, lastBlock + 1, blockNumber)` — an explicit,
   bounded range that can never overlap or skip blocks — processes any logs
   found, then calls `setCheckpoint(name, blockNumber)`.

This makes the indexer idempotent and resumable: restart the backend at any
time and it picks up exactly where it left off, with no replay and no gaps.

## Handlers

- **`handlePartialFill(log)`**
  - Inserts into `fills` with `id = txHash + '_' + logIndex` and
    `ON CONFLICT (id) DO NOTHING` — a belt-and-suspenders guard against
    double-processing the same log (e.g. if a checkpoint write fails after
    the insert succeeds).
  - Recomputes `total_filled = SUM(fills.fill_amount)` for the order and sets
    `orders.status = 'filled'` once `total_filled >= input_amount`, otherwise
    `'active'`.

- **`handleFallbackExecuted(log)`**
  - Marks the order `'filled'` (the `FallbackExecutor` swapped whatever
    remained via Alpha Router).

## Reconnection

`provider.on('error', ...)` calls `startIndexer()` again after 5s. Because
checkpoints are persisted in Postgres (not in-memory), a reconnect resumes
from the last saved block rather than re-seeding from "now" again.
