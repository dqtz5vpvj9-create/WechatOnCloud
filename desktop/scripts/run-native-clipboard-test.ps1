$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$original = [System.Windows.Forms.Clipboard]::GetDataObject()
$backup = [System.Windows.Forms.DataObject]::new()
if ($null -ne $original) {
    foreach ($format in $original.GetFormats($false)) {
        $value = $original.GetData($format, $false)
        if ($null -eq $value) { throw 'Cannot preserve an existing clipboard format; test not started.' }
        $backup.SetData($format, $false, $value)
    }
}
$env:WOC_CLIPBOARD_NATIVE_TEST = '1'
$env:WOC_E2E_CDP_PORT = '9434'
$env:WOC_E2E_PROFILE = Join-Path (Resolve-Path -LiteralPath '.e2e').Path ('clipboard-profile-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
$env:WOC_DESKTOP_EXE = Join-Path (Resolve-Path -LiteralPath 'src-tauri/target/debug').Path 'yunwei.exe'
try {
    & npx.cmd e2e run tests/native-clipboard-image.e2e.ts --config e2e.config.ts
    $code = $LASTEXITCODE
} finally {
    if ($null -eq $original) { [System.Windows.Forms.Clipboard]::Clear() }
    else { [System.Windows.Forms.Clipboard]::SetDataObject($backup, $true) }
}
exit $code
