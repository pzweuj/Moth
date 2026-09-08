[CmdletBinding()]
param(
    [string]$EnvPath = ".env",
    [string]$BaseUrl
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Read-DotEnv {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Environment file not found: $Path. Copy .env.example to .env and add test credentials."
    }

    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path -Encoding utf8) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith("#")) {
            continue
        }

        $parts = $trimmed -split "=", 2
        if ($parts.Count -ne 2) {
            throw "Invalid .env line (expected KEY=VALUE): $trimmed"
        }

        $key = $parts[0].Trim()
        $value = $parts[1].Trim()
        if ($value.Length -ge 2) {
            $first = $value[0]
            $last = $value[$value.Length - 1]
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        $values[$key] = $value
    }

    return $values
}

$values = Read-DotEnv -Path $EnvPath
$username = [string]$values["MOTH_TEST_USERNAME"]
$password = [string]$values["MOTH_TEST_PASSWORD"]
if ([string]::IsNullOrWhiteSpace($username) -or [string]::IsNullOrWhiteSpace($password)) {
    throw "MOTH_TEST_USERNAME and MOTH_TEST_PASSWORD must be set in $EnvPath."
}
if ($password -eq "replace-with-at-least-10-characters" -or $password.Length -lt 10) {
    throw "MOTH_TEST_PASSWORD must contain at least 10 characters and must not use the example placeholder."
}

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    $BaseUrl = [string]$values["MOTH_BASE_URL"]
}
if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    $BaseUrl = "http://127.0.0.1:8080"
}
$BaseUrl = $BaseUrl.TrimEnd("/")

try {
    $health = Invoke-RestMethod -Uri "$BaseUrl/api/v1/health" -Method Get
} catch {
    throw "Moth is not reachable at $BaseUrl. Start the local server first."
}
if ($health.status -ne "ok") {
    throw "Moth health check did not return status=ok."
}

try {
    $setupStatus = Invoke-RestMethod -Uri "$BaseUrl/api/v1/setup/status" -Method Get
} catch {
    throw "Could not read Moth setup status at $BaseUrl."
}
if ($setupStatus.initialized) {
    throw "Moth is already initialized at $BaseUrl. Reset its local data directory before running setup again."
}

$requestBody = @{ username = $username; password = $password } | ConvertTo-Json -Compress
try {
    Invoke-RestMethod `
        -Uri "$BaseUrl/api/v1/setup" `
        -Method Post `
        -ContentType "application/json" `
        -Body $requestBody | Out-Null
} catch {
    throw "Moth setup failed at ${BaseUrl}: $($_.Exception.Message)"
}

Write-Output "Created the local Moth account '$username'."
