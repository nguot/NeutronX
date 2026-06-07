#!/usr/bin/env bash
# _lib.sh — shared functions sourced by every demo script

PROJECT_ROOT="/mnt/c/Users/vutie/Documents/DATN/dex-aggregator"
LOG_DIR="$PROJECT_ROOT/tests/demo/logs"
RPC="http://127.0.0.1:8545"

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

# ── log file ─────────────────────────────────────────────────────────────────
# Each run writes to logs/demo_<version>_<timestamp>.log
# Scripts share the file via LOG_FILE env var written to .current_run
CURRENT_RUN_FILE="$LOG_DIR/.current_run"

init_log() {
  local version="${DEMO_VERSION:-vX}"
  local ts=$(date +%Y%m%d_%H%M%S)
  export LOG_FILE="$LOG_DIR/demo_${version}_${ts}.log"
  echo "$LOG_FILE" > "$CURRENT_RUN_FILE"
  mkdir -p "$LOG_DIR"
  {
    echo "========================================================"
    echo "  NeutronX Demo — $version"
    echo "  Started: $(date)"
    echo "  Fork block: ${FORK_BLOCK:-unknown}"
    echo "  Expected ETH price: ${EXPECTED_ETH_PRICE:-unknown}"
    echo "========================================================"
  } >> "$LOG_FILE"
}

load_log() {
  if [ -f "$CURRENT_RUN_FILE" ]; then
    export LOG_FILE=$(cat "$CURRENT_RUN_FILE")
  else
    export LOG_FILE="$LOG_DIR/demo_unknown_$(date +%Y%m%d_%H%M%S).log"
  fi
}

# ── logging ───────────────────────────────────────────────────────────────────
log() {
  local level="$1"; shift
  local msg="$*"
  local ts=$(date '+%H:%M:%S')
  case "$level" in
    STEP)  printf "\n${BOLD}${CYAN}[%s] ══ %s ══${NC}\n" "$ts" "$msg" | tee -a "$LOG_FILE" ;;
    OK)    printf "${GREEN}[%s] ✔  %s${NC}\n" "$ts" "$msg"             | tee -a "$LOG_FILE" ;;
    INFO)  printf "${BLUE}[%s] ℹ  %s${NC}\n"  "$ts" "$msg"             | tee -a "$LOG_FILE" ;;
    WARN)  printf "${YELLOW}[%s] ⚠  %s${NC}\n" "$ts" "$msg"            | tee -a "$LOG_FILE" ;;
    ERROR) printf "${RED}[%s] ✖  %s${NC}\n"   "$ts" "$msg"             | tee -a "$LOG_FILE" ;;
    RAW)   printf "%s\n" "$msg"                                         | tee -a "$LOG_FILE" ;;
  esac
}

# run a command, log its output, return its exit code
run_cmd() {
  local desc="$1"; shift
  log INFO "→ $desc"
  printf "  CMD: %s\n" "$*" >> "$LOG_FILE"
  local output code
  # Capture without letting set -e abort the script on non-zero exit
  output=$("$@" 2>&1) && code=0 || code=$?
  printf "%s\n" "$output" | tee -a "$LOG_FILE"
  if [ $code -eq 0 ]; then
    log OK "$desc"
  else
    log ERROR "$desc failed (exit $code)"
  fi
  return $code
}

# ── guards ────────────────────────────────────────────────────────────────────
check_anvil() {
  if ! cast block-number --rpc-url "$RPC" &>/dev/null; then
    log ERROR "Anvil not running at $RPC — start it first with v*_anvil.sh in a separate terminal"
    exit 1
  fi
  local block=$(cast block-number --rpc-url "$RPC")
  log OK "Anvil running — current block: $block"
}

check_backend() {
  if ! curl -sf http://localhost:3000/health &>/dev/null; then
    log ERROR "Backend not running — start it: cd backend && npm start"
    exit 1
  fi
  log OK "Backend running at :3000"
}

# ── helpers ───────────────────────────────────────────────────────────────────
get_block() {
  cast block-number --rpc-url "$RPC"
}

mine() {
  local n="$1"
  log INFO "Mining $n block(s)..."
  cast rpc anvil_mine "$n" --rpc-url "$RPC" >> "$LOG_FILE" 2>&1
  log OK "Mined $n block(s) — now at block $(get_block)"
}

update_env_var() {
  local file="$1" key="$2" val="$3"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$file"
  else
    echo "${key}=${val}" >> "$file"
  fi
}
