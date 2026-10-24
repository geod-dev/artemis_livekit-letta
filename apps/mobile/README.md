# Artemis for your Android phone

A single native Android screen that loads the HTTPS site selected when the app is built.
No Expo, React Native, frontend copy, npm dependencies, or app-store deployment.
Website updates appear automatically. An internet connection is required.

The Gradle project is named `ArtemisMobile`; the Java package is `ai.artemis.mobile`.

## Install

Build the release app first, then install it. Run the build from this directory (`apps/mobile`):
on Windows PowerShell use `.\gradlew.bat`, on macOS and Linux use `./gradlew`. For example:
`.\gradlew.bat -PartemisMobileUrl=https://your-host assembleRelease`, or set `ARTEMIS_MOBILE_URL`
in the environment and leave the property out. The release APK is
`app/build/outputs/apk/release/app-release.apk`.

Then, from the repository root, run `.\scripts\install-android.ps1` (Windows only). It installs on
the one device attached over USB and stops if none, or more than one, is attached with USB debugging
approved. It installs `app-release.apk` when that file exists, else `app-debug.apk`. To install
another APK, pass its path as `-ApkPath path\to\app.apk`. The installer does not use a checked-in APK.

Or enable USB debugging, connect your phone, approve its USB debugging prompt, and run
`adb install -r app/build/outputs/apk/release/app-release.apk` from this directory.

## Build types

- `release` is the build to install day to day. It is not debuggable, so `adb run-as` cannot read
  the app's data, including its WebView session cookies.
- `debug` is debuggable, for development only. Any computer that the phone trusts for USB debugging
  can read a debug install's data. Build it with `assembleDebug`; it is `app/build/outputs/apk/debug/app-debug.apk`.

## Build again

The build needs the site URL at configuration time, so set it before opening the project.
Use the command line as the primary path, with Java 17 and Android SDK 36 installed. From this
directory, `.\gradlew.bat` (Windows) or `./gradlew` (POSIX) with `-PartemisMobileUrl=https://your-host`,
or export `ARTEMIS_MOBILE_URL` and omit the property. The build rejects a missing value and any URL
that is not an HTTPS origin.

To use Android Studio, export `ARTEMIS_MOBILE_URL` first, then open this directory and let it
install Android SDK 36. Without the value, Gradle sync fails with the message above.

Signing: when `.signing/debug.keystore` exists, both build types are signed with it, so keep that
file and install later builds as updates without uninstalling. No rebuild is needed for website
updates. The store password, key alias and key password must be set in `local.properties`
(`artemis.debugStorePassword`, `artemis.debugKeyAlias`, `artemis.debugKeyPassword`) or in the
environment (`ARTEMIS_DEBUG_STORE_PASSWORD`, `ARTEMIS_DEBUG_KEY_ALIAS`, `ARTEMIS_DEBUG_KEY_PASSWORD`).
There are no built-in defaults, and the build stops with a message when a value is missing.
Without the key file, both build types use Android's standard debug key, so a fresh checkout still
builds; that build cannot update an app signed with another key, so uninstall the existing app
first, which clears its local session.

Unit tests for the origin rules and the theme colour parser run on the JVM:
`./gradlew testDebugUnitTest` (Java 17). They need no device.

SDK 36 (Android 16) became the target and compile SDK on 2026-10-25. The WebView, microphone, and
voice paths on Android 16 still need a test on a real phone; that check is pending.

## Behavior and limits

- Microphone permission is only granted to the configured HTTPS origin.
- Android's back gesture navigates page history, then closes the app. The app registers its back
  callback on API 33 and later (`enableOnBackInvokedCallback`) and keeps `onBackPressed` for API 26-32.
- Content URLs are not readable from the WebView. Navigations off the configured origin, in the
  main frame or in an iframe, open in the browser; `about:` frames stay in the app.
- A download from off the site opens in the browser when it is a web, mail, or phone link. A
  download with any other scheme (for example `blob:` or `data:`) is refused with a message.
- A popup that only shows `about:` is closed after 10 seconds if its script never navigates it.
- File uploads use Android's file picker. Same-site previews and downloads retain
  the WebView session; external links open in the browser without sharing app
  cookies.
- The site occupies the space between system bars and above the keyboard.
- The page's theme colour reaches the native shell through a message listener
  (`window.ArtemisNative.postMessage`) that accepts messages from the configured origin only.
- Voice calls while the app is visible use the existing WebRTC frontend. This
  wrapper does not implement background calling, notifications, or offline mode.
- Voice, keyboard, uploads, and downloads must be checked on the actual phone.
