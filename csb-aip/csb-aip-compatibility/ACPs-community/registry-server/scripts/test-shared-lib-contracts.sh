#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=/dev/null
source "${BASE_DIR}/lib/shared-lib-contracts-lib.sh"

shared_lib_contracts_main "${BASE_DIR}" "$@"