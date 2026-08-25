#!/usr/bin/env bash

STATE_DIR="${ZERO_DOWNTIME_STATE_DIR:-/tmp/zero-downtime-check}"
PID_FILE="${STATE_DIR}/runner.pid"
LOG_FILE="${STATE_DIR}/requests.log"
META_FILE="${STATE_DIR}/meta.env"

zero_downtime_usage() {
    cat <<'EOF'
用法:
    zero-downtime-check.sh start URL [DURATION_SECONDS] [INTERVAL_SECONDS]
  zero-downtime-check.sh stop
  zero-downtime-check.sh report
EOF
}

zero_downtime_ensure_state_dir() {
    mkdir -p "$STATE_DIR"
}

zero_downtime_is_running() {
    [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

zero_downtime_write_meta() {
    local url="$1"
    local duration="$2"
    local interval="$3"
    local started_at="$4"

    cat > "$META_FILE" <<EOF
URL=${url}
DURATION=${duration}
INTERVAL=${interval}
STARTED_AT=${started_at}
EOF
}

zero_downtime_start_runner() {
    local url="$1"
    local duration="$2"
    local interval="$3"
    local started_at now status timestamp

    zero_downtime_ensure_state_dir
    : > "$LOG_FILE"
    started_at="$(date +%s)"
    zero_downtime_write_meta "$url" "$duration" "$interval" "$started_at"

    (
        while true; do
            now="$(date +%s)"
            if (( now - started_at >= duration )); then
                break
            fi

            timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
            status="$(curl --silent --show-error --location --connect-timeout 1 --max-time 2 -o /dev/null -w "%{http_code}" "$url" || echo "000")"
            printf '%s\t%s\n' "$timestamp" "$status" >> "$LOG_FILE"
            sleep "$interval"
        done
    ) >/dev/null 2>&1 &

    echo "$!" > "$PID_FILE"
    echo "started pid=$(cat "$PID_FILE") url=${url} duration=${duration}s interval=${interval}s state_dir=${STATE_DIR}"
}

zero_downtime_stop_runner() {
    if zero_downtime_is_running; then
        kill "$(cat "$PID_FILE")"
        wait "$(cat "$PID_FILE")" 2>/dev/null || true
        echo "stopped pid=$(cat "$PID_FILE")"
    else
        echo "no active runner"
    fi

    rm -f "$PID_FILE"
}

zero_downtime_report_result() {
    local total success failure failure_rate running_state probe_interval="unknown"

    if [[ ! -f "$LOG_FILE" ]]; then
        echo "no request log found: ${LOG_FILE}"
        exit 1
    fi

    if [[ -f "$META_FILE" ]]; then
        probe_interval="$(awk -F '=' '/^INTERVAL=/{print $2}' "$META_FILE")"
    fi

    total="$(awk 'END {print NR+0}' "$LOG_FILE")"
    success="$(awk -F '\t' '$2 ~ /^2[0-9][0-9]$/ {count++} END {print count+0}' "$LOG_FILE")"
    failure="$(awk -F '\t' '$2 !~ /^2[0-9][0-9]$/ {count++} END {print count+0}' "$LOG_FILE")"

    if [[ "$total" -gt 0 ]]; then
        failure_rate="$(awk -v failure="$failure" -v total="$total" 'BEGIN {printf "%.2f", (failure / total) * 100}')"
    else
        failure_rate="0.00"
    fi

    if zero_downtime_is_running; then
        running_state="running"
    else
        running_state="stopped"
    fi

    echo "state_dir=${STATE_DIR}"
    echo "runner_state=${running_state}"
    echo "probe_interval_seconds=${probe_interval}"
    echo "total_requests=${total}"
    echo "success_requests=${success}"
    echo "failure_requests=${failure}"
    echo "failure_rate=${failure_rate}%"

    if [[ "$failure" -gt 0 ]]; then
        echo "failures:"
        awk -F '\t' '$2 !~ /^2[0-9][0-9]$/ {printf "  %s status=%s\n", $1, $2}' "$LOG_FILE"
        exit 1
    fi
}

zero_downtime_check_main() {
    local command="${1:-}"

    case "$command" in
        start)
            local url="${2:-}"
            local duration="${3:-60}"
            local interval="${4:-0.3}"
            if [[ -z "$url" ]]; then
                zero_downtime_usage
                exit 1
            fi
            if zero_downtime_is_running; then
                echo "runner already active pid=$(cat "$PID_FILE")"
                exit 1
            fi
            zero_downtime_start_runner "$url" "$duration" "$interval"
            ;;
        stop)
            zero_downtime_stop_runner
            ;;
        report)
            zero_downtime_report_result
            ;;
        *)
            zero_downtime_usage
            exit 1
            ;;
    esac
}