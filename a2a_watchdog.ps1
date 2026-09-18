# a2a_watchdog.ps1 - Ruochen A2A server + neighbor keepalive watchdog
# Runs every 15 min via scheduled task RuochenA2AWatchdog.
#
# Phase 1: self (3200). If down: start scheduled task, then fallback to bat.
# Phase 2: neighbor keepalive, two-tier recovery per neighbor:
#   Tier A - if health port down: docker exec to start the A2A server INSIDE
#            the running container (che/siyuan auto-start with container but
#            qiming/codewhale A2A is conversation-triggered, NOT container auto-start)
#   Tier B - if docker exec fails or container is gone: docker restart
#            (che/siyuan will come back with A2A; qiming/codewhale will not,
#             in that case exec again after restart)
# Exit codes: 0 = self healthy; 1 = self still down.
# Note: log strings use ASCII pinyin to avoid GBK/UTF8 encoding confusion on Windows PS 5.1.

$ErrorActionPreference = 'SilentlyContinue'
$BatPath = Join-Path $env:USERPROFILE 'WorkBuddy\Roundtable\csb-a2a-aip\start_a2a_server.bat'
$LogDir = Join-Path $env:USERPROFILE 'WorkBuddy\Roundtable\csb-a2a-aip\logs'
$LogPath = Join-Path $LogDir 'watchdog.log'

function Write-Log {
    param([string]$msg)
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
}

function Test-A2A {
    param([int]$Port)
    try {
        $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/health" -f $Port) -TimeoutSec 6 -UseBasicParsing
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

# LLM chain probe: /health stays green even when the LLM is unreachable, so we
# must actually send one message and check whether the reply is the degraded
# fallback template. Degraded replies contain U+FFFD replacement chars once
# decoded, so we test for the ASCII-stable marker "A2A v5" + absence of a real
# answer instead. Returns: ok | degraded | down.
# NOTE: keep this file pure ASCII. PS 5.1 reads .ps1 as GBK on this host and any
# non-ASCII literal will corrupt the parse (learned 2026-09-09).
function Test-LlmChain {
    try {
        $payload = @{
            jsonrpc = '2.0'; id = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            method  = 'message/send'
            params  = @{
                message = @{ role = 'user'; parts = @(@{ type = 'text'; text = 'ping' }) }
                sender  = @{ name = 'watchdog'; url = 'http://127.0.0.1:3200' }
            }
        } | ConvertTo-Json -Depth 8 -Compress

        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3200/a2a/json-rpc' -Method Post `
             -ContentType 'application/json; charset=utf-8' `
             -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 45 -UseBasicParsing
        if ($r.StatusCode -ne 200) { return 'down' }

        $j = $r.Content | ConvertFrom-Json
        $agentTurn = $j.result.task.history | Where-Object { $_.role -eq 'ROLE_AGENT' } | Select-Object -First 1
        $reply = $agentTurn.parts[0].text
        if (-not $reply) { return 'down' }

        # The fallback template always contains the literal "A2A v5" plus a
        # replacement char; a real LLM answer to "ping" never does.
        if ($reply -match 'A2A v5' -or $reply -match [char]0xFFFD) { return 'degraded' }
        return 'ok'
    } catch {
        return 'down'
    }
}

# ===== Phase 1: self recovery =====
if (-not (Test-A2A -Port 3200)) {
    Write-Log 'self: 3200 down -> attempting recovery'

    try { Start-ScheduledTask -TaskName 'RuochenA2AServer' | Out-Null } catch {}
    Start-Sleep -Seconds 15
    if (Test-A2A -Port 3200) { Write-Log 'self: recovered via scheduled task'; exit 0 }

    try { Start-Process -FilePath $BatPath -WindowStyle Hidden } catch {}
    Start-Sleep -Seconds 15
    if (Test-A2A -Port 3200) { Write-Log 'self: recovered via bat'; exit 0 }

    Write-Log 'self: 3200 STILL DOWN after both recovery attempts'
    exit 1
}

# ===== Phase 1b: LLM chain health (health endpoint cannot see this) =====
$llmState = Test-LlmChain
switch ($llmState) {
    'ok'       { Write-Log 'llm: chain OK' }
    'degraded' { Write-Log 'llm: DEGRADED - replying with fallback template, LLM endpoint unreachable' }
    default    { Write-Log 'llm: chain DOWN - no reply from /a2a/json-rpc' }
}

# ===== Phase 2: neighbor keepalive (two-tier) =====
# A2A start command inside container (empty = auto-starts with container, restart is enough)
$neighbors = @(
    @{ Alias='qiming';    Port=4099; Container='qiming';
       ExecCmd='cd /workspace && nohup bash /workspace/scripts/keeper.sh >/dev/null 2>&1 &' },
    @{ Alias='codewhale'; Port=4150; Container='codewhale-main-codewhale-1';
       ExecCmd='cd /workspace/csb-a2a-aip && nohup node server_v5.js >/dev/null 2>&1 &' },
    @{ Alias='che';       Port=4100; Container='che-docker';
       ExecCmd='' },  # a2a-server.js is a default container service, restart suffices
    @{ Alias='siyuan';    Port=3601; Container='siyuan';
       ExecCmd='' },  # start-full.sh launches server_v5.js automatically
    # 2026-09-05 added: openclaw gateway -plus containers (Jeason/Kai/Xiaoxia).
    #   host port -> container port: jeason 3902->3300, kai 3903->3100, xiaoxia 3904->3100.
    #   Startup mechanism unknown -> ExecCmd intentionally empty (no guessy exec).
    #   Restart of the gateway container is expected to bring A2A back.
    @{ Alias='jeason';    Port=3902; Container='openclaw-gateway-jeason-plus';
       ExecCmd='' },
    @{ Alias='kai';       Port=3903; Container='openclaw-gateway-kai-devops-plus';
       ExecCmd='' },
    @{ Alias='xiaoxia';   Port=3904; Container='openclaw-gateway-xiaoxia-plus';
       ExecCmd='' }
)

foreach ($n in $neighbors) {
    if (Test-A2A -Port $n.Port) { continue }

    # Tier A: container is up, try to start A2A inside it via exec
    $containerRunning = $false
    try {
        $state = docker inspect -f '{{.State.Running}}' $n.Container 2>$null
        if ($LASTEXITCODE -eq 0 -and "$state" -match 'true') { $containerRunning = $true }
    } catch {}

    if ($containerRunning -and $n.ExecCmd) {
        Write-Log ("neighbor: {0} port {1} down, container up -> docker exec start A2A" -f $n.Alias, $n.Port)
        try {
            docker exec -d $n.Container sh -c $n.ExecCmd | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Start-Sleep -Seconds 20
                if (Test-A2A -Port $n.Port) {
                    Write-Log ("neighbor: {0} recovered via docker exec" -f $n.Alias)
                    continue
                }
                Write-Log ("neighbor: {0} exec ran but port still down" -f $n.Alias)
            }
        } catch {
            Write-Log ("neighbor: {0} docker exec exception: {1}" -f $n.Alias, $_.Exception.Message)
        }
    }

    # Tier B: docker restart (also the path for containers that died entirely)
    Write-Log ("neighbor: {0} -> docker restart {1}" -f $n.Alias, $n.Container)
    try {
        $out = docker restart $n.Container 2>&1
        if ($LASTEXITCODE -eq 0) {
            Start-Sleep -Seconds 25
            if (Test-A2A -Port $n.Port) {
                Write-Log ("neighbor: {0} recovered via restart" -f $n.Alias)
                continue
            }
            # Container restarted but A2A did not auto-start (qiming/codewhale case)
            if ($n.ExecCmd) {
                Write-Log ("neighbor: {0} restarted, A2A not auto -> exec start again" -f $n.Alias)
                docker exec -d $n.Container sh -c $n.ExecCmd | Out-Null
                Start-Sleep -Seconds 20
                if (Test-A2A -Port $n.Port) {
                    Write-Log ("neighbor: {0} recovered via restart+exec" -f $n.Alias)
                } else {
                    Write-Log ("neighbor: {0} restart+exec STILL not healthy" -f $n.Alias)
                }
            } else {
                Write-Log ("neighbor: {0} restarted but still not healthy after 25s" -f $n.Alias)
            }
        } else {
            Write-Log ("neighbor: {0} docker restart failed: {1}" -f $n.Alias, ($out -join ' | '))
        }
    } catch {
        Write-Log ("neighbor: {0} docker restart exception: {1}" -f $n.Alias, $_.Exception.Message)
    }
}

exit 0