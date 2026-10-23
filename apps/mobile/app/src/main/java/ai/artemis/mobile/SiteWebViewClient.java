package ai.artemis.mobile;

import android.app.AlertDialog;
import android.graphics.Bitmap;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** Page lifecycle and navigation: what stays in the app, and the offline dialog. */
final class SiteWebViewClient extends WebViewClient {
    private final MainActivity activity;

    SiteWebViewClient(MainActivity activity) {
        this.activity = activity;
    }

    @Override public void onPageStarted(WebView view, String url, Bitmap icon) {
        activity.navigation++;
        activity.cancelMicrophoneRequest();
        activity.cancelFileRequest();
        if (activity.networkDialog != null) {
            activity.networkDialog.dismiss();
            activity.networkDialog = null;
        }
    }

    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (!request.isForMainFrame() || activity.site.contains(request.getUrl())) return false;
        ArtemisSite.openExternal(activity, request.getUrl());
        return true;
    }

    @Override public void onReceivedError(WebView view, WebResourceRequest request,
            WebResourceError error) {
        if (!request.isForMainFrame() || !activity.resumed || activity.isFinishing()
                || activity.isDestroyed() || activity.networkDialog != null) {
            return;
        }
        activity.networkDialog = new AlertDialog.Builder(activity)
            .setTitle("Cannot reach Artemis")
            .setMessage("Check your connection and try again.")
            .setPositiveButton("Retry",
                (dialog, which) -> activity.webView.loadUrl(activity.site.home().toString()))
            .setNegativeButton("Close", (dialog, which) -> activity.finish())
            .setOnDismissListener(dialog -> activity.networkDialog = null)
            .create();
        activity.networkDialog.show();
    }
}
