$ErrorActionPreference = "Continue"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogDir = Join-Path $env:LOCALAPPDATA "starclientv4-auto-update"
$LogFile = Join-Path $LogDir "auto-update.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-UpdateLog {
    param([string] $Message)

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LogFile -Value "[$timestamp] $Message"
}

function Invoke-Git {
    param(
        [string[]] $Arguments,
        [switch] $DiscardOutput
    )

    if ($DiscardOutput) {
        $output = & git @Arguments 2>$null
    }
    else {
        $output = & git @Arguments 2>$null
    }

    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }

    return $output
}

try {
    Set-Location $RepoRoot

    $branch = (Invoke-Git @("rev-parse", "--abbrev-ref", "HEAD")).Trim()
    if ($branch -ne "main") {
        Write-UpdateLog "Skipped: current branch is '$branch', expected 'main'."
        exit 0
    }

    Invoke-Git @("fetch", "--prune", "origin", "main") -DiscardOutput | Out-Null

    $local = (Invoke-Git @("rev-parse", "HEAD")).Trim()
    $remote = (Invoke-Git @("rev-parse", "origin/main")).Trim()

    if ($local -eq $remote) {
        Write-UpdateLog "Already up to date at $local."
        exit 0
    }

    $status = Invoke-Git @("status", "--porcelain")
    if ($status) {
        Write-UpdateLog "Skipped: local changes exist. Commit, stash, or discard them before auto-update can pull."
        exit 0
    }

    Invoke-Git @("pull", "--ff-only", "--recurse-submodules", "origin", "main") -DiscardOutput | Out-Null
    Invoke-Git @("submodule", "update", "--init", "--recursive") -DiscardOutput | Out-Null

    $updated = (Invoke-Git @("rev-parse", "HEAD")).Trim()
    Write-UpdateLog "Updated from $local to $updated."
}
catch {
    Write-UpdateLog "Failed: $($_.Exception.Message)"
    exit 1
}
