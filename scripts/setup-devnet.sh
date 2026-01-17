#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROOT_ENV_FILE="$ROOT_DIR/.env.dev"
APP_ENV_FILE="$ROOT_DIR/app/.env.dev"
RESET_KEYS=0

for arg in "$@"; do
  case "$arg" in
    --reset-keys)
      RESET_KEYS=1
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$ROOT_ENV_FILE" ]]; then
  echo "Missing $ROOT_ENV_FILE. Create it with RPC_URL or VITE_RPC_ENDPOINT." >&2
  exit 1
fi

RPC_URL=$(rg -n "^RPC_URL=" "$ROOT_ENV_FILE" | head -n1 | awk -F= '{print $2}')
if [[ -z "$RPC_URL" ]]; then
  RPC_URL=$(rg -n "^VITE_RPC_ENDPOINT=" "$ROOT_ENV_FILE" | head -n1 | awk -F= '{print $2}')
fi
if [[ -z "$RPC_URL" ]]; then
  echo "Missing RPC_URL (or VITE_RPC_ENDPOINT) in $ROOT_ENV_FILE." >&2
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

ensure_keypair() {
  local name="$1"
  local path="$ROOT_DIR/target/deploy/${name}-keypair.json"
  if [[ "$RESET_KEYS" == "1" ]]; then
    rm -f "$path"
  fi
  if [[ ! -f "$path" ]]; then
    mkdir -p "$(dirname "$path")"
    solana-keygen new --no-bip39-passphrase -o "$path" -f >/dev/null
    echo "Generated ${name} program keypair: $path"
  fi
}

ensure_keypair "veilpay"
ensure_keypair "verifier"

anchor keys sync

anchor build
anchor deploy --provider.cluster "$RPC_URL"

VEILPAY_ID=$(solana address -k "$ROOT_DIR/target/deploy/veilpay-keypair.json")
VERIFIER_ID=$(solana address -k "$ROOT_DIR/target/deploy/verifier-keypair.json")

if [[ ! -f "$APP_ENV_FILE" ]]; then
  cat <<'ENVEOF' > "$APP_ENV_FILE"
VITE_RPC_ENDPOINT=
VITE_RELAYER_URL=
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
Updated $APP_ENV_FILE (program IDs only)

Next: open the app in dev mode and run Initialize Config, Initialize VK Registry, Initialize Verifier Key.
MSG
