#!/usr/bin/env bash

print_platform_options() {
    echo "=== 选择目标平台 ==="
    echo "  1) linux/amd64  Intel/AMD x86_64 (默认)"
    echo "  2) linux/arm64  ARM64 / Apple Silicon / Graviton"
    echo "  3) linux/arm/v7 ARM 32-bit"
    echo "  4) 自定义输入"
}

select_platform() {
    if [[ -n "${DOCKER_PLATFORM:-}" ]]; then
        echo "=== 目标平台 ==="
        echo "  使用环境变量: ${DOCKER_PLATFORM}"
        export DOCKER_PLATFORM
        return 0
    fi

    local choice

    print_platform_options
    read -r -p "请输入编号 [1]: " choice

    case "${choice:-1}" in
        1)
            DOCKER_PLATFORM="linux/amd64"
            ;;
        2)
            DOCKER_PLATFORM="linux/arm64"
            ;;
        3)
            DOCKER_PLATFORM="linux/arm/v7"
            ;;
        4)
            read -r -p "请输入自定义平台，例如 linux/amd64: " DOCKER_PLATFORM
            if [[ -z "${DOCKER_PLATFORM}" ]]; then
                echo "错误：自定义平台不能为空" >&2
                return 1
            fi
            ;;
        *)
            echo "错误：无效选项 ${choice}" >&2
            return 1
            ;;
    esac

    export DOCKER_PLATFORM
    echo "  已选择: ${DOCKER_PLATFORM}"
}