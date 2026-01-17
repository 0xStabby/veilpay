#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
APP_ENV_FILE="$ROOT_DIR/app/.env.dev"

if [[ ! -f "$APP_ENV_FILE" ]]; then
  echo "Missing $APP_ENV_FILE. Create it with VITE_RPC_ENDPOINT first." >&2
  exit 1
fi

RPC_URL=$(rg -n "^VITE_RPC_ENDPOINT=" "$APP_ENV_FILE" | head -n1 | awk -F= '{print $2}')
if [[ -z "$RPC_URL" ]]; then
  echo "Missing VITE_RPC_ENDPOINT in $APP_ENV_FILE." >&2
  exit 1
fi

ensure_env() {
  local key="$1"
  local value="$2"
  if rg -q "^${key}=" "$APP_ENV_FILE"; then
    perl -pi -e "s|^${key}=.*|${key}=${value}|" "$APP_ENV_FILE"
  else
    echo "${key}=${value}" >> "$APP_ENV_FILE"
  fi
}

anchor build
anchor deploy --provider.cluster "$RPC_URL"

VEILPAY_ID=$(solana address -k "$ROOT_DIR/target/deploy/veilpay-keypair.json")
VERIFIER_ID=$(solana address -k "$ROOT_DIR/target/deploy/verifier-keypair.json")

ensure_env "VITE_VEILPAY_PROGRAM_ID" "$VEILPAY_ID"
ensure_env "VITE_VERIFIER_PROGRAM_ID" "$VERIFIER_ID"

cat <<MSG
Deployed to devnet.
- Veilpay:  $VEILPAY_ID
- Verifier: $VERIFIER_ID
Updated $APP_ENV_FILE

Next: open the app in dev mode and run Initialize Config, Initialize VK Registry, Initialize Verifier Key.
MSG
