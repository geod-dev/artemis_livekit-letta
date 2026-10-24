package ai.artemis.mobile;

import android.app.AlertDialog;
import android.net.Uri;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;

/**
 * The answers the app still owes the page: a microphone request, a file chooser and the offline
 * dialog. Each permission or file answer is tied to the page load that asked for it, so an answer
 * that arrives after the page changed is dropped. MainActivity owns one instance.
 */
final class PendingRequests {
    /** Counts page starts. */
    private int navigation;
    private PermissionRequest microphone;
    private int microphoneNavigation;
    private ValueCallback<Uri[]> files;
    private int filesNavigation;
    private AlertDialog networkDialog;

    /** A page started loading: earlier requests and the offline dialog no longer apply. */
    void pageStarted() {
        navigation++;
        cancelMicrophone();
        cancelFiles();
        dismissNetworkDialog();
    }

    void holdMicrophone(PermissionRequest request) {
        cancelMicrophone();
        microphone = request;
        microphoneNavigation = navigation;
    }

    /** Forgets the held microphone request, when the page cancels it. */
    void releaseMicrophone(PermissionRequest request) {
        if (microphone == request) microphone = null;
    }

    /** Removes and returns the held microphone request, or null when there is none. */
    PermissionRequest takeMicrophone() {
        PermissionRequest request = microphone;
        microphone = null;
        return request;
    }

    /** True when the held microphone request was made by the page that is still loaded. */
    boolean microphoneIsCurrent() {
        return microphoneNavigation == navigation;
    }

    /** Denies the held microphone request, if any. */
    void cancelMicrophone() {
        if (microphone != null) microphone.deny();
        microphone = null;
    }

    void holdFiles(ValueCallback<Uri[]> callback) {
        cancelFiles();
        files = callback;
        filesNavigation = navigation;
    }

    /** Removes and returns the held file chooser callback, or null when there is none. */
    ValueCallback<Uri[]> takeFiles() {
        ValueCallback<Uri[]> callback = files;
        files = null;
        return callback;
    }

    /** True when the held file chooser was opened by the page that is still loaded. */
    boolean filesAreCurrent() {
        return filesNavigation == navigation;
    }

    /** Answers the held file chooser with no files, if any. */
    void cancelFiles() {
        if (files != null) files.onReceiveValue(null);
        files = null;
    }

    boolean hasNetworkDialog() {
        return networkDialog != null;
    }

    void showNetworkDialog(AlertDialog dialog) {
        networkDialog = dialog;
        dialog.show();
    }

    /** Clears the reference when the dialog goes away by itself. */
    void clearNetworkDialog() {
        networkDialog = null;
    }

    void dismissNetworkDialog() {
        if (networkDialog != null) networkDialog.dismiss();
        networkDialog = null;
    }
}
