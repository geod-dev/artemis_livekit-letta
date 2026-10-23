param([string]$ApkPath)
$ErrorActionPreference = 'Stop'
if (!$ApkPath) {
    $ApkPath = Join-Path $PSScriptRoot '../mobile/app/build/outputs/apk/debug/app-debug.apk'
}
if (!(Test-Path -LiteralPath $ApkPath)) { throw 'Build the APK first; see mobile/README.md.' }
$apkPath = (Resolve-Path -LiteralPath $ApkPath).Path
$adbPath = $null
if ($env:ANDROID_HOME) { $adbPath = Join-Path $env:ANDROID_HOME 'platform-tools/adb.exe' }
if (!$adbPath -or !(Test-Path -LiteralPath $adbPath)) {
    $adbPath = (Get-Command adb -ErrorAction Stop).Source
}
& $adbPath install -r $apkPath
exit $LASTEXITCODE
