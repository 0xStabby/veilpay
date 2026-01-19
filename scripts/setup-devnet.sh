#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROOT_ENV_FILE="$ROOT_DIR/.env.dev"
APP_ENV_FILE="$ROOT_DIR/app/.env.dev"
RESET_KEYS=0
RUN_ADMIN_BOOTSTRAP=1
SKIP_PROGRAM_CLOSE=0
RUN_RELAYER_PROVISION=1
RUN_CIRCUIT_BUILD=1

for arg in "$@"; do
  case "$arg" in
    --reset-keys)
      RESET_KEYS=1
      ;;
    --skip-program-close)
      SKIP_PROGRAM_CLOSE=1
      ;;
    --skip-admin-bootstrap)
      RUN_ADMIN_BOOTSTRAP=0
      ;;
    --skip-relayer-provision)
      RUN_RELAYER_PROVISION=0
      ;;
    --skip-circuit-build)
      RUN_CIRCUIT_BUILD=0
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

RPC_URL=$(rg -n "^RPC_URL=" "$ROOT_ENV_FILE" | head -n1 | cut -d= -f2-)
if [[ -z "$RPC_URL" ]]; then
  RPC_URL=$(rg -n "^VITE_RPC_ENDPOINT=" "$ROOT_ENV_FILE" | head -n1 | cut -d= -f2-)
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

ensure_root_env() {
  local key="$1"
  local value="$2"
  if rg -q "^${key}=" "$ROOT_ENV_FILE"; then
    perl -pi -e "s|^${key}=.*|${key}=${value}|" "$ROOT_ENV_FILE"
  else
    echo "${key}=${value}" >> "$ROOT_ENV_FILE"
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

if [[ "$RESET_KEYS" == "1" && "$SKIP_PROGRAM_CLOSE" != "1" ]]; then
  "$ROOT_DIR/scripts/close-devnet-programs.sh" || true
fi

ensure_keypair "veilpay"
ensure_keypair "verifier"

anchor keys sync

if [[ "$RUN_CIRCUIT_BUILD" == "1" ]]; then
  "$ROOT_DIR/scripts/build-circuits.sh"
fi

VKEY_PATH="$ROOT_DIR/app/public/prover/verification_key.json"
ZKEY_PATH="$ROOT_DIR/app/public/prover/veilpay.zkey"
FIXTURE_PATH="$ROOT_DIR/app/src/fixtures/verifier_key.json"
if [[ -f "$ZKEY_PATH" ]]; then
  tmp_vkey="$(mktemp)"
  pnpm exec snarkjs zkey export verificationkey "$ZKEY_PATH" "$tmp_vkey"
  if [[ -f "$VKEY_PATH" ]]; then
    if ! diff -q "$VKEY_PATH" "$tmp_vkey" >/dev/null; then
      echo "verification_key.json out of sync with veilpay.zkey; updating."
      mv "$tmp_vkey" "$VKEY_PATH"
    else
      rm "$tmp_vkey"
    fi
  else
    mv "$tmp_vkey" "$VKEY_PATH"
  fi
else
  echo "Missing $ZKEY_PATH. Run scripts/build-circuits.sh first." >&2
  exit 1
fi

if [[ -f "$VKEY_PATH" ]]; then
  node "$ROOT_DIR/scripts/export-verifier-key.js" "$VKEY_PATH" "$FIXTURE_PATH"
else
  echo "Missing $VKEY_PATH. Run scripts/build-circuits.sh first." >&2
  exit 1
fi

anchor build
anchor deploy --provider.cluster "$RPC_URL"

VEILPAY_ID=$(solana address -k "$ROOT_DIR/target/deploy/veilpay-keypair.json")
VERIFIER_ID=$(solana address -k "$ROOT_DIR/target/deploy/verifier-keypair.json")
IDL_SOURCE="$ROOT_DIR/target/idl/veilpay.json"
IDL_DEST="$ROOT_DIR/app/src/idl/veilpay.json"
VERIFIER_IDL_SOURCE="$ROOT_DIR/target/idl/verifier.json"
VERIFIER_IDL_DEST="$ROOT_DIR/app/src/idl/verifier.json"

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
ensure_root_env "VITE_VEILPAY_PROGRAM_ID" "$VEILPAY_ID"
ensure_root_env "VITE_VERIFIER_PROGRAM_ID" "$VERIFIER_ID"

if [[ -f "$IDL_SOURCE" ]]; then
  cp "$IDL_SOURCE" "$IDL_DEST"
else
  echo "Missing IDL at $IDL_SOURCE. Did anchor build generate it?" >&2
  exit 1
fi

if [[ -f "$VERIFIER_IDL_SOURCE" ]]; then
  cp "$VERIFIER_IDL_SOURCE" "$VERIFIER_IDL_DEST"
else
  echo "Missing IDL at $VERIFIER_IDL_SOURCE. Did anchor build generate it?" >&2
  exit 1
fi

if [[ "$RUN_RELAYER_PROVISION" == "1" ]]; then
  "$ROOT_DIR/scripts/relayer-provision.sh"
fi

if [[ "$RUN_RELAYER_PROVISION" == "1" ]]; then
  RELAYER_IP="$(terraform -chdir="$ROOT_DIR/infra/relayer" output -raw relayer_ip 2>/dev/null || true)"
  if [[ -n "$RELAYER_IP" ]]; then
    ensure_env "VITE_RELAYER_URL" "http://${RELAYER_IP}"
  fi
fi

RELAYER_DOMAIN="$(rg -n "^RELAYER_DOMAIN=" "$ROOT_DIR/relayer/.env.dev" | head -n1 | cut -d= -f2-)"
if [[ -n "$RELAYER_DOMAIN" ]]; then
  ensure_env "VITE_RELAYER_URL" "https://${RELAYER_DOMAIN}"
fi

cat <<MSG
Deployed to devnet.
- Veilpay:  $VEILPAY_ID
- Verifier: $VERIFIER_ID
Updated $APP_ENV_FILE (program IDs only)
Updated $IDL_DEST from $IDL_SOURCE

Admin bootstrap will run next (config, VK registry, verifier key, mint state, WSOL wrap).
MSG

if [[ "$RUN_ADMIN_BOOTSTRAP" == "1" ]]; then
  anchor run admin-bootstrap -- --env "$ROOT_ENV_FILE"
fi
