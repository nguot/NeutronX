#!/usr/bin/env bash
# fork_block.sh — single source of truth for the anvil mainnet-fork block.
#
# Chain A and Chain B both fork from this exact block so their token balances
# / whale addresses line up (see chaina_anvil.sh / chainb_anvil.sh). Every
# launcher sources this file instead of hardcoding the number — bump it here
# ONCE instead of hunting down every copy (this file replaces literals that
# used to live independently in chaina_anvil.sh, chainb_anvil.sh, setup.sh,
# and scripts/race/common.sh, and drifted out of sync with each other).
#
# ${FORK_BLOCK:-...} still lets a one-off invocation override it via env var
# without editing this file, e.g.: FORK_BLOCK=25000000 bash setup.sh
export FORK_BLOCK="${FORK_BLOCK:-25450000}"
