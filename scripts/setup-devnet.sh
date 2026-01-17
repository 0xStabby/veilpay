#!/usr/bin/env bash
set -euo pipefail

RPC_URL="https://betty-1cgsj3-fast-devnet.helius-rpc.com"
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
APP_ENV_FILE="$ROOT_DIR/app/.env.dev"

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
  cat <<'ENVEOF' > "$APP_ENV_FILE"
VITE_RPC_ENDPOINT=https://api.devnet.solana.com
VITE_RELAYER_URL=http://66.42.64.115
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
