package ai.artemis.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.widget.Toast;

/** The configured Artemis origin, and the rules for what stays inside the app. */
final class ArtemisSite {
    private final Uri home;

    ArtemisSite(Uri home) {
        this.home = home;
    }

    /** The page the app loads first and retries after a network error. */
    Uri home() {
        return home;
    }

    /** The HTTPS origin, for example https://artemis.example.com, used as the bridge's origin rule. */
    String origin() {
        return "https://" + home.getAuthority();
    }

    /** True for the HTTPS origin the app was built for (same host and effective port). */
    boolean contains(Uri uri) {
        return uri != null
            && "https".equalsIgnoreCase(uri.getScheme())
            && home.getHost() != null && home.getHost().equalsIgnoreCase(uri.getHost())
            && effectivePort(home) == effectivePort(uri);
    }

    private static int effectivePort(Uri uri) {
        int port = uri.getPort();
        return port == -1 ? ("https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80) : port;
    }

    /** Opens web, mail and phone links in another app. Other schemes are ignored. */
    static void openExternal(Activity activity, Uri uri) {
        String scheme = uri.getScheme();
        if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)
                && !"mailto".equalsIgnoreCase(scheme) && !"tel".equalsIgnoreCase(scheme)) {
            return;
        }
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(activity, "No app can open this link", Toast.LENGTH_SHORT).show();
        }
    }
}
