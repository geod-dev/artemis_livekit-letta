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

    /**
     * The HTTPS origin, for example https://artemis.example.com, used as the bridge's origin rule.
     * The default port is left out, the same way a page reports its own origin.
     */
    String origin() {
        return originOf(home.getHost(), effectivePort(home.getScheme(), home.getPort()));
    }

    /** True for the HTTPS origin the app was built for (same host and effective port). */
    boolean contains(Uri uri) {
        return uri != null && isSameSite(home.getHost(),
            effectivePort(home.getScheme(), home.getPort()),
            uri.getScheme(), uri.getHost(), uri.getPort());
    }

    /** The port an origin really uses: the explicit port, else the scheme's default (443 or 80). */
    static int effectivePort(String scheme, int port) {
        if (port != -1) return port;
        return "https".equalsIgnoreCase(scheme) ? 443 : 80;
    }

    /** An HTTPS origin text with the default port dropped: https://host or https://host:port. */
    static String originOf(String host, int port) {
        return port == 443 ? "https://" + host : "https://" + host + ":" + port;
    }

    /**
     * True when a URL with this scheme, host and port is on the HTTPS origin whose host and
     * effective port are given. Host comparison ignores case.
     */
    static boolean isSameSite(String homeHost, int homePort, String scheme, String host, int port) {
        return "https".equalsIgnoreCase(scheme)
            && homeHost != null && homeHost.equalsIgnoreCase(host)
            && homePort == effectivePort(scheme, port);
    }

    /**
     * Opens web, mail and phone links in another app. Returns false, and opens nothing, for any
     * other scheme (blob:, data:, and so on); the caller decides what the user sees then.
     */
    static boolean openExternal(Activity activity, Uri uri) {
        String scheme = uri.getScheme();
        if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)
                && !"mailto".equalsIgnoreCase(scheme) && !"tel".equalsIgnoreCase(scheme)) {
            return false;
        }
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(activity, "No app can open this link", Toast.LENGTH_SHORT).show();
        }
        return true;
    }
}
