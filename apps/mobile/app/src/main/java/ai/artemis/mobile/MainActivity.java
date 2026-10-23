package ai.artemis.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.provider.MediaStore;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;

/** Native browser wrapper for the hosted site, with a small theme bridge. */
public final class MainActivity extends Activity {
    private static final int MICROPHONE = 1, FILE_PICKER = 2;
    private final Uri home = Uri.parse(BuildConfig.HOME_URL);
    private WebView webView;
    private FrameLayout frame;
    private PermissionRequest pendingMicrophone;
    private int pendingMicrophoneNavigation;
    private int navigation = 0;
    private ValueCallback<Uri[]> pendingFiles;
    private int pendingFilesNavigation;
    private AlertDialog networkDialog;
    private boolean resumed;
    private android.window.OnBackInvokedCallback backCallback;

    private boolean isArtemis(Uri uri) {
        return "https".equalsIgnoreCase(uri.getScheme())
            && home.getHost() != null && home.getHost().equalsIgnoreCase(uri.getHost())
            && effectivePort(home) == effectivePort(uri);
    }

    private static int effectivePort(Uri uri) {
        int port = uri.getPort();
        return port == -1 ? ("https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80) : port;
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        frame = new FrameLayout(this);
        frame.setBackgroundColor(Color.WHITE);
        webView = new WebView(this);
        frame.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(frame);
        configureWindow();
        configureWebView();
        if (state == null || webView.restoreState(state) == null) webView.loadUrl(home.toString());
        if (Build.VERSION.SDK_INT >= 33) {
            backCallback = this::navigateBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, backCallback);
        }
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
        webView.getSettings().setAllowContentAccess(true);
        webView.getSettings().setSupportMultipleWindows(true);
        webView.addJavascriptInterface(new ThemeBridge(frame), "ArtemisNative");
        CookieManager.getInstance().setAcceptCookie(true);
        webView.setWebViewClient(new SiteWebViewClient());
        webView.setWebChromeClient(new SiteWebChromeClient());
        webView.setDownloadListener((url, agent, disposition, type, length) -> download(url, agent, disposition, type));
    }

    private final class SiteWebViewClient extends WebViewClient {
        @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
            navigation++;
            cancelMicrophoneRequest();
            cancelFileRequest();
            if (networkDialog != null) {
                networkDialog.dismiss();
                networkDialog = null;
            }
        }

        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!request.isForMainFrame() || isArtemis(request.getUrl())) return false;
            openExternal(request.getUrl());
            return true;
        }

        @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame() || !resumed || isFinishing() || isDestroyed() || networkDialog != null) return;
            networkDialog = new AlertDialog.Builder(MainActivity.this)
                .setTitle("Cannot reach Artemis")
                .setMessage("Check your connection and try again.")
                .setPositiveButton("Retry", (dialog, which) -> webView.loadUrl(home.toString()))
                .setNegativeButton("Close", (dialog, which) -> finish())
                .setOnDismissListener(dialog -> networkDialog = null)
                .create();
            networkDialog.show();
        }
    }

    private final class SiteWebChromeClient extends WebChromeClient {
        @Override public void onPermissionRequest(PermissionRequest request) {
            // Grant only microphone access, and only to the configured HTTPS origin.
            if (!resumed || !isArtemis(request.getOrigin()) || !Arrays.asList(request.getResources())
                    .contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                request.deny();
                return;
            }
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                return;
            }
            cancelMicrophoneRequest();
            pendingMicrophone = request;
            pendingMicrophoneNavigation = navigation;
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, MICROPHONE);
        }

        @Override public void onPermissionRequestCanceled(PermissionRequest request) {
            if (pendingMicrophone == request) pendingMicrophone = null;
        }

        @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                FileChooserParams params) {
            cancelFileRequest();
            if (!resumed) {
                callback.onReceiveValue(null);
                return true;
            }
            pendingFiles = callback;
            pendingFilesNavigation = navigation;
            try {
                startActivityForResult(params.createIntent(), FILE_PICKER);
            } catch (ActivityNotFoundException error) {
                cancelFileRequest();
                Toast.makeText(MainActivity.this, "No file picker available", Toast.LENGTH_SHORT).show();
            }
            return true;
        }

        @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, Message result) {
            if (!gesture) return false;
            // The temporary view observes the target only. Same-site previews move
            // into the authenticated main WebView; external targets receive no app cookies.
            WebView popup = new WebView(MainActivity.this);
            popup.setWebViewClient(new WebViewClient() {
                private boolean handled;
                private void open(Uri target) {
                    if (handled || "about".equalsIgnoreCase(target.getScheme())) return;
                    handled = true;
                    if (isArtemis(target)) webView.loadUrl(target.toString());
                    else openExternal(target);
                    popup.post(popup::destroy);
                }
                @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                    open(r.getUrl());
                    return true;
                }
                @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) {
                    open(Uri.parse(url));
                }
            });
            ((WebView.WebViewTransport) result.obj).setWebView(popup);
            result.sendToTarget();
            return true;
        }
    }

    private void download(String url, String agent, String disposition, String type) {
        Uri uri = Uri.parse(url);
        if (!isArtemis(uri)) {
            openExternal(uri);
            return;
        }
        String filename = new File(URLUtil.guessFileName(url, disposition, type)).getName();
        if (filename.isEmpty()) filename = "download";
        String requestedName = filename;
        new Thread(() -> downloadSameOrigin(uri, requestedName, agent, type)).start();
    }

    private void downloadSameOrigin(Uri start, String filename, String agent, String type) {
        Uri current = start;
        HttpURLConnection connection = null;
        Uri mediaItem = null;
        File legacyFile = null;
        try {
            for (int redirects = 0; ; redirects++) {
                connection = (HttpURLConnection) new URL(current.toString()).openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(60000);
                if (agent != null) connection.setRequestProperty("User-Agent", agent);
                if (isArtemis(current)) {
                    String cookie = CookieManager.getInstance().getCookie(current.toString());
                    if (cookie != null && !cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
                }
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    connection.disconnect();
                    connection = null;
                    if (location == null || redirects >= 5) throw new IllegalStateException("Invalid download redirect");
                    Uri target = Uri.parse(new URL(new URL(current.toString()), location).toExternalForm());
                    if (!isArtemis(target)) {
                        runOnUiThread(() -> openExternal(target));
                        return;
                    }
                    current = target;
                    continue;
                }
                if (status < 200 || status >= 300) throw new IllegalStateException("Download failed");
                String mime = type != null ? type : connection.getContentType();
                OutputStream output;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                    values.put(MediaStore.Downloads.MIME_TYPE, mime != null ? mime : "application/octet-stream");
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    values.put(MediaStore.Downloads.IS_PENDING, 1);
                    mediaItem = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (mediaItem == null) throw new IllegalStateException("Could not create download");
                    output = getContentResolver().openOutputStream(mediaItem);
                    if (output == null) throw new IllegalStateException("Could not open download");
                } else {
                    File directory = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (directory == null) throw new IllegalStateException("Downloads are unavailable");
                    legacyFile = new File(directory, filename);
                    output = new FileOutputStream(legacyFile);
                }
                try (InputStream input = connection.getInputStream(); OutputStream destination = output) {
                    byte[] buffer = new byte[16384];
                    int count;
                    while ((count = input.read(buffer)) != -1) destination.write(buffer, 0, count);
                }
                if (mediaItem != null) {
                    ContentValues ready = new ContentValues();
                    ready.put(MediaStore.Downloads.IS_PENDING, 0);
                    getContentResolver().update(mediaItem, ready, null, null);
                }
                File savedFile = legacyFile;
                runOnUiThread(() -> Toast.makeText(this,
                    savedFile == null ? "Download saved" : "Saved in Artemis app downloads",
                    Toast.LENGTH_LONG).show());
                return;
            }
        } catch (Exception error) {
            if (mediaItem != null) getContentResolver().delete(mediaItem, null, null);
            if (legacyFile != null) legacyFile.delete();
            runOnUiThread(() -> Toast.makeText(this, "Could not download this file", Toast.LENGTH_SHORT).show());
        } finally {
            if (connection != null) connection.disconnect();
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
        private final FrameLayout target;
        ThemeBridge(FrameLayout target) { this.target = target; }

        @JavascriptInterface public void setSystemBarColor(String value) {
            if (value == null || !value.matches("#[0-9a-fA-F]{6}")) return;
            int color = Color.parseColor(value);
            runOnUiThread(() -> {
                target.setBackgroundColor(color);
                if (Build.VERSION.SDK_INT < 35) getWindow().setStatusBarColor(color);
                boolean lightBackground = Color.luminance(color) > 0.5f;
                if (Build.VERSION.SDK_INT >= 30) {
                    getWindow().getInsetsController().setSystemBarsAppearance(
                        lightBackground ? android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS : 0,
                        android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS);
                } else {
                    int flags = getWindow().getDecorView().getSystemUiVisibility();
                    flags = lightBackground ? flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                        : flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    getWindow().getDecorView().setSystemUiVisibility(flags);
                }
            });
        }
    }

    private void cancelMicrophoneRequest() {
        if (pendingMicrophone != null) pendingMicrophone.deny();
        pendingMicrophone = null;
    }

    private void cancelFileRequest() {
        if (pendingFiles != null) pendingFiles.onReceiveValue(null);
        pendingFiles = null;
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != MICROPHONE || pendingMicrophone == null) return;
        PermissionRequest request = pendingMicrophone;
        pendingMicrophone = null;
        if (pendingMicrophoneNavigation == navigation && resumed && webView != null
                && !isFinishing() && !isDestroyed()
                && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED
                && isArtemis(request.getOrigin())) {
            request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        } else request.deny();
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != FILE_PICKER || pendingFiles == null) return;
        ValueCallback<Uri[]> callback = pendingFiles;
        pendingFiles = null;
        if (pendingFilesNavigation == navigation && resumed && !isFinishing() && !isDestroyed()) {
            callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        } else callback.onReceiveValue(null);
    }

    private void navigateBack() {
        if (webView.canGoBack()) webView.goBack(); else finish();
    }
    @Override public void onBackPressed() { navigateBack(); }
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
        cancelMicrophoneRequest();
        cancelFileRequest();
        if (networkDialog != null) networkDialog.dismiss();
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        }
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
