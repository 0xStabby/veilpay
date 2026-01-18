#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELAYER_DIR="${ROOT_DIR}/relayer"
TF_DIR="${ROOT_DIR}/infra/relayer"

SSH_USER="${SSH_USER:-root}"
SERVER_IP="${1:-}"
SSH_OPTS=(
  -o BatchMode=yes
  -o ConnectTimeout=5
  -o StrictHostKeyChecking=accept-new
)

if [[ -z "${SERVER_IP}" ]]; then
  SERVER_IP="$(terraform -chdir="${TF_DIR}" output -raw relayer_ip)"
fi

wait_for_ssh() {
  local max_attempts=30
  local attempt=1
  while [[ "${attempt}" -le "${max_attempts}" ]]; do
    if ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SERVER_IP}" "echo ok" >/dev/null 2>&1; then
      return 0
    fi
    echo "Waiting for SSH on ${SERVER_IP} (${attempt}/${max_attempts})..."
    sleep 5
    attempt=$((attempt + 1))
  done
  echo "Timed out waiting for SSH on ${SERVER_IP}."
  return 1
}

pnpm -C "${RELAYER_DIR}" install
pnpm -C "${RELAYER_DIR}" build

wait_for_ssh

ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SERVER_IP}" "mkdir -p /opt/veilpay-relayer/dist"

rsync -az --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  "${RELAYER_DIR}/dist/" \
  "${SSH_USER}@${SERVER_IP}:/opt/veilpay-relayer/dist/"

rsync -az \
  -e "ssh ${SSH_OPTS[*]}" \
  "${RELAYER_DIR}/package.json" \
  "${RELAYER_DIR}/pnpm-lock.yaml" \
  "${SSH_USER}@${SERVER_IP}:/opt/veilpay-relayer/"

if [[ -f "${RELAYER_DIR}/.env.dev" ]]; then
  rsync -az \
    -e "ssh ${SSH_OPTS[*]}" \
    "${RELAYER_DIR}/.env.dev" \
    "${SSH_USER}@${SERVER_IP}:/opt/veilpay-relayer/.env"
fi

ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SERVER_IP}" \
  "cd /opt/veilpay-relayer && pnpm install --prod && systemctl restart veilpay-relayer"
