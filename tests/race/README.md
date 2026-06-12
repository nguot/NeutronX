# Filler-race E2E scenarios

Live end-to-end tests where the **two real filler bots** (CoWFiller + WhaleFiller)
compete to fill orders on an Anvil mainnet fork. Unlike the Foundry adversarial
tests (which *prove* the mechanics deterministically), these *demonstrate* the
actual bots racing under real concurrency.

The orders are deliberately **big**: each filler risks at most 50% of its USDC
inventory per fill (`MAX_INVENTORY_USE_BPS`), so **no single filler can fill 100%
of an order in one chunk**. Orders are therefore filled cooperatively across both
fillers in partial chunks — and any filler that registers but loses a chunk
reclaims its stake via the new `releaseRegistration` path.

## Prerequisites
- Foundry (`anvil`, `cast`, `forge`), `jq`, `curl`, Docker (Postgres), Node/npm
- `node_modules` installed in `backend/`, `filler/CoWFiller/`, `filler/WhaleFiller/`
  (`npm install` in each — they may have been cleared to save disk)
- A mainnet RPC for the fork; override with `FORK_RPC=<url>` if the default key is dead

## Run
```bash
cd tests/race
bash race_one_order.sh      # one 20 WETH order, two fillers cooperate
bash race_multi_order.sh    # three 16 WETH orders shared across both fillers
```
Each script boots its own stack (anvil → deploy → fund → backend → both bots),
submits the order(s), lets the bots race, asserts the outcome, and tears down.
Logs land in `tests/race/logs/`.

## What is asserted (winner-agnostic)
A live race's *winner* is not reproducible (it depends on tx timing / Anvil's
mining), so the scripts assert properties that hold regardless of who wins:
- the order is filled across **≥ 2 fills** (both fillers contributed);
- **no single fill covers 100%** of the order (the capacity cap held);
- the swapper received **≥ its min-output floor**;
- (multi) at least one order saw **both** fillers, and none was solo-filled.

## Notes
- Determinism lives in the Foundry suite (`contract/test/adversarial/` — see
  `contract/testcase.md`); these scripts add real-bot integration confidence.
- In the multi-order run, inventory depletes across orders, so the last order(s)
  may remain partially filled — a realistic outcome that the fallback executor
  would finish on a real deployment.
