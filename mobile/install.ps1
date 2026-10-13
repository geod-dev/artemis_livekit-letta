$ErrorActionPreference = 'Stop'
$apkPath = Join-Path $PSScriptRoot 'Artemis.apk'
if (!(Test-Path -LiteralPath $apkPath)) {
    $apkPath = Join-Path $PSScriptRoot 'app/build/outputs/apk/debug/app-debug.apk'
}
if (!(Test-Path -LiteralPath $apkPath)) { throw 'Build the APK first; see README.md.' }
$adbPath = Join-Path $PSScriptRoot '../.codex-tmp/android-tools/sdk/platform-tools/adb.exe'
if (!(Test-Path -LiteralPath $adbPath)) {
    $adbPath = (Get-Command adb -ErrorAction Stop).Source
}
& $adbPath install -r $apkPath
exit $LASTEXITCODE
