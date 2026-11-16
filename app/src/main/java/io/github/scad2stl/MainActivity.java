package io.github.scad2stl;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;

/**
 * Thin shell around a WebView. The UI and the OpenSCAD engine (WebAssembly) live in
 * assets/www and are served from a private https origin, fully offline. Java only does
 * what the page cannot: showing Android's file pickers and writing the STL to disk.
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/index.html";
    private static final int REQ_SAVE = 1;
    private static final int REQ_OPEN = 2;
    private static final int MAX_SCAD_BYTES = 4 * 1024 * 1024;

    private WebView web;
    private File stlFile;          // rendered STL waiting to be saved
    private OutputStream stlOut;   // open while the page is sending chunks
    private String stlName = "model.stl";
    private boolean pageReady;     // true once index.html has loaded
    private Uri pendingOpen;       // .scad file handed to us before the page was ready

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        stlFile = new File(getCacheDir(), "render.stl");

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.setWebViewClient(new AssetClient());
        web.addJavascriptInterface(new Bridge(), "Android");
        setContentView(web);
        if (savedInstanceState == null) {
            pendingOpen = viewUri(getIntent());
        }
        web.loadUrl(START_URL);
    }

    /** Another app (file manager, browser, mail) asked us to open a file while we were running. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        Uri uri = viewUri(intent);
        if (uri == null) return;
        if (pageReady) {
            new Thread(() -> readScad(uri)).start();
        } else {
            pendingOpen = uri;
        }
    }

    private static Uri viewUri(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return null;
        return intent.getData();
    }

    @Override
    protected void onDestroy() {
        closeQuietly(stlOut);
        web.destroy();
        super.onDestroy();
    }

    // ---- Serving assets/www over https://appassets.androidplatform.net ----

    private class AssetClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (!HOST.equals(url.getHost())) {
                return error(403, "Blocked");
            }
            String path = url.getPath();
            if (path == null || path.isEmpty() || path.equals("/")) {
                path = "/index.html";
            }
            if (path.contains("..")) {
                return error(404, "Not Found");
            }
            try {
                InputStream in = getAssets().open("www" + path);
                String mime = mimeOf(path);
                boolean text = mime.startsWith("text/") || mime.endsWith("javascript");
                return new WebResourceResponse(mime, text ? "utf-8" : null, in);
            } catch (IOException e) {
                return error(404, "Not Found");
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pageReady = true;
            final Uri uri = pendingOpen;
            pendingOpen = null;
            if (uri != null) {
                new Thread(() -> readScad(uri)).start();
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return !HOST.equals(request.getUrl().getHost()); // never leave the bundled page
        }
    }

    private static WebResourceResponse error(int code, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason,
                new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }

    private static String mimeOf(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".wasm")) return "application/wasm";
        if (path.endsWith(".ttf")) return "font/ttf";
        return "application/octet-stream";
    }

    // ---- Methods the page calls as window.Android.* (on a background thread) ----

    private class Bridge {
        @JavascriptInterface
        public void stlBegin() {
            try {
                closeQuietly(stlOut);
                stlOut = new BufferedOutputStream(new FileOutputStream(stlFile));
            } catch (IOException e) {
                stlOut = null;
            }
        }

        @JavascriptInterface
        public void stlAppend(String base64) {
            if (stlOut == null) return;
            try {
                stlOut.write(Base64.decode(base64, Base64.DEFAULT));
            } catch (IOException | IllegalArgumentException e) {
                closeQuietly(stlOut);
                stlOut = null;
            }
        }

        @JavascriptInterface
        public void stlSave(String suggestedName) {
            if (stlOut == null) {
                callPage("failed", "Could not buffer the STL (storage full?)");
                return;
            }
            try {
                stlOut.close();
            } catch (IOException e) {
                callPage("failed", "Could not buffer the STL (storage full?)");
                return;
            } finally {
                stlOut = null;
            }
            stlName = suggestedName;
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("model/stl");
                i.putExtra(Intent.EXTRA_TITLE, suggestedName);
                startActivityForResult(i, REQ_SAVE);
            });
        }

        @JavascriptInterface
        public void openScad() {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*"); // .scad has no registered MIME type
                startActivityForResult(i, REQ_OPEN);
            });
        }
    }

    // ---- File picker results ----

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            return;
        }
        final Uri uri = data.getData();
        if (requestCode == REQ_SAVE) {
            new Thread(() -> writeStl(uri)).start();
        } else if (requestCode == REQ_OPEN) {
            new Thread(() -> readScad(uri)).start();
        }
    }

    private void writeStl(Uri uri) {
        try (InputStream in = new FileInputStream(stlFile);
             OutputStream out = getContentResolver().openOutputStream(uri)) {
            if (out == null) throw new IOException("cannot open destination");
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            out.flush();
            String name = displayName(uri);
            callPage("saved", true, name != null ? name : stlName);
        } catch (IOException | SecurityException e) {
            callPage("saved", false, String.valueOf(e.getMessage()));
        }
    }

    private void readScad(Uri uri) {
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) throw new IOException("cannot open file");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) {
                bytes.write(buf, 0, n);
                if (bytes.size() > MAX_SCAD_BYTES) throw new IOException("file is too large");
            }
            String name = displayName(uri);
            callPage("opened", name != null ? name : "model.scad",
                    new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        } catch (IOException | SecurityException e) {
            callPage("failed", "Open failed: " + e.getMessage());
        }
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(
                uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                return c.getString(0);
            }
        } catch (RuntimeException e) {
            // Provider does not report a name; fall back to the default.
        }
        return null;
    }

    /** Calls window.onNative.&lt;fn&gt;(args...) in the page. Strings are JSON-escaped. */
    private void callPage(String fn, Object... args) {
        StringBuilder js = new StringBuilder("window.onNative && window.onNative.").append(fn).append('(');
        for (int i = 0; i < args.length; i++) {
            if (i > 0) js.append(',');
            Object a = args[i];
            js.append(a instanceof String ? JSONObject.quote((String) a) : String.valueOf(a));
        }
        js.append(");");
        final String script = js.toString();
        runOnUiThread(() -> web.evaluateJavascript(script, null));
    }

    private static void closeQuietly(OutputStream out) {
        if (out == null) return;
        try {
            out.close();
        } catch (IOException ignored) {
            // nothing useful to do
        }
    }
}
