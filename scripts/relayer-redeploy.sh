#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELAYER_DIR="${ROOT_DIR}/relayer"
TF_DIR="${ROOT_DIR}/infra/relayer"

SSH_USER="${SSH_USER:-root}"
SERVER_IP="${1:-}"

if [[ -z "${SERVER_IP}" ]]; then
  SERVER_IP="$(terraform -chdir="${TF_DIR}" output -raw relayer_ip)"
fi

pnpm -C "${RELAYER_DIR}" install
pnpm -C "${RELAYER_DIR}" build

rsync -az --delete \
  "${RELAYER_DIR}/dist/" \
  "${SSH_USER}@${SERVER_IP}:/opt/veilpay-relayer/dist/"

rsync -az \
  "${RELAYER_DIR}/package.json" \
  "${RELAYER_DIR}/pnpm-lock.yaml" \
  "${SSH_USER}@${SERVER_IP}:/opt/veilpay-relayer/"

ssh "${SSH_USER}@${SERVER_IP}" \
  "cd /opt/veilpay-relayer && pnpm install --prod && systemctl restart veilpay-relayer"
