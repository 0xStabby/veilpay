#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ENV_FILE="${APP_ENV_FILE:-$ROOT_DIR/app/.env.devnet}"
RELAYER_ENV_FILE="${RELAYER_ENV_FILE:-$ROOT_DIR/relayer/.env.devnet}"
SKIP_INSTALL=0
SKIP_APP_BUILD=0
SKIP_RELAYER_BUILD=0
REBUILD_CIRCUITS=0
SKIP_VERCEL=0
SKIP_ADMIN_BOOTSTRAP=0

for arg in "$@"; do
  case "$arg" in
    --skip-install)
      SKIP_INSTALL=1
      ;;
    --skip-app-build)
      SKIP_APP_BUILD=1
      ;;
    --skip-relayer-build)
      SKIP_RELAYER_BUILD=1
      ;;
    --rebuild-circuits)
      REBUILD_CIRCUITS=1
      ;;
    --skip-vercel)
      SKIP_VERCEL=1
      ;;
    --skip-admin-bootstrap)
      SKIP_ADMIN_BOOTSTRAP=1
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

ensure_env() {
  local file="$1"
  local key="$2"
  local value="$3"
  if rg -q "^${key}=" "$file"; then
    perl -pi -e "s|^${key}=.*|${key}=${value}|" "$file"
  else
    echo "${key}=${value}" >> "$file"
  fi
}

sync_relayer_env() {
  if [[ ! -f "$APP_ENV_FILE" ]]; then
    echo "Missing app env file: $APP_ENV_FILE" >&2
    exit 1
  fi

  local rpc
  rpc=$(rg -n "^VITE_RPC_ENDPOINT=" "$APP_ENV_FILE" | head -n1 | awk -F= '{print $2}')
  if [[ -z "$rpc" ]]; then
    echo "Missing VITE_RPC_ENDPOINT in $APP_ENV_FILE" >&2
    exit 1
  fi

  if [[ ! -f "$RELAYER_ENV_FILE" ]]; then
    cat <<'ENVEOF' > "$RELAYER_ENV_FILE"
RELAYER_RPC_URL=
RELAYER_ALLOWED_ORIGINS=*
PORT=8080
ENVEOF
  fi

  ensure_env "$RELAYER_ENV_FILE" "RELAYER_RPC_URL" "$rpc"
  ensure_env "$RELAYER_ENV_FILE" "RELAYER_ALLOWED_ORIGINS" "*"
}

if [[ "$SKIP_INSTALL" != "1" ]]; then
  pnpm install
fi

cargo build -p ark-prover

if [[ "$REBUILD_CIRCUITS" == "1" ]]; then
  bash "$ROOT_DIR/scripts/build-circuits.sh"
fi

bash "$ROOT_DIR/scripts/anchor-upgrade-devnet.sh" "$APP_ENV_FILE"
sync_relayer_env

if [[ "$SKIP_ADMIN_BOOTSTRAP" != "1" ]]; then
  TS_NODE_TRANSPILE_ONLY=1 \
    pnpm -C "$ROOT_DIR/app" exec ts-node \
    --project "$ROOT_DIR/app/tsconfig.node.json" \
    "$ROOT_DIR/scripts/admin-bootstrap.ts" --env "$APP_ENV_FILE"
fi

if [[ "$SKIP_RELAYER_BUILD" != "1" ]]; then
  pnpm -C "$ROOT_DIR/relayer" build
fi

if [[ "$SKIP_APP_BUILD" != "1" ]]; then
  pnpm -C "$ROOT_DIR/app" build
fi

if [[ "$SKIP_VERCEL" != "1" ]]; then
  if ! command -v vercel >/dev/null 2>&1; then
    echo "Missing vercel CLI. Install it or run with --skip-vercel." >&2
    exit 1
  fi
  vercel --prod --yes
fi

cat <<MSG
Update complete.
- Programs upgraded, app IDLs refreshed
- Relayer env synced at $RELAYER_ENV_FILE
MSG

if [[ "$REBUILD_CIRCUITS" == "1" ]]; then
  echo "Circuits rebuilt."
else
  echo "Circuits not rebuilt. Use --rebuild-circuits for a fresh deploy only."
fi

if [[ "$SKIP_ADMIN_BOOTSTRAP" != "1" ]]; then
  echo "Admin bootstrap executed."
else
  echo "Admin bootstrap skipped."
fi
