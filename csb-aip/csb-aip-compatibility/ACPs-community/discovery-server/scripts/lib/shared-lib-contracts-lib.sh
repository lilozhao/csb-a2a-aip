#!/usr/bin/env bash

run_expect_failure() {
    local description="$1"
    shift

    if "$@"; then
        err "${description}: 预期失败但实际成功"
        exit 1
    fi

    log "${description}: 已按预期失败"
}

shared_lib_contracts_main() {
    local base_dir="$1"

    # shellcheck source=/dev/null
    source "${base_dir}/lib/common.sh"
    # shellcheck source=/dev/null
    source "${base_dir}/lib/docker.sh"
    # shellcheck source=/dev/null
    source "${base_dir}/lib/build.sh"

    log "开始验证共享库显式参数契约"

    run_expect_failure "load_images 缺少参数" load_images
    run_expect_failure "wait_healthy 缺少 compose 文件参数" wait_healthy "demo"
    run_expect_failure "validate_required_files 缺少检查项" validate_required_files "$base_dir"
    run_expect_failure "copy_bundle_files 缺少映射" copy_bundle_files "$base_dir" "$base_dir"
    run_expect_failure "generate_checksums 缺少校验命令" generate_checksums "$base_dir"

    log "共享库契约验证通过"
}
