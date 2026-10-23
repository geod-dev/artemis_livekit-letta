package ai.artemis.mobile;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Message;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import java.util.Arrays;

/** Page permissions (microphone only), file uploads and popup windows. */
final class SiteWebChromeClient extends WebChromeClient {
    private final MainActivity activity;

    SiteWebChromeClient(MainActivity activity) {
        this.activity = activity;
    }

    @Override public void onPermissionRequest(PermissionRequest request) {
        // Grant only microphone access, and only to the configured HTTPS origin.
        if (!activity.resumed || !activity.site.contains(request.getOrigin())
                || !Arrays.asList(request.getResources())
                    .contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
            request.deny();
            return;
        }
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
            return;
        }
        activity.cancelMicrophoneRequest();
        activity.pendingMicrophone = request;
        activity.pendingMicrophoneNavigation = activity.navigation;
        activity.requestPermissions(
            new String[] { Manifest.permission.RECORD_AUDIO }, MainActivity.MICROPHONE);
    }

    @Override public void onPermissionRequestCanceled(PermissionRequest request) {
        if (activity.pendingMicrophone == request) activity.pendingMicrophone = null;
    }

    @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
            FileChooserParams params) {
        activity.cancelFileRequest();
        if (!activity.resumed) {
            callback.onReceiveValue(null);
            return true;
        }
        activity.pendingFiles = callback;
        activity.pendingFilesNavigation = activity.navigation;
        try {
            activity.startActivityForResult(params.createIntent(), MainActivity.FILE_PICKER);
        } catch (ActivityNotFoundException error) {
            activity.cancelFileRequest();
            Toast.makeText(activity, "No file picker available", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture,
            Message result) {
        if (!gesture) return false;
        // The temporary view observes the target only. Same-site previews move into the
        // authenticated main WebView; external targets receive no app cookies.
        WebView popup = new WebView(activity);
        popup.setWebViewClient(new WebViewClient() {
            private boolean handled;

            private void open(Uri target) {
                if (handled || "about".equalsIgnoreCase(target.getScheme())) return;
                handled = true;
                if (activity.site.contains(target)) {
                    activity.webView.loadUrl(target.toString());
                } else {
                    ArtemisSite.openExternal(activity, target);
                }
                popup.post(popup::destroy);
            }

            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                open(r.getUrl());
                return true;
            }

            @Override public void onPageStarted(WebView v, String url, Bitmap icon) {
                open(Uri.parse(url));
            }
        });
        ((WebView.WebViewTransport) result.obj).setWebView(popup);
        result.sendToTarget();
        return true;
    }
}
