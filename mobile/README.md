# Artemis for your Android phone

A single native Android screen that loads the HTTPS site selected when the app is built.
No Expo, React Native, frontend copy, npm dependencies, or app-store deployment.
Website updates appear automatically. An internet connection is required.

## Install

Build the app first, then install the current debug build. From the repository
root, run `./mobile/gradlew -p mobile -PartemisUrl=https://your-host assembleDebug`
or set `ARTEMIS_URL` in the environment before running
`./mobile/gradlew -p mobile assembleDebug`. Then run `./mobile/install.ps1`.
To install a release artifact explicitly, pass its path as
`-ApkPath path\to\Artemis.apk`. The installer does not use a checked-in APK.

Or enable USB debugging, connect your phone, approve its USB debugging prompt,
and run `adb install -r app/build/outputs/apk/debug/app-debug.apk` from this
directory. The phone must be connected and its debugging prompt approved.

## Build again

Open this directory as a project in Android Studio, let it install Android SDK 35,
then choose **Build > Generate App Bundles or APKs > Generate APKs** (wording varies).
Alternatively, with Java 17 and Android SDK 35 installed, run
`./gradlew -PartemisUrl=https://your-host assembleDebug`, or export
`ARTEMIS_URL` before running `./gradlew assembleDebug`. The build rejects a
missing value and any URL that is not an HTTPS origin. The APK is
`app/build/outputs/apk/debug/app-debug.apk`.
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
- Voice calls while the app is visible use the existing WebRTC frontend. This
  wrapper does not implement background calling, notifications, or offline mode.
- Voice, keyboard, uploads, and downloads must be checked on the actual phone.
