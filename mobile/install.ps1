param([string]$ApkPath)
$ErrorActionPreference = 'Stop'
if (!$ApkPath) {
    $ApkPath = Join-Path $PSScriptRoot 'app/build/outputs/apk/debug/app-debug.apk'
}
if (!(Test-Path -LiteralPath $ApkPath)) { throw 'Build the APK first; see README.md.' }
$apkPath = (Resolve-Path -LiteralPath $ApkPath).Path
$adbPath = Join-Path $PSScriptRoot '../.codex-tmp/android-tools/sdk/platform-tools/adb.exe'
if (!(Test-Path -LiteralPath $adbPath)) {
    $adbPath = (Get-Command adb -ErrorAction Stop).Source
}
& $adbPath install -r $apkPath
exit $LASTEXITCODE
