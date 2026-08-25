#!/usr/bin/env bash

get_target_color() {
    local active="$1"

    if [[ "$active" == "blue" ]]; then
        echo "green"
    else
        echo "blue"
    fi
}
