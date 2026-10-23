# Installs an APK on the one Android device attached over USB. Windows PowerShell or PowerShell 7.
param([string]$ApkPath)
$ErrorActionPreference = 'Stop'
if (!$ApkPath) {
    $ApkPath = Join-Path $PSScriptRoot '../app/build/outputs/apk/debug/app-debug.apk'
}
if (!(Test-Path -LiteralPath $ApkPath)) { throw 'Build the APK first; see apps/mobile/README.md.' }
$apkPath = (Resolve-Path -LiteralPath $ApkPath).Path
$adbPath = $null
if ($env:ANDROID_HOME) { $adbPath = Join-Path $env:ANDROID_HOME 'platform-tools/adb.exe' }
if (!$adbPath -or !(Test-Path -LiteralPath $adbPath)) {
    $adbPath = (Get-Command adb -ErrorAction Stop).Source
}
# Only a device listed as "device" (USB debugging approved) counts; unauthorized or offline ones do not.
$attached = @(& $adbPath devices | Select-Object -Skip 1 | Where-Object { $_ -match "`tdevice$" })
if ($attached.Count -ne 1) {
    throw "Connect exactly one Android device with USB debugging approved (found $($attached.Count))."
}
& $adbPath install -r $apkPath
exit $LASTEXITCODE
