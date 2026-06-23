# Filler CLI

Both fillers ship a terminal CLI that replaces the old in-browser dev console.
It drives the same operations the HTML dashboard did — list orders, preview and
execute fills, and run cross-chain Merkle slots — but as scriptable commands.

The bot process (`npm start`) is unchanged; it still runs the listener, the
auto-fill executor, and a slim quote API (`POST /quote`, `GET /health`). The CLI
is a **separate, standalone** invocation: it talks to the chain directly, so the
bot does **not** need to be running for `fill` / `cc` to work (the backend and
Anvil do).

| Filler | strategy | quote API port | CLI binary |
|--------|----------|----------------|------------|
| `CoWFiller`   | orderbook / CoW matching        | `3002` | `cowfiller`   |
| `WhaleFiller` | inventory market-maker (spread) | `3001` | `whalefiller` |

The two CLIs are identical in command surface — only the name, port, and the
underlying fill strategy differ.

---

## Setup

```bash
cd filler/CoWFiller      # or filler/WhaleFiller
npm install
```

Configuration is read from that filler's `.env` (see `.env.example`). Key vars:

| var | meaning |
|-----|---------|
| `BACKEND_URL` | NeutronX backend (default `http://localhost:3000`) |
| `ALCHEMY_RPC_URL` | Chain A RPC (the Anvil fork) |
| `PRIVATE_KEY` | the filler wallet key |
| `PARTIAL_FILL_REACTOR`, `FILL_AUCTION` | core contract addresses (written by `tests/demo/setup.sh`) |
| `CHAIN_B_RPC`, `ESCROW_*`, `CHAIN_*_FACTORY` | cross-chain addresses (written by `tests/crosschain/setup_cc.sh`) |
| `DEV_MODE` | `true` to auto-seed inventory on start and fund before each fill |

---

## Running

```bash
npm run cli -- <command> [args]      # via npm
npx ts-node src/cli.ts <command>     # direct
```

> The `--` after `npm run cli` is required so flags reach the CLI rather than npm.

Show help at any level:

```bash
npm run cli -- --help
npm run cli -- cc --help
```

---

## Commands

### `orders`
List all open (pending + active) orders with a live progress bar, current
auction price, and blocks-to-deadline.

```bash
npm run cli -- orders
npm run cli -- orders --watch        # auto-refresh every 12s
npm run cli -- orders --watch 5      # auto-refresh every 5s
```

### `balances`
Wallet balances (ETH + every supported token) on Chain A, and Chain B if
`CHAIN_B_RPC` is set.

```bash
npm run cli -- balances
```

### `sim <hash> [--pct <n>]`
Dry-run preview of a fill — **no transaction**. Shows what you'd receive/provide,
the price, and the resulting fill %, or a red warning if the fill would revert
against the swapper's `minOutput` floor.

```bash
npm run cli -- sim 0x9f3a… --pct 50   # default --pct 50
```

### `fill <hash> [--pct <n>]`
Execute a partial fill: `register → approve → executePartialChunk`. `--pct` is the
percentage of the order's **remaining** input to take (default `100`). A spinner
shows progress; on revert you get the detailed, actionable reason.

```bash
npm run cli -- fill 0x9f3a…          # fill 100% of remaining
npm run cli -- fill 0x9f3a… --pct 25 # fill a quarter of remaining
```

### `cc list`
List cross-chain orders and the per-slot status (available / locked / claimed /
done) plus which filler owns each filled slot.

```bash
npm run cli -- cc list
npm run cli -- cc list --watch       # auto-refresh every 15s
```

### `cc fill <hash> <slot>`
Fill one cross-chain Merkle slot end-to-end: `fillSlot` on the source chain →
fund + deploy the EscrowDst clone on the destination chain → wait for the backend
to claim (reveals `S_i`) → `withdraw` on the source chain.

```bash
npm run cli -- cc fill 0x7c1b… 0
```

### `cc claim <hash> <slot>`
Recovery action: the backend already claimed on the destination chain but this
filler timed out before withdrawing on the source chain. Scans for the revealed
secret and completes the `withdraw`. If the slot turns out to be stale (chain
restarted), it resets the slot back to `available`.

```bash
npm run cli -- cc claim 0x7c1b… 0
```

### `cc reset <hash> <slot>`
Reset a stuck `locked` slot back to `available` (e.g. after the destination chain
was restarted). Only do this if you know the slot is genuinely abandoned.

```bash
npm run cli -- cc reset 0x7c1b… 0
```

### `quote --in --out --amount --start-price --decay [...]`
Run the filler's fill strategy against an ad-hoc order without placing it — the
same logic the backend hits via `POST /quote`. Useful for checking whether (and
how much) this filler would fill a hypothetical order.

```bash
npm run cli -- quote \
  --in 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 \
  --out 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --amount 1000000000000000000 \
  --start-price 3000000000 \
  --decay 100000
```

Optional: `--min-fill-bps` (default 100), `--deadline <block>`, `--fee-tier` (default 500).

### `seed`
Dev-only: seed the wallet with "infinite-ish" inventory (big ETH balance, wrapped
WETH, major ERC-20s pulled from a Binance whale) on Chain A and Chain B. Same as
`npm run seed`.

```bash
npm run cli -- seed
```

---

## Typical dev flow

```bash
# 0. backend + anvil running, contracts deployed (tests/demo/setup.sh)
cd filler/CoWFiller
npm run seed                 # fund the wallet (once per fresh anvil)
npm run cli -- orders        # see what's open
npm run cli -- sim 0x… --pct 50   # preview
npm run cli -- fill 0x… --pct 50  # execute

# cross-chain (after tests/crosschain/setup_cc.sh)
npm run cli -- cc list
npm run cli -- cc fill 0x… 0
```
