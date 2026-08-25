#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=/dev/null
source "${BASE_DIR}/lib/zero-downtime-check-lib.sh"

zero_downtime_check_main "$@"