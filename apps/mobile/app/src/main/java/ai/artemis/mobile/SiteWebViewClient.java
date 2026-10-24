package ai.artemis.mobile;

import android.app.AlertDialog;
import android.graphics.Bitmap;
import android.net.Uri;
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
        activity.pending.pageStarted();
    }

    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        if (activity.site.contains(url)) return false;
        // Anything off the site leaves the app, in the main frame and in subframes. A blank
        // subframe (about:) stays in the WebView.
        if (!request.isForMainFrame() && "about".equalsIgnoreCase(url.getScheme())) return false;
        ArtemisSite.openExternal(activity, url);
        return true;
    }

    @Override public void onReceivedError(WebView view, WebResourceRequest request,
            WebResourceError error) {
        if (!request.isForMainFrame() || !activity.resumed || activity.isFinishing()
                || activity.isDestroyed() || activity.pending.hasNetworkDialog()) {
            return;
        }
        AlertDialog dialog = new AlertDialog.Builder(activity)
            .setTitle("Cannot reach Artemis")
            .setMessage("Check your connection and try again.")
            .setPositiveButton("Retry",
                (choice, which) -> activity.webView.loadUrl(activity.site.home().toString()))
            .setNegativeButton("Close", (choice, which) -> activity.finish())
            .setOnDismissListener(gone -> activity.pending.clearNetworkDialog())
            .create();
        activity.pending.showNetworkDialog(dialog);
    }
}
