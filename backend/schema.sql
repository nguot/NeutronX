-- schema.sql
CREATE TABLE IF NOT EXISTS orders (
    hash            TEXT PRIMARY KEY,
    swapper         TEXT NOT NULL,
    input_token     TEXT NOT NULL,
    output_token    TEXT NOT NULL,
    input_amount    TEXT NOT NULL,
    min_output      TEXT NOT NULL,
    deadline        BIGINT NOT NULL,
    nonce           BIGINT NOT NULL,
    min_fill_bps    INTEGER NOT NULL,
    start_price     TEXT NOT NULL,
    decay_per_block INTEGER NOT NULL,
    fee_tier        INTEGER NOT NULL,
    signature       TEXT NOT NULL,
    -- block number the auction curve starts decaying from (priceAt(b) = start_price -
    -- decay_per_block*(b - start_block)). NULL for orders created before this column
    -- existed; orderService falls back to deadline - AUCTION_BLOCKS for those.
    start_block     BIGINT,
    status              TEXT    NOT NULL DEFAULT 'pending',
    fallback_initiated  BOOLEAN NOT NULL DEFAULT false,
    -- swapper's preferred fallback aggregator (see backend/src/services/aggregators);
    -- NULL = "auto", let the fallback watcher pick the best quote across all of them.
    preferred_aggregator TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- idempotent migration for pre-existing databases
ALTER TABLE orders ADD COLUMN IF NOT EXISTS preferred_aggregator TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS start_block BIGINT;

CREATE TABLE IF NOT EXISTS fills (
    id              TEXT PRIMARY KEY,
    order_hash      TEXT NOT NULL REFERENCES orders(hash),
    filler          TEXT NOT NULL,
    fill_amount     TEXT NOT NULL,
    output_amount   TEXT NOT NULL,
    tx_hash         TEXT NOT NULL,
    path            JSONB,
    graph           JSONB,
    block_number    BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_swapper ON orders(swapper);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
CREATE INDEX IF NOT EXISTS idx_fills_order    ON fills(order_hash);