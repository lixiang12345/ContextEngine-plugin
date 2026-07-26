#!/usr/bin/env bash
set -euo pipefail

service_dir="${CE_SERVICE_DIR:-/root/ce-services}"
env_file="${CE_ENV_FILE:-${service_dir}/ce.env}"

if [[ ! -r "${env_file}" ]]; then
  echo "ContextEngine model environment is not readable: ${env_file}" >&2
  exit 1
fi

set -a
source "${env_file}"
set +a

exec "${service_dir}/venv/bin/python" -m uvicorn server:app \
  --host 127.0.0.1 \
  --port "${CE_PORT:-8000}" \
  --workers 1
