#!/usr/bin/env bash
set -euo pipefail

APP_ENV_FILE="${1:-app/.env.dev}"
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VEILPAY_IDL_SOURCE="$ROOT_DIR/target/idl/veilpay.json"
VEILPAY_IDL_DEST="$ROOT_DIR/app/src/idl/veilpay.json"
VERIFIER_IDL_SOURCE="$ROOT_DIR/target/idl/verifier.json"
VERIFIER_IDL_DEST="$ROOT_DIR/app/src/idl/verifier.json"

if [[ ! -f "$APP_ENV_FILE" ]]; then
  echo "Missing env file: $APP_ENV_FILE" >&2
  exit 1
fi

VEILPAY_PROGRAM_ID=$(rg -n "^VITE_VEILPAY_PROGRAM_ID=" "$APP_ENV_FILE" | head -n1 | awk -F= '{print $2}')
VERIFIER_PROGRAM_ID=$(rg -n "^VITE_VERIFIER_PROGRAM_ID=" "$APP_ENV_FILE" | head -n1 | awk -F= '{print $2}')
RPC_ENDPOINT=$(rg -n "^VITE_RPC_ENDPOINT=" "$APP_ENV_FILE" | head -n1 | awk -F= '{print $2}')

if [[ -z "$VEILPAY_PROGRAM_ID" || -z "$VERIFIER_PROGRAM_ID" || -z "$RPC_ENDPOINT" ]]; then
  echo "Missing program IDs in $APP_ENV_FILE" >&2
  exit 1
fi

echo "Upgrading veilpay: $VEILPAY_PROGRAM_ID"
anchor build
anchor upgrade --program-id "$VEILPAY_PROGRAM_ID" --provider.cluster "$RPC_ENDPOINT" target/deploy/veilpay.so

echo "Upgrading verifier: $VERIFIER_PROGRAM_ID"
anchor upgrade --program-id "$VERIFIER_PROGRAM_ID" --provider.cluster "$RPC_ENDPOINT" target/deploy/verifier.so

if [[ -f "$VEILPAY_IDL_SOURCE" ]]; then
  cp "$VEILPAY_IDL_SOURCE" "$VEILPAY_IDL_DEST"
fi

if [[ -f "$VERIFIER_IDL_SOURCE" ]]; then
  cp "$VERIFIER_IDL_SOURCE" "$VERIFIER_IDL_DEST"
fi

echo "Done. Updated IDLs in app/src/idl if available."
