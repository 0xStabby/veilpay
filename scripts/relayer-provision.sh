#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${ROOT_DIR}/infra/relayer"

terraform -chdir="${TF_DIR}" init -upgrade
terraform -chdir="${TF_DIR}" apply -auto-approve

"${ROOT_DIR}/scripts/relayer-redeploy.sh"
