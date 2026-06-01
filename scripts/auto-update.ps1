$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogDir = Join-Path $env:LOCALAPPDATA "starclientv4-auto-update"
$LogFile = Join-Path $LogDir "auto-update.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-UpdateLog {
    param([string] $Message)

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LogFile -Value "[$timestamp] $Message"
}

try {
    Set-Location $RepoRoot

    $branch = (& git rev-parse --abbrev-ref HEAD).Trim()
    if ($branch -ne "main") {
        Write-UpdateLog "Skipped: current branch is '$branch', expected 'main'."
        exit 0
    }

    & git fetch --prune origin main *> $null

    $local = (& git rev-parse HEAD).Trim()
    $remote = (& git rev-parse origin/main).Trim()

    if ($local -eq $remote) {
        Write-UpdateLog "Already up to date at $local."
        exit 0
    }

    $status = (& git status --porcelain)
    if ($status) {
        Write-UpdateLog "Skipped: local changes exist. Commit, stash, or discard them before auto-update can pull."
        exit 0
    }

    & git pull --ff-only --recurse-submodules origin main *> $null
    & git submodule update --init --recursive *> $null

    $updated = (& git rev-parse HEAD).Trim()
    Write-UpdateLog "Updated from $local to $updated."
}
catch {
    Write-UpdateLog "Failed: $($_.Exception.Message)"
    exit 1
}
