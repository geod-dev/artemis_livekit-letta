package ai.artemis.mobile;

import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.view.View;
import android.view.WindowInsetsController;
import android.webkit.WebView;
import android.widget.FrameLayout;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Collections;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The page's theme bridge. The page calls window.ArtemisNative.postMessage with the JSON text
 * {"systemBarColor": "#rrggbb"}. The listener is registered for the Artemis origin only, so
 * other frames and origins cannot reach it.
 */
final class NativeBridge implements WebViewCompat.WebMessageListener {
    static final String NAME = "ArtemisNative";
    private static final String COLOR_PATTERN = "#[0-9a-fA-F]{6}";

    private final MainActivity activity;
    private final FrameLayout target;

    private NativeBridge(MainActivity activity, FrameLayout target) {
        this.activity = activity;
        this.target = target;
    }

    /** Registers the bridge on the WebView. A WebView without message listeners keeps working. */
    static void attach(MainActivity activity, WebView webView, FrameLayout target) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebViewCompat.addWebMessageListener(
            webView, NAME, Collections.singleton(activity.site.origin()),
            new NativeBridge(activity, target));
    }

    /** The system bar colour in a message, or null when the message is anything else. */
    static String systemBarColor(String raw) {
        if (raw == null) return null;
        try {
            Object value = new JSONObject(raw).opt("systemBarColor");
            if (!(value instanceof String)) return null;
            String color = (String) value;
            return color.matches(COLOR_PATTERN) ? color : null;
        } catch (JSONException error) {
            return null;
        }
    }

    @Override public void onPostMessage(WebView view, WebMessageCompat message, Uri sourceOrigin,
            boolean isMainFrame, JavaScriptReplyProxy replyProxy) {
        if (!activity.site.contains(sourceOrigin)) return;
        String color = systemBarColor(message.getData());
        if (color == null) return;
        int parsed = Color.parseColor(color);
        activity.runOnUiThread(() -> apply(parsed));
    }

    private void apply(int color) {
        target.setBackgroundColor(color);
        if (Build.VERSION.SDK_INT < 35) activity.getWindow().setStatusBarColor(color);
        boolean lightBackground = Color.luminance(color) > 0.5f;
        if (Build.VERSION.SDK_INT >= 30) {
            activity.getWindow().getInsetsController().setSystemBarsAppearance(
                lightBackground ? WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS : 0,
                WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS);
        } else {
            int flags = activity.getWindow().getDecorView().getSystemUiVisibility();
            flags = lightBackground ? flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                : flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            activity.getWindow().getDecorView().setSystemUiVisibility(flags);
        }
    }
}
