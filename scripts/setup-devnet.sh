#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
APP_ENV_FILE="$ROOT_DIR/app/.env.dev"

get_env_value() {
  local key="$1"
  if [[ -f "$APP_ENV_FILE" ]]; then
    rg -n "^${key}=" "$APP_ENV_FILE" | head -n1 | awk -F= '{print $2}'
  fi
}

RPC_URL="${RPC_URL:-$(get_env_value "VITE_RPC_ENDPOINT")}"
RELAYER_URL="${RELAYER_URL:-$(get_env_value "VITE_RELAYER_URL")}"

if [[ -z "$RPC_URL" ]]; then
  echo "Missing RPC URL. Set RPC_URL or VITE_RPC_ENDPOINT in $APP_ENV_FILE." >&2
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

if [[ ! -f "$APP_ENV_FILE" ]]; then
  if [[ -z "$RELAYER_URL" ]]; then
    echo "Missing RELAYER_URL. Set RELAYER_URL or VITE_RELAYER_URL to create $APP_ENV_FILE." >&2
    exit 1
  fi
  cat <<ENVEOF > "$APP_ENV_FILE"
VITE_RPC_ENDPOINT=$RPC_URL
VITE_RELAYER_URL=$RELAYER_URL
VITE_VEILPAY_PROGRAM_ID=
VITE_VERIFIER_PROGRAM_ID=
VITE_AIRDROP_URL=https://faucet.solana.com/
ENVEOF
fi

ensure_env "VITE_VEILPAY_PROGRAM_ID" "$VEILPAY_ID"
ensure_env "VITE_VERIFIER_PROGRAM_ID" "$VERIFIER_ID"

cat <<MSG
Deployed to devnet.
- Veilpay:  $VEILPAY_ID
- Verifier: $VERIFIER_ID
Updated $APP_ENV_FILE

Next: open the app in dev mode and run Initialize Config, Initialize VK Registry, Initialize Verifier Key.
MSG
