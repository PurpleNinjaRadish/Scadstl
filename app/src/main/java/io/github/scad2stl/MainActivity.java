package io.github.scad2stl;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONException;
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
import java.security.GeneralSecurityException;
import java.util.HashMap;
import java.util.List;

/**
 * Thin shell around a WebView. The UI and the OpenSCAD engine (WebAssembly) live in
 * assets/www and are served from a private https origin. Java only does what the page
 * cannot: Android's file pickers, writing files, and talking to a printer on the local
 * network (see BambuLink).
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/index.html";
    private static final int REQ_SAVE = 1;
    private static final int REQ_OPEN = 2;
    private static final int MAX_SCAD_BYTES = 4 * 1024 * 1024;

    private WebView web;
    private File dataFile;         // bytes handed over by the page, waiting to be saved or sent
    private OutputStream dataOut;  // open while the page is sending chunks
    private String dataName = "model.stl";
    private boolean pageReady;     // true once index.html has loaded
    private Uri pendingOpen;       // .scad file handed to us before the page was ready

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        dataFile = new File(getCacheDir(), "buffer.bin");

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
        closeQuietly(dataOut);
        web.destroy();
        super.onDestroy();
    }

    // ---- Serving assets/www over https://appassets.androidplatform.net ----

    private class AssetClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String scheme = url.getScheme();
            if ("data".equals(scheme) || "blob".equals(scheme)) {
                return null; // in-page data (the slicer loads its WebAssembly this way)
            }
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
        public void dataBegin() {
            try {
                closeQuietly(dataOut);
                dataOut = new BufferedOutputStream(new FileOutputStream(dataFile));
            } catch (IOException e) {
                dataOut = null;
            }
        }

        @JavascriptInterface
        public void dataAppend(String base64) {
            if (dataOut == null) return;
            try {
                dataOut.write(Base64.decode(base64, Base64.DEFAULT));
            } catch (IOException | IllegalArgumentException e) {
                closeQuietly(dataOut);
                dataOut = null;
            }
        }

        @JavascriptInterface
        public void dataSave(String suggestedName, String mimeType) {
            if (!finishData()) {
                callPage("failed", "Could not buffer the file (storage full?)");
                return;
            }
            dataName = suggestedName;
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(mimeType);
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

        /** Uploads the buffered file to the printer and optionally starts it. */
        @JavascriptInterface
        public void printerSend(String json) {
            File outgoing = new File(getCacheDir(), "outgoing.bin");
            boolean buffered = finishData();
            outgoing.delete();
            if (!buffered || !dataFile.renameTo(outgoing)) {
                callPage("printer", "error", "Could not buffer the file (storage full?)");
                return;
            }
            new Thread(() -> sendToPrinter(json, outgoing)).start();
        }

        /** Sends the buffered project to the PC helper, which opens it in Bambu Connect. */
        @JavascriptInterface
        public void pcSend(String json) {
            File outgoing = new File(getCacheDir(), "outgoing-pc.bin");
            boolean buffered = finishData();
            outgoing.delete();
            if (!buffered || !dataFile.renameTo(outgoing)) {
                callPage("pc", "error", "Could not buffer the file (storage full?)");
                return;
            }
            new Thread(() -> sendToPc(json, outgoing)).start();
        }

        @JavascriptInterface
        public void pcTest(String json) {
            new Thread(() -> {
                try {
                    JSONObject cfg = new JSONObject(json);
                    callPage("pc", "done", new PcLink(cfg.getString("host"), cfg.getString("code")).ping());
                } catch (BambuLink.LinkException e) {
                    callPage("pc", "error", e.getMessage());
                } catch (IOException | JSONException | RuntimeException e) {
                    callPage("pc", "error", "Test failed: " + e);
                }
            }).start();
        }

        @JavascriptInterface
        public void printerTest(String json) {
            new Thread(() -> testPrinter(json)).start();
        }

        @JavascriptInterface
        public void printerFind() {
            new Thread(MainActivity.this::findPrinters).start();
        }
    }

    private boolean finishData() {
        if (dataOut == null) return false;
        try {
            dataOut.close();
            return true;
        } catch (IOException e) {
            return false;
        } finally {
            dataOut = null;
        }
    }

    // ---- Printer (runs on background threads) ----

    private void sendToPrinter(String json, File file) {
        try {
            JSONObject cfg = new JSONObject(json);
            String remoteName = cfg.getString("remoteName");
            String publish = cfg.optString("publish", "");
            BambuLink link = new BambuLink(cfg.getString("host"), cfg.getString("code"));

            String serial = cfg.optString("serial", "");
            if (serial.isEmpty() && !publish.isEmpty()) {
                serial = link.fetchSerial();
                callPage("printer", "serial", serial);
            }
            callPage("printer", "status", "Uploading\u2026");
            link.upload(file, remoteName, percent -> callPage("printer", "progress", percent));

            if (publish.isEmpty()) {
                callPage("printer", "done", "Uploaded " + remoteName + " to the printer's SD card.");
                return;
            }
            callPage("printer", "status", "Uploaded. Starting the print\u2026");
            BambuLink.Reply reply = link.publish(serial, publish, cfg.optString("command", ""), 8000);
            if ("success".equals(reply.result)) {
                callPage("printer", "done", "Print started.");
            } else if (reply.result != null) {
                String why = reply.reason == null || reply.reason.isEmpty() ? "" : " (" + reply.reason + ")";
                callPage("printer", "error", "The printer refused to start the print" + why + ". "
                        + remoteName + " is on its SD card, so you can start it from the printer's screen. "
                        + "Check that LAN-only mode and Developer Mode are both on.");
            } else {
                callPage("printer", "done", "Uploaded and start command sent, but the printer did not "
                        + "confirm. Check its screen; " + remoteName + " is on the SD card.");
            }
        } catch (BambuLink.LinkException e) {
            callPage("printer", "error", e.getMessage());
        } catch (IOException | GeneralSecurityException | JSONException | RuntimeException e) {
            callPage("printer", "error", "Sending failed: " + e);
        } finally {
            file.delete();
        }
    }

    private void sendToPc(String json, File file) {
        try {
            JSONObject cfg = new JSONObject(json);
            PcLink link = new PcLink(cfg.getString("host"), cfg.getString("code"));
            link.ping(); // fails fast, with a clear message, on a wrong address or pairing code
            String message = link.send(file, cfg.getString("name"),
                    percent -> callPage("pc", "progress", percent));
            callPage("pc", "done", message);
        } catch (BambuLink.LinkException e) {
            callPage("pc", "error", e.getMessage());
        } catch (IOException | JSONException | RuntimeException e) {
            callPage("pc", "error", "Sending failed: " + e);
        } finally {
            file.delete();
        }
    }

    private void testPrinter(String json) {
        try {
            JSONObject cfg = new JSONObject(json);
            BambuLink link = new BambuLink(cfg.getString("host"), cfg.getString("code"));
            String serial = link.fetchSerial();
            callPage("printer", "serial", serial);
            link.checkMqttLogin();
            link.checkFtpLogin();
            callPage("printer", "done", "Connected. Serial " + serial + ". Starting prints also needs "
                    + "LAN-only mode and Developer Mode on the printer.");
        } catch (BambuLink.LinkException e) {
            callPage("printer", "error", e.getMessage());
        } catch (IOException | GeneralSecurityException | JSONException | RuntimeException e) {
            callPage("printer", "error", "Test failed: " + e);
        }
    }

    private void findPrinters() {
        WifiManager.MulticastLock lock = null;
        try {
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                lock = wifi.createMulticastLock("scad2stl-discovery");
                lock.acquire(); // lets broadcast packets through while the screen is on battery
            }
            List<String[]> printers = BambuLink.discover(7000);
            for (String[] p : printers) {
                callPage("printer", "found", p[0], p[1], p[2], p[3]);
            }
            if (printers.isEmpty()) {
                callPage("printer", "error", "No printer answered. Enter its IP address from the "
                        + "printer's network screen.");
            } else {
                callPage("printer", "idle");
            }
        } catch (IOException | RuntimeException e) {
            callPage("printer", "error", "Search failed: " + e.getMessage());
        } finally {
            if (lock != null && lock.isHeld()) lock.release();
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
            new Thread(() -> writeData(uri)).start();
        } else if (requestCode == REQ_OPEN) {
            new Thread(() -> readScad(uri)).start();
        }
    }

    private void writeData(Uri uri) {
        try (InputStream in = new FileInputStream(dataFile);
             OutputStream out = getContentResolver().openOutputStream(uri)) {
            if (out == null) throw new IOException("cannot open destination");
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            out.flush();
            String name = displayName(uri);
            callPage("saved", true, name != null ? name : dataName);
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
