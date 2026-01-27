#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MODE="localnet"
ROOT_ENV_FILE="$ROOT_DIR/.env"
APP_ENV_FILE="$ROOT_DIR/app/.env"

RPC_URL=""
RELAYER_PUBKEY=""
MINT=""
FEE_PAYER=""
SOLANA_CONFIG=""

for arg in "$@"; do
  case "$arg" in
    --mode=*)
      MODE="${arg#*=}"
      ;;
    --rpc=*)
      RPC_URL="${arg#*=}"
      ;;
    --relayer=*)
      RELAYER_PUBKEY="${arg#*=}"
      ;;
    --mint=*)
      MINT="${arg#*=}"
      ;;
    --fee-payer=*)
      FEE_PAYER="${arg#*=}"
      ;;
    --config=*)
      SOLANA_CONFIG="${arg#*=}"
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ "$MODE" == "devnet" ]]; then
  ROOT_ENV_FILE="$ROOT_DIR/.env.devnet"
  APP_ENV_FILE="$ROOT_DIR/app/.env.devnet"
elif [[ -f "$ROOT_DIR/app/.env.localnet" ]]; then
  APP_ENV_FILE="$ROOT_DIR/app/.env.localnet"
fi

if [[ -z "$RPC_URL" && -f "$ROOT_ENV_FILE" ]]; then
  RPC_URL=$(rg -n "^RPC_URL=" "$ROOT_ENV_FILE" | head -n1 | cut -d= -f2-)
  if [[ -z "$RPC_URL" ]]; then
    RPC_URL=$(rg -n "^VITE_RPC_ENDPOINT=" "$ROOT_ENV_FILE" | head -n1 | cut -d= -f2-)
  fi
fi
if [[ -z "$RPC_URL" && -f "$APP_ENV_FILE" ]]; then
  RPC_URL=$(rg -n "^VITE_RPC_ENDPOINT=" "$APP_ENV_FILE" | head -n1 | cut -d= -f2-)
fi

if [[ -z "$RELAYER_PUBKEY" && -f "$APP_ENV_FILE" ]]; then
  RELAYER_PUBKEY=$(rg -n "^VITE_RELAYER_PUBKEY=" "$APP_ENV_FILE" | head -n1 | cut -d= -f2-)
fi

if [[ -z "$RPC_URL" ]]; then
  echo "Missing RPC URL. Pass --rpc=... or set RPC_URL/VITE_RPC_ENDPOINT in $ROOT_ENV_FILE or $APP_ENV_FILE." >&2
  exit 1
fi

if [[ -z "$RELAYER_PUBKEY" ]]; then
  echo "Missing relayer pubkey. Pass --relayer=... or set VITE_RELAYER_PUBKEY in $APP_ENV_FILE." >&2
  exit 1
fi

if [[ -z "$MINT" ]]; then
  echo "Missing mint. Pass --mint=... (e.g. WSOL mint)." >&2
  exit 1
fi

ATA=$(spl-token address --verbose --token "$MINT" --owner "$RELAYER_PUBKEY" --url "$RPC_URL")
if solana account "$ATA" --output json --url "$RPC_URL" >/dev/null 2>&1; then
  echo "Relayer ATA already exists: $ATA"
  exit 0
fi

echo "Creating relayer ATA for mint $MINT..."
create_args=(create-account "$MINT" --owner "$RELAYER_PUBKEY" --url "$RPC_URL")
if [[ -n "$FEE_PAYER" ]]; then
  create_args+=(--fee-payer "$FEE_PAYER")
fi
if [[ -n "$SOLANA_CONFIG" ]]; then
  create_args+=(--config "$SOLANA_CONFIG")
fi
spl-token "${create_args[@]}"
echo "Done. Relayer ATA: $ATA"
