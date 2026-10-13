# Artemis for your Android phone

A single native Android screen that loads **https://artemis.is-an.ai**.
No Expo, React Native, frontend copy, npm dependencies, or app-store deployment.
Website updates appear automatically. An internet connection is required.

## Install

Copy `Artemis.apk` to your phone, open it, and allow installation from that file
manager when Android asks. Open Artemis and grant microphone access when you
first start a voice call or recording. This is a locally signed personal-use APK.

Or enable USB debugging, connect your phone, approve its USB debugging prompt,
and run `adb install -r Artemis.apk` from this directory.
On this PC, from the repository root, `./mobile/install.ps1` uses the downloaded
ADB automatically. The phone must be connected and its debugging prompt approved.

## Build again

Open this directory as a project in Android Studio, let it install Android SDK 35,
then choose **Build > Generate App Bundles or APKs > Generate APKs** (wording varies).
Alternatively, with Java 17 and Android SDK 35 installed, run
`./gradlew assembleDebug`. The APK is `app/build/outputs/apk/debug/app-debug.apk`.
Preserve your local signing key (`.signing/debug.keystore`) to install subsequent
builds as updates without uninstalling. No rebuild is needed for website updates.
On a fresh checkout without that key, Android uses its standard debug key instead;
that build requires uninstalling the existing app first, clearing its local session.

## Behavior and limits

- Microphone permission is only granted to `https://artemis.is-an.ai`.
- Android's back gesture navigates page history, then closes the app.
- File uploads use Android's file picker. External links and new windows open in
  the browser. Downloads are handed to the browser; browser sessions are separate
  from the app, so authenticated downloads may require signing in there.
- The site occupies the space between system bars and above the keyboard.
- Voice calls while the app is visible use the existing WebRTC frontend. This
  wrapper does not implement background calling, notifications, or offline mode.
- Voice, keyboard, uploads, and downloads must be checked on the actual phone.
