package io.github.scad2stl;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Talks to the PC helper (pc-helper/scad2stl_pc_helper.py), which hands a sliced project to
 * Bambu Connect on a computer in the same network. Plain HTTP on the LAN, guarded by the
 * pairing code the helper shows. Uses only java.* so it can be exercised on a desktop JVM.
 */
final class PcLink {

    static final int DEFAULT_PORT = 8765;
    private static final Pattern ADDRESS = Pattern.compile("([A-Za-z0-9.-]+)(?::(\\d{1,5}))?");

    private final String base;
    private final String code;

    PcLink(String address, String code) throws IOException {
        Matcher m = ADDRESS.matcher(address.trim());
        if (!m.matches()) {
            throw new BambuLink.LinkException("Enter the PC address the helper shows, for example 192.168.1.20.", false);
        }
        int port = m.group(2) == null ? DEFAULT_PORT : Integer.parseInt(m.group(2));
        this.base = "http://" + m.group(1) + ":" + port;
        this.code = code.trim();
    }

    /** Checks that the helper is reachable and the pairing code is right. */
    String ping() throws IOException {
        HttpURLConnection c = open("/ping");
        try {
            c.setRequestMethod("GET");
            return finish(c);
        } catch (BambuLink.LinkException e) {
            throw e;
        } catch (IOException e) {
            throw unreachable();
        } finally {
            c.disconnect();
        }
    }

    /**
     * Uploads a .gcode.3mf; the helper opens it in Bambu Connect and, when autoPrint is set,
     * presses Print and Send there. Returns the helper's message.
     */
    String send(File file, String name, boolean autoPrint, BambuLink.Progress progress) throws IOException {
        HttpURLConnection c = open("/print?name=" + URLEncoder.encode(name, "UTF-8") + (autoPrint ? "&auto=1" : ""));
        try {
            if (autoPrint) {
                c.setReadTimeout(240000); // Bambu Connect may need to start, import, then be clicked through
            }
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/octet-stream");
            c.setFixedLengthStreamingMode(file.length());
            long total = Math.max(1, file.length());
            long sent = 0;
            int last = -1;
            byte[] buf = new byte[32768];
            try (InputStream in = new FileInputStream(file); OutputStream out = c.getOutputStream()) {
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    sent += n;
                    int percent = (int) (sent * 100 / total);
                    if (percent != last && progress != null) {
                        last = percent;
                        progress.onProgress(percent);
                    }
                }
            }
            return finish(c);
        } catch (BambuLink.LinkException e) {
            throw e;
        } catch (IOException e) {
            throw unreachable();
        } finally {
            c.disconnect();
        }
    }

    private HttpURLConnection open(String path) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setConnectTimeout(6000);
        c.setReadTimeout(30000);
        c.setUseCaches(false);
        c.setRequestProperty("X-Code", code);
        return c;
    }

    private String finish(HttpURLConnection c) throws IOException {
        int status = c.getResponseCode();
        InputStream body = status >= 400 ? c.getErrorStream() : c.getInputStream();
        String text = body == null ? "" : readAll(body);
        Matcher m = Pattern.compile("\"message\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(text);
        String message = m.find() ? m.group(1).replace("\\\"", "\"").replace("\\\\", "\\") : "";
        if (status == 200) {
            return message.isEmpty() ? "Sent to the PC." : message;
        }
        throw new BambuLink.LinkException(
                message.isEmpty() ? "The PC helper answered with error " + status + "." : message, false);
    }

    private BambuLink.LinkException unreachable() {
        return new BambuLink.LinkException("Cannot reach the PC helper at " + base.substring(7)
                + ". Check that it is running, the address is right, the phone is on the same Wi-Fi, "
                + "and Windows Firewall allows Python on private networks.", false);
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream body = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = body.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
