# NeutronX Demo — Quick Start

All commands run in WSL. Project root: `~/Documents/DATN/dex-aggregator`

# BUG: invalid sig or any long ass log (because ether js cannot read the contract code) => remember to check .evn usually address wrong

## Pick a version, then follow the steps

### Version 1 — Neutral market (~$2500 ETH)
```bash
# T1
bash tests/demo/v1_neutral_anvil.sh

# T2
cd backend && npm start

# T3
cd filler/WhaleFiller && npm start

# T4
cd filler/CoWFiller && npm start

# T5 — run in order, wait for each to finish
bash tests/demo/setup.sh
bash tests/demo/submit_order.sh
bash tests/demo/run.sh          # press ENTER between phases
bash tests/demo/verify.sh
```

### Version 2 — Bull market (~$3500 ETH)
Same steps, replace `v1_neutral_anvil.sh` with `v2_bull_anvil.sh`.

### Version 3 — Bear market (~$1900 ETH)
Same steps, replace with `v3_bull_anvil.sh`.
Expect: no filler fills, fallback only, swapper receives ~$7500 (below 9500 min).

## Log file
Each run writes to `tests/demo/logs/demo_<version>_<timestamp>.log`.
All 5 scripts (setup → submit → run → verify) append to the same file.

## Files
```
tests/demo/
├── OVERVIEW.md          ← full test spec, expected outputs per version
├── _lib.sh              ← shared logging functions (sourced by all scripts)
├── v1_neutral_anvil.sh  ← start Anvil at block 20,500,000
├── v2_bull_anvil.sh     ← start Anvil at block 19,500,000
├── v3_bear_anvil.sh     ← start Anvil at block 17,000,000
├── setup.sh             ← deploy contracts + fund wallets + approvals
├── submit_order.sh      ← POST the Dutch auction order
├── run.sh               ← mine blocks through register → execute → fallback
├── verify.sh            ← check final on-chain + backend state
└── logs/                ← log files written here at runtime
```
