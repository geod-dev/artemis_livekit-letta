package ai.artemis.mobile;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.FrameLayout;
import androidx.annotation.RequiresApi;

/**
 * Native wrapper for the hosted site: one WebView, the site's navigation and permission rules,
 * and the theme bridge. The helpers live in their own classes and keep their pending answers in
 * PendingRequests; this one owns the lifecycle.
 */
public final class MainActivity extends Activity {
    static final int MICROPHONE = 1;
    static final int FILE_PICKER = 2;

    final ArtemisSite site = new ArtemisSite(Uri.parse(BuildConfig.HOME_URL));
    final PendingRequests pending = new PendingRequests();
    WebView webView;
    boolean resumed;

    private FrameLayout frame;
    private Downloads downloads;
    private android.window.OnBackInvokedCallback backCallback;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        frame = new FrameLayout(this);
        frame.setBackgroundColor(Color.WHITE);
        webView = new WebView(this);
        frame.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(frame);
        configureWindow();
        configureWebView();
        if (state == null || webView.restoreState(state) == null) {
            webView.loadUrl(site.home().toString());
        }
        if (Build.VERSION.SDK_INT >= 33) registerBackCallback();
    }

    private void configureWindow() {
        // Let WebView receive system and IME insets so its visual viewport resizes
        // with the keyboard. The frame color remains visible behind transparent bars.
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
    }

    private void configureWebView() {
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(false);
        webView.getSettings().setSupportMultipleWindows(true);
        CookieManager.getInstance().setAcceptCookie(true);
        downloads = new Downloads(this);
        NativeBridge.attach(this, webView, frame);
        webView.setWebViewClient(new SiteWebViewClient(this));
        webView.setWebChromeClient(new SiteWebChromeClient(this));
        webView.setDownloadListener(
            (url, agent, disposition, type) -> downloads.start(url, agent, disposition, type));
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != MICROPHONE) return;
        PermissionRequest request = pending.takeMicrophone();
        if (request == null) return;
        if (pending.microphoneIsCurrent() && resumed && webView != null
                && !isFinishing() && !isDestroyed()
                && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED
                && site.contains(request.getOrigin())) {
            request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        } else {
            request.deny();
        }
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != FILE_PICKER) return;
        ValueCallback<Uri[]> callback = pending.takeFiles();
        if (callback == null) return;
        if (pending.filesAreCurrent() && resumed && !isFinishing() && !isDestroyed()) {
            callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        } else {
            callback.onReceiveValue(null);
        }
    }

    private void navigateBack() {
        if (webView.canGoBack()) webView.goBack(); else finish();
    }

    @RequiresApi(33)
    private void registerBackCallback() {
        backCallback = this::navigateBack;
        getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, backCallback);
    }

    @RequiresApi(33)
    private void unregisterBackCallback() {
        getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
    }

    /** Back on API 26-32. From API 33 the registered callback handles back (the manifest enables it). */
    @Override public void onBackPressed() {
        navigateBack();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        if (webView != null) webView.saveState(state);
    }

    @Override protected void onPause() {
        resumed = false;
        if (webView != null) webView.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        if (webView != null) webView.onResume();
    }

    @Override protected void onDestroy() {
        pending.cancelMicrophone();
        pending.cancelFiles();
        pending.dismissNetworkDialog();
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) unregisterBackCallback();
        if (downloads != null) downloads.close();
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
