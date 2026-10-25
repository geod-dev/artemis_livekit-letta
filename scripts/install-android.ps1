# Installs the mobile APK on the one Android device attached over USB. Windows PowerShell or PowerShell 7.
# Installs app-release.apk when it exists, else app-debug.apk (see apps/mobile/README.md).
# Finds adb under ANDROID_HOME or ANDROID_SDK_ROOT, else on PATH. Writes nothing under apps/mobile.
param([string]$ApkPath)
$ErrorActionPreference = 'Stop'
$outputs = Join-Path $PSScriptRoot '../apps/mobile/app/build/outputs/apk'
if (!$ApkPath) {
    $release = Join-Path $outputs 'release/app-release.apk'
    $debug = Join-Path $outputs 'debug/app-debug.apk'
    $ApkPath = if (Test-Path -LiteralPath $release) { $release } else { $debug }
}
if (!(Test-Path -LiteralPath $ApkPath)) { throw 'Build the APK first; see apps/mobile/README.md.' }
$apkPath = (Resolve-Path -LiteralPath $ApkPath).Path

$adbPath = $null
foreach ($sdkRoot in @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT)) {
    if (!$sdkRoot) { continue }
    $candidate = Join-Path $sdkRoot 'platform-tools/adb.exe'
    if (Test-Path -LiteralPath $candidate) { $adbPath = $candidate; break }
}
if (!$adbPath) {
    $adbCommand = Get-Command adb -ErrorAction SilentlyContinue
    if (!$adbCommand) {
        throw 'adb not found. Set ANDROID_HOME or ANDROID_SDK_ROOT to the Android SDK folder, or put adb on PATH.'
    }
    $adbPath = $adbCommand.Source
}

# Only a device listed as "device" (USB debugging approved) counts; unauthorized or offline ones do not.
$attached = @(& $adbPath devices | Select-Object -Skip 1 | Where-Object { $_ -match "`tdevice$" })
if ($attached.Count -ne 1) {
    throw "Connect exactly one Android device with USB debugging approved (found $($attached.Count))."
}
& $adbPath install -r $apkPath
exit $LASTEXITCODE
