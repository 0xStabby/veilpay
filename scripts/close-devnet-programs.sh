#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_ENV_FILE="${ROOT_ENV_FILE:-$ROOT_DIR/.env.dev}"
APP_ENV_FILE="${APP_ENV_FILE:-$ROOT_DIR/app/.env.dev}"
AUTHORITY="${AUTHORITY:-}"
RECIPIENT="${RECIPIENT:-}"

for arg in "$@"; do
  case "$arg" in
    --authority=*)
      AUTHORITY="${arg#*=}"
      ;;
    --recipient=*)
      RECIPIENT="${arg#*=}"
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

read_env_value() {
  local key="$1"
  local file="$2"
  if [[ -f "$file" ]]; then
    rg -n "^${key}=" "$file" | head -n1 | cut -d= -f2-
  fi
}

RPC_URL="$(read_env_value "RPC_URL" "$ROOT_ENV_FILE")"
if [[ -z "$RPC_URL" ]]; then
  RPC_URL="$(read_env_value "VITE_RPC_ENDPOINT" "$ROOT_ENV_FILE")"
fi
if [[ -z "$RPC_URL" ]]; then
  RPC_URL="$(read_env_value "VITE_RPC_ENDPOINT" "$APP_ENV_FILE")"
fi

VEILPAY_ID="$(read_env_value "VITE_VEILPAY_PROGRAM_ID" "$ROOT_ENV_FILE")"
VERIFIER_ID="$(read_env_value "VITE_VERIFIER_PROGRAM_ID" "$ROOT_ENV_FILE")"
if [[ -z "$VEILPAY_ID" || -z "$VERIFIER_ID" ]]; then
  VEILPAY_ID="${VEILPAY_ID:-$(read_env_value "VITE_VEILPAY_PROGRAM_ID" "$APP_ENV_FILE")}"
  VERIFIER_ID="${VERIFIER_ID:-$(read_env_value "VITE_VERIFIER_PROGRAM_ID" "$APP_ENV_FILE")}"
fi

if [[ -z "$VEILPAY_ID" || -z "$VERIFIER_ID" ]]; then
  echo "Missing program IDs in $ROOT_ENV_FILE (or fallback $APP_ENV_FILE)." >&2
  exit 1
fi

close_program() {
  local program_id="$1"
  local label="$2"
  local failed=0
  echo "Closing ${label}: ${program_id}"

  local args=()
  if [[ -n "$RPC_URL" ]]; then
    args+=("--url" "$RPC_URL")
  fi
  if [[ -n "$AUTHORITY" ]]; then
    args+=("--authority" "$AUTHORITY")
  fi
  if [[ -n "$RECIPIENT" ]]; then
    args+=("--recipient" "$RECIPIENT")
  fi

  local programdata
  programdata="$(solana program show "$program_id" --output json "${args[@]}" 2>/dev/null | python - <<'PY'
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("")
    sys.exit(0)
for key in ("programdataAddress", "programDataAddress"):
    value = data.get(key)
    if value:
        print(value)
        break
PY
)"

  if [[ -n "$programdata" ]]; then
    echo "Closing programdata: ${programdata}"
    if ! solana program close "$programdata" --bypass-warning "${args[@]}"; then
      echo "Failed to close programdata for ${label}." >&2
      failed=1
    fi
  else
    echo "No programdata address found (not upgradeable or not found)."
  fi

  if ! solana program close "$program_id" --bypass-warning "${args[@]}"; then
    echo "Failed to close program ${label}." >&2
    failed=1
  fi

  return "$failed"
}

echo "RPC_URL: ${RPC_URL:-<default>}"
echo "Authority: ${AUTHORITY:-<default>}"
echo "Recipient: ${RECIPIENT:-<default>}"

close_program "$VEILPAY_ID" "veilpay" || true
close_program "$VERIFIER_ID" "verifier" || true

echo "Program close complete."
