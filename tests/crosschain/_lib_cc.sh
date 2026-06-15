#!/usr/bin/env bash
# _lib_cc.sh — shared functions sourced by crosschain test scripts
# (local copy of tests/demo/_lib.sh, trimmed to what crosschain scripts use —
#  two RPCs means the single-RPC helpers like check_anvil/mine don't apply here)

PROJECT_ROOT="/mnt/c/Users/vutie/Documents/DATN/dex-aggregator"
LOG_DIR="$PROJECT_ROOT/tests/crosschain/logs"

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

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
check_backend() {
  if ! curl -sf http://localhost:3000/health &>/dev/null; then
    log ERROR "Backend not running — start it: cd backend && npm start"
    exit 1
  fi
  log OK "Backend running at :3000"
}

# ── helpers ───────────────────────────────────────────────────────────────────
update_env_var() {
  local file="$1" key="$2" val="$3"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$file"
  else
    # Ensure the file ends with a newline so the new entry doesn't get
    # concatenated onto the last existing line.
    [ -s "$file" ] && [ -z "$(tail -c1 "$file")" ] || echo >> "$file"
    echo "${key}=${val}" >> "$file"
  fi
}
