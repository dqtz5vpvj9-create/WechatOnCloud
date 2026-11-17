$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$result = Join-Path $root '.e2e/native-clipboard-result.json'
$log = Join-Path $root '.e2e/native-clipboard-run.log'
Set-Location -LiteralPath $root
Start-Transcript -LiteralPath $log | Out-Null
$code = 1
try {
    & powershell.exe -NoLogo -NoProfile -Sta -File (Join-Path $PSScriptRoot 'run-native-clipboard-test.ps1')
    $code = $LASTEXITCODE
} catch { Write-Output $_.Exception.Message }
finally {
    @{ exitCode = $code; completedAt = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $result -Encoding utf8
    Stop-Transcript | Out-Null
}
exit $code
