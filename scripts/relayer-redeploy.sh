#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELAYER_DIR="${ROOT_DIR}/relayer"
TF_DIR="${ROOT_DIR}/infra/relayer"
ROOT_ENV_FILE="${ROOT_DIR}/.env.devnet"
RELAYER_ENV_FILE="${RELAYER_DIR}/.env.devnet"

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

upsert_env() {
  local file="$1"
  local key="$2"
  local value="$3"
  if [[ -z "${value}" ]]; then
    return 0
  fi
  if rg -q "^${key}=" "$file"; then
    perl -pi -e "s|^${key}=.*|${key}=${value}|" "$file"
  else
    echo "${key}=${value}" >> "$file"
  fi
}

if [[ -f "${ROOT_ENV_FILE}" && -f "${RELAYER_ENV_FILE}" ]]; then
  VEILPAY_ID="$(rg -n "^VITE_VEILPAY_PROGRAM_ID=" "${ROOT_ENV_FILE}" | head -n1 | cut -d= -f2-)"
  VERIFIER_ID="$(rg -n "^VITE_VERIFIER_PROGRAM_ID=" "${ROOT_ENV_FILE}" | head -n1 | cut -d= -f2-)"
  if [[ -n "${VEILPAY_ID}" && -n "${VERIFIER_ID}" ]]; then
    upsert_env "${RELAYER_ENV_FILE}" "RELAYER_ALLOWED_PROGRAMS" "${VEILPAY_ID},${VERIFIER_ID}"
  fi
  upsert_env "${RELAYER_ENV_FILE}" "RELAYER_KEYPAIR" "/opt/veilpay-relayer/relayer-keypair.json"
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

if [[ -f "${RELAYER_DIR}/.env.devnet" ]]; then
  rsync -az \
    -e "ssh ${SSH_OPTS[*]}" \
    "${RELAYER_DIR}/.env.devnet" \
    "${SSH_USER}@${SERVER_IP}:/opt/veilpay-relayer/.env"
fi
if [[ -f "${RELAYER_DIR}/relayer-keypair.json" ]]; then
  rsync -az \
    -e "ssh ${SSH_OPTS[*]}" \
    "${RELAYER_DIR}/relayer-keypair.json" \
    "${SSH_USER}@${SERVER_IP}:/opt/veilpay-relayer/relayer-keypair.json"
fi

ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SERVER_IP}" \
  "if [[ -d /opt/veilpay-relayer ]]; then \
    chown -R relayer:relayer /opt/veilpay-relayer; \
    if [[ -f /opt/veilpay-relayer/relayer-keypair.json ]]; then \
      chmod 600 /opt/veilpay-relayer/relayer-keypair.json; \
    fi; \
  fi; \
  cd /opt/veilpay-relayer && pnpm install --prod && \
  systemctl restart veilpay-relayer && systemctl is-active --quiet veilpay-relayer && \
  echo \"[relayer] restart ok\" && \
  if command -v ufw >/dev/null 2>&1; then \
    sudo ufw allow 80/tcp; \
    sudo ufw allow 443/tcp; \
    sudo ufw status verbose; \
  fi; \
  if command -v certbot >/dev/null 2>&1; then \
    DOMAIN=\$(grep -E '^RELAYER_DOMAIN=' /opt/veilpay-relayer/.env | head -n1 | cut -d= -f2-); \
    EMAIL=\$(grep -E '^RELAYER_CERT_EMAIL=' /opt/veilpay-relayer/.env | head -n1 | cut -d= -f2-); \
    if [[ -n \"\$DOMAIN\" && -n \"\$EMAIL\" ]]; then \
      sudo sed -i \"s/^\\s*server_name .*/    server_name \${DOMAIN};/\" /etc/nginx/sites-enabled/veilpay-relayer || true; \
      if systemctl is-active --quiet nginx; then \
        sudo nginx -t && sudo systemctl reload nginx && echo \"[nginx] reloaded\" || echo \"[nginx] reload failed\"; \
      else \
        sudo nginx -t && sudo systemctl start nginx && echo \"[nginx] started\" || echo \"[nginx] start failed\"; \
      fi; \
      if [[ ! -f \"/etc/letsencrypt/live/\${DOMAIN}/fullchain.pem\" ]]; then \
        certbot --nginx -d \"\$DOMAIN\" --non-interactive --agree-tos -m \"\$EMAIL\" || true; \
        if systemctl is-active --quiet nginx; then \
          systemctl reload nginx && echo \"[nginx] reloaded\" || echo \"[nginx] reload failed\"; \
        fi; \
      fi; \
    fi; \
  else \
    DOMAIN=\$(grep -E '^RELAYER_DOMAIN=' /opt/veilpay-relayer/.env | head -n1 | cut -d= -f2-); \
    EMAIL=\$(grep -E '^RELAYER_CERT_EMAIL=' /opt/veilpay-relayer/.env | head -n1 | cut -d= -f2-); \
    if [[ -n \"\$DOMAIN\" && -n \"\$EMAIL\" ]]; then \
      sudo apt-get update && sudo apt-get install -y certbot python3-certbot-nginx; \
      sudo sed -i \"s/^\\s*server_name .*/    server_name \${DOMAIN};/\" /etc/nginx/sites-enabled/veilpay-relayer || true; \
      if systemctl is-active --quiet nginx; then \
        sudo nginx -t && sudo systemctl reload nginx && echo \"[nginx] reloaded\" || echo \"[nginx] reload failed\"; \
      else \
        sudo nginx -t && sudo systemctl start nginx && echo \"[nginx] started\" || echo \"[nginx] start failed\"; \
      fi; \
      certbot --nginx -d \"\$DOMAIN\" --non-interactive --agree-tos -m \"\$EMAIL\" || true; \
      if systemctl is-active --quiet nginx; then \
        systemctl reload nginx && echo \"[nginx] reloaded\" || echo \"[nginx] reload failed\"; \
      fi; \
    fi; \
  fi"
