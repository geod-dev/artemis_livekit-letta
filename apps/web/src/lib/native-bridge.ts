/**
 * The native shell's bridge, when the page runs inside the Android app's WebView
 * (`apps/mobile`). The shell registers `ArtemisNative` as a web message listener, so
 * the page posts JSON messages to it. In a browser the bridge is absent.
 */

/** A message from the page to the native shell. */
export type NativeMessage = { systemBarColor: string };

type NativeBridge = { postMessage: (message: string) => void };

/** Post a message to the native shell. A page without a shell, or a shell that does not accept the message, keeps working. */
export function postNativeMessage(message: NativeMessage): void {
  try {
    (window as Window & { ArtemisNative?: NativeBridge }).ArtemisNative?.postMessage(
      JSON.stringify(message)
    );
  } catch {
    // The page works without the native shell.
  }
}
