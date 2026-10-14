package ai.artemis.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import java.util.Arrays;

/** Native browser wrapper for the hosted site, with a small theme bridge. */
public final class MainActivity extends Activity {
    private static final String HOME = "https://artemis.is-an.ai";
    private static final int MICROPHONE = 1, FILE_PICKER = 2;
    private WebView webView;
    private PermissionRequest pendingMicrophone;
    private ValueCallback<Uri[]> pendingFiles;

    private static boolean isArtemis(Uri uri) {
        return "https".equalsIgnoreCase(uri.getScheme())
            && "artemis.is-an.ai".equalsIgnoreCase(uri.getHost())
            && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(Color.WHITE);
        webView = new WebView(this);
        frame.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(frame);
        // Let WebView receive system and IME insets so visual viewport resizing keeps
        // text-input focus. The frame background remains visible behind transparent bars.
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        }
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(true);
        webView.getSettings().setSupportMultipleWindows(true);
        webView.addJavascriptInterface(new ThemeBridge(frame), "ArtemisNative");
        CookieManager.getInstance().setAcceptCookie(true);
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame() || isArtemis(request.getUrl())) return false;
                openExternal(request.getUrl());
                return true;
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame() || isFinishing()) return;
                new AlertDialog.Builder(MainActivity.this)
                    .setTitle("Cannot reach Artemis")
                    .setMessage("Check your connection and try again.")
                    .setPositiveButton("Retry", (dialog, which) -> webView.loadUrl(HOME))
                    .setNegativeButton("Close", (dialog, which) -> finish()).show();
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                // Grant only microphone access, and only to our HTTPS origin.
                if (!isArtemis(request.getOrigin()) || !Arrays.asList(request.getResources())
                        .contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                    request.deny();
                    return;
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                } else {
                    if (pendingMicrophone != null) pendingMicrophone.deny();
                    pendingMicrophone = request;
                    requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, MICROPHONE);
                }
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingMicrophone == request) pendingMicrophone = null;
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_PICKER);
                } catch (ActivityNotFoundException error) {
                    pendingFiles.onReceiveValue(null);
                    pendingFiles = null;
                    Toast.makeText(MainActivity.this, "No file picker available", Toast.LENGTH_SHORT).show();
                }
                return true;
            }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, Message result) {
                if (!gesture) return false;
                // Links opened in a new window (including file previews) use the browser.
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    private boolean handled;
                    private void open(String url) {
                        if (handled || "about:blank".equals(url)) return;
                        handled = true;
                        openExternal(Uri.parse(url));
                        popup.post(popup::destroy);
                    }
                    @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                        open(r.getUrl().toString());
                        return true;
                    }
                    @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) {
                        open(url);
                    }
                });
                ((WebView.WebViewTransport) result.obj).setWebView(popup);
                result.sendToTarget();
                return true;
            }
        });
        webView.setDownloadListener((url, agent, disposition, type, length) -> openExternal(Uri.parse(url)));
        if (state == null || webView.restoreState(state) == null) webView.loadUrl(HOME);
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, this::navigateBack);
        }
    }

    private void openExternal(Uri uri) {
        String scheme = uri.getScheme();
        if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)
                && !"mailto".equalsIgnoreCase(scheme) && !"tel".equalsIgnoreCase(scheme)) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
        catch (ActivityNotFoundException error) {
            Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show();
        }
    }

    private final class ThemeBridge {
        private final FrameLayout frame;

        ThemeBridge(FrameLayout frame) {
            this.frame = frame;
        }

        @JavascriptInterface
        public void setSystemBarColor(String value) {
            if (value == null || !value.matches("#[0-9a-fA-F]{6}")) return;
            int color = Color.parseColor(value);
            runOnUiThread(() -> {
                frame.setBackgroundColor(color);
                if (Build.VERSION.SDK_INT < 35) getWindow().setStatusBarColor(color);
                boolean lightBackground = Color.luminance(color) > 0.5f;
                if (Build.VERSION.SDK_INT >= 30) {
                    getWindow().getInsetsController().setSystemBarsAppearance(
                        lightBackground ? android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS : 0,
                        android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS);
                } else {
                    int flags = getWindow().getDecorView().getSystemUiVisibility();
                    flags = lightBackground
                        ? flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                        : flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    getWindow().getDecorView().setSystemUiVisibility(flags);
                }
            });
        }
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != MICROPHONE || pendingMicrophone == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            pendingMicrophone.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        } else pendingMicrophone.deny();
        pendingMicrophone = null;
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != FILE_PICKER || pendingFiles == null) return;
        pendingFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        pendingFiles = null;
    }

    private void navigateBack() {
        if (webView.canGoBack()) webView.goBack(); else finish();
    }
    @Override public void onBackPressed() { navigateBack(); }
    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        webView.saveState(state);
    }
    @Override protected void onPause() {
        webView.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }
    @Override protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }
    @Override protected void onDestroy() {
        if (pendingMicrophone != null) pendingMicrophone.deny();
        if (pendingFiles != null) pendingFiles.onReceiveValue(null);
        webView.destroy();
        super.onDestroy();
    }
}
