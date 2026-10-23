# Artemis for your Android phone

A single native Android screen that loads the HTTPS site selected when the app is built.
No Expo, React Native, frontend copy, npm dependencies, or app-store deployment.
Website updates appear automatically. An internet connection is required.

The Gradle project is named `ArtemisMobile`; the Java package is `ai.artemis.mobile`.

## Install

Build the debug app first, then install it. From the repository root, run
`./apps/mobile/gradlew -p apps/mobile -PartemisMobileUrl=https://your-host assembleDebug`, or set
`ARTEMIS_MOBILE_URL` in the environment and run `./apps/mobile/gradlew -p apps/mobile assembleDebug`.
Then run `./apps/mobile/scripts/install-android.ps1` (Windows only). It installs on the one device
attached over USB and stops if none, or more than one, is attached with USB debugging approved.
To install another APK, pass its path as `-ApkPath path\to\app.apk`. The installer does not use a
checked-in APK.

Or enable USB debugging, connect your phone, approve its USB debugging prompt,
and run `adb install -r app/build/outputs/apk/debug/app-debug.apk` from this
directory. The phone must be connected and its debugging prompt approved.

## Build again

The build needs the site URL at configuration time, so set it before opening the project.
Use the command line as the primary path, with Java 17 and Android SDK 35 installed:
`./gradlew -PartemisMobileUrl=https://your-host assembleDebug`, or export `ARTEMIS_MOBILE_URL`
and run `./gradlew assembleDebug`. The build rejects a missing value and any URL that is not an
HTTPS origin. The APK is `app/build/outputs/apk/debug/app-debug.apk`.

To use Android Studio, export `ARTEMIS_MOBILE_URL` first, then open this directory and let it
install Android SDK 35. Without the value, Gradle sync fails with the message above.

Preserve your local signing key (`.signing/debug.keystore`) to install subsequent
builds as updates without uninstalling. No rebuild is needed for website updates.
On a fresh checkout without that key, Android uses its standard debug key instead;
that build requires uninstalling the existing app first, clearing its local session.

## Behavior and limits

- Microphone permission is only granted to the configured HTTPS origin.
- Android's back gesture navigates page history, then closes the app.
- File uploads use Android's file picker. Same-site previews and downloads retain
  the WebView session; external links open in the browser without sharing app
  cookies.
- The site occupies the space between system bars and above the keyboard.
- The page's theme colour reaches the native shell through a message listener
  (`window.ArtemisNative.postMessage`) that accepts messages from the configured origin only.
- Voice calls while the app is visible use the existing WebRTC frontend. This
  wrapper does not implement background calling, notifications, or offline mode.
- Voice, keyboard, uploads, and downloads must be checked on the actual phone.
