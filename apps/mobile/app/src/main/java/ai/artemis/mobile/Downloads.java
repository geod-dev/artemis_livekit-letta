package ai.artemis.mobile;

import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.widget.Toast;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Downloads from the Artemis origin, off the UI thread, into the Downloads folder. Other URLs
 * open in the browser. Shut down with the activity.
 */
final class Downloads {
    private static final int THREADS = 2;

    private final MainActivity activity;
    private final ExecutorService executor = Executors.newFixedThreadPool(THREADS);

    Downloads(MainActivity activity) {
        this.activity = activity;
    }

    /** Starts a download from a WebView download listener call. */
    void start(String url, String agent, String disposition, String type) {
        Uri uri = Uri.parse(url);
        if (!activity.site.contains(uri)) {
            ArtemisSite.openExternal(activity, uri);
            return;
        }
        String guessed = new File(URLUtil.guessFileName(url, disposition, type)).getName();
        String filename = guessed.isEmpty() ? "download" : guessed;
        executor.execute(() -> downloadSameOrigin(uri, filename, agent, type));
    }

    /** Stops accepting downloads. A transfer already running ends at its socket timeout. */
    void close() {
        executor.shutdownNow();
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
                if (activity.site.contains(current)) {
                    String cookie = CookieManager.getInstance().getCookie(current.toString());
                    if (cookie != null && !cookie.isEmpty()) {
                        connection.setRequestProperty("Cookie", cookie);
                    }
                }
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    connection.disconnect();
                    connection = null;
                    if (location == null || redirects >= 5) {
                        throw new IllegalStateException("Invalid download redirect");
                    }
                    Uri target = Uri.parse(new URL(new URL(current.toString()), location).toExternalForm());
                    if (!activity.site.contains(target)) {
                        activity.runOnUiThread(() -> ArtemisSite.openExternal(activity, target));
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
                    values.put(MediaStore.Downloads.MIME_TYPE,
                        mime != null ? mime : "application/octet-stream");
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    values.put(MediaStore.Downloads.IS_PENDING, 1);
                    mediaItem = activity.getContentResolver()
                        .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (mediaItem == null) throw new IllegalStateException("Could not create download");
                    output = activity.getContentResolver().openOutputStream(mediaItem);
                    if (output == null) throw new IllegalStateException("Could not open download");
                } else {
                    File directory = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (directory == null) throw new IllegalStateException("Downloads are unavailable");
                    legacyFile = new File(directory, filename);
                    output = new FileOutputStream(legacyFile);
                }
                try (InputStream input = connection.getInputStream();
                        OutputStream destination = output) {
                    byte[] buffer = new byte[16384];
                    int count;
                    while ((count = input.read(buffer)) != -1) destination.write(buffer, 0, count);
                }
                if (mediaItem != null) {
                    ContentValues ready = new ContentValues();
                    ready.put(MediaStore.Downloads.IS_PENDING, 0);
                    activity.getContentResolver().update(mediaItem, ready, null, null);
                }
                String message = legacyFile == null
                    ? "Download saved" : "Saved in Artemis app downloads";
                activity.runOnUiThread(() ->
                    Toast.makeText(activity, message, Toast.LENGTH_LONG).show());
                return;
            }
        } catch (Exception error) {
            if (mediaItem != null) activity.getContentResolver().delete(mediaItem, null, null);
            if (legacyFile != null) legacyFile.delete();
            activity.runOnUiThread(() ->
                Toast.makeText(activity, "Could not download this file", Toast.LENGTH_SHORT).show());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
