package io.github.scad2stl;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLEngineResult;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Talks to a Bambu Lab printer over the local network, the way LAN-mode tools do:
 * files go to the SD card over implicit FTPS (port 990), commands over MQTT/TLS (port 8883),
 * both as user "bblp" with the printer's LAN access code. Uses only java.* / javax.* so it
 * can be exercised on a desktop JVM.
 *
 * The printer presents a certificate signed by Bambu's own CA, which Android does not know,
 * so the certificate is not verified; the access code is what authenticates the session.
 */
final class BambuLink {

    interface Progress {
        void onProgress(int percent);
    }

    /** A failure with a message meant for the user. */
    static final class LinkException extends IOException {
        private static final long serialVersionUID = 1L;
        final boolean retryable;

        LinkException(String message, boolean retryable) {
            super(message);
            this.retryable = retryable;
        }
    }

    static final int FTP_PORT = 990;
    static final int MQTT_PORT = 8883;
    static final int DISCOVERY_PORT = 2021;
    private static final String USER = "bblp";
    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int IO_TIMEOUT_MS = 30000;

    private final String host;
    private final String accessCode;
    private final int ftpPort;
    private final int mqttPort;
    private final SSLContext tls;

    BambuLink(String host, String accessCode) throws GeneralSecurityException {
        this(host, accessCode, FTP_PORT, MQTT_PORT);
    }

    BambuLink(String host, String accessCode, int ftpPort, int mqttPort) throws GeneralSecurityException {
        this.host = host;
        this.accessCode = accessCode;
        this.ftpPort = ftpPort;
        this.mqttPort = mqttPort;
        this.tls = newContext();
    }

    private static SSLContext newContext() throws GeneralSecurityException {
        TrustManager[] trustAll = {new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) {
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) {
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        }};
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, trustAll, new SecureRandom());
        return ctx;
    }

    /**
     * Opens a TLS connection. The socket is labelled with (host, labelPort) rather than the
     * port it really connects to: TLS stacks key their session cache on that label, which is
     * how the FTPS data connection gets to resume the control connection's session.
     */
    private SSLSocket open(SSLContext ctx, int port, int labelPort, boolean tls12Only) throws IOException {
        Socket plain = new Socket();
        try {
            plain.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
            plain.setSoTimeout(IO_TIMEOUT_MS);
            SSLSocket s = (SSLSocket) ctx.getSocketFactory().createSocket(plain, host, labelPort, true);
            s.setUseClientMode(true);
            if (tls12Only) {
                s.setEnabledProtocols(new String[]{"TLSv1.2"});
            }
            return s;
        } catch (IOException e) {
            closeQuietly(plain);
            throw e;
        }
    }

    // ------------------------------------------------------------------ serial number

    /** The printer's certificate carries its serial number as the subject's common name. */
    String fetchSerial() throws IOException {
        SSLSocket s = connectOrExplain(mqttPort);
        try {
            s.startHandshake();
            Certificate[] chain = s.getSession().getPeerCertificates();
            if (chain.length > 0 && chain[0] instanceof X509Certificate) {
                String dn = ((X509Certificate) chain[0]).getSubjectX500Principal().getName();
                Matcher m = Pattern.compile("(?:^|,)\\s*CN=([^,]+)").matcher(dn);
                if (m.find()) {
                    return m.group(1).trim();
                }
            }
            throw new LinkException("Could not read the serial number from the printer. Enter it by hand.", false);
        } finally {
            closeQuietly(s);
        }
    }

    private SSLSocket connectOrExplain(int port) throws IOException {
        try {
            return open(tls, port, port, false);
        } catch (IOException e) {
            throw new LinkException("Cannot reach the printer at " + host + " (port " + port
                    + "). Check the IP address and that the phone is on the same Wi-Fi.", false);
        }
    }

    // ------------------------------------------------------------------ FTPS upload

    /** Uploads a file to the root of the printer's SD card. */
    void upload(File file, String remoteName, Progress progress) throws IOException {
        try {
            uploadOnce(file, remoteName, progress, true);
        } catch (LinkException e) {
            if (!e.retryable) throw e;
            // Some firmware refuses a resumed TLS session on the data channel; others insist
            // on one. Try the other way before giving up.
            uploadOnce(file, remoteName, progress, false);
        }
    }

    /** Logs in over FTPS and leaves again; used by "Test connection". */
    void checkFtpLogin() throws IOException {
        SSLSocket control = connectOrExplain(ftpPort);
        try {
            FtpControl ftp = new FtpControl(control);
            ftp.login();
            ftp.quit();
        } finally {
            closeQuietly(control);
        }
    }

    private void uploadOnce(File file, String remoteName, Progress progress, boolean reuseSession)
            throws IOException {
        SSLSocket control;
        try {
            control = open(tls, ftpPort, ftpPort, reuseSession);
        } catch (IOException e) {
            throw new LinkException("Cannot reach the printer at " + host + " (port " + ftpPort
                    + "). Check the IP address and that the phone is on the same Wi-Fi.", false);
        }
        TlsWriter data = null;
        try {
            FtpControl ftp = new FtpControl(control);
            ftp.login();
            ftp.command("PBSZ 0", 200);
            ftp.command("PROT P", 200);
            ftp.command("TYPE I", 200);
            int dataPort = ftp.passivePort();

            try {
                data = new TlsWriter(dataPort, reuseSession);
                ftp.send("STOR " + remoteName);
                int code = ftp.read().code;
                if (code != 150 && code != 125) {
                    throw new LinkException("The printer refused the upload (FTP " + code
                            + "). Is an SD card inserted?", false);
                }
                data.handshake();
            } catch (SSLException e) {
                throw new LinkException("Secure upload channel failed: " + e.getMessage(), reuseSession);
            } catch (GeneralSecurityException e) {
                throw new LinkException("Secure upload channel failed: " + e.getMessage(), false);
            }

            long total = Math.max(1, file.length());
            long sent = 0;
            int lastPercent = -1;
            byte[] buf = new byte[32768];
            try (InputStream in = new FileInputStream(file)) {
                int n;
                while ((n = in.read(buf)) > 0) {
                    data.write(buf, 0, n);
                    sent += n;
                    int percent = (int) (sent * 100 / total);
                    if (percent != lastPercent && progress != null) {
                        lastPercent = percent;
                        progress.onProgress(percent);
                    }
                }
            }
            data.finish(); // sends TLS close_notify, which tells the printer the file is complete
            data = null;
            control.setSoTimeout(60000);
            int done = ftp.read().code;
            if (done != 226 && done != 250) {
                throw new LinkException("The printer did not confirm the upload (FTP " + done
                        + "). The SD card may be full.", reuseSession);
            }
            ftp.quit();
        } catch (LinkException e) {
            throw e;
        } catch (SSLException e) {
            throw new LinkException("Secure connection to the printer failed: " + e.getMessage(), reuseSession);
        } catch (IOException e) {
            throw new LinkException("Upload failed: " + describe(e), reuseSession);
        } finally {
            if (data != null) data.abort();
            closeQuietly(control);
        }
    }

    /**
     * Write-only TLS client for the FTPS data channel, built on SSLEngine so that the session
     * cache key can be chosen. Vsftpd-style servers only accept a data connection that resumes
     * the control connection's TLS session; SSLSocket keys its cache on the real port (the
     * data port), SSLEngine on the host and port it is told, so here it is told the control
     * port.
     */
    private final class TlsWriter {
        private final Socket socket;
        private final SSLEngine engine;
        private final InputStream in;
        private final OutputStream out;
        private final ByteBuffer netOut;
        private final ByteBuffer appIn;
        private ByteBuffer netIn;
        private final byte[] chunk = new byte[16384];

        TlsWriter(int port, boolean resumeControlSession) throws IOException, GeneralSecurityException {
            socket = new Socket();
            try {
                socket.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
                socket.setSoTimeout(IO_TIMEOUT_MS);
                if (resumeControlSession) {
                    engine = tls.createSSLEngine(host, ftpPort);
                    engine.setEnabledProtocols(new String[]{"TLSv1.2"});
                } else {
                    engine = newContext().createSSLEngine(); // fresh context: empty session cache
                }
                engine.setUseClientMode(true);
                in = socket.getInputStream();
                out = socket.getOutputStream();
                netOut = ByteBuffer.allocate(engine.getSession().getPacketBufferSize());
                appIn = ByteBuffer.allocate(engine.getSession().getApplicationBufferSize());
                netIn = ByteBuffer.allocate(engine.getSession().getPacketBufferSize());
                netIn.flip(); // empty, in read mode
            } catch (IOException | GeneralSecurityException | RuntimeException e) {
                closeQuietly(socket);
                throw e;
            }
        }

        void handshake() throws IOException {
            engine.beginHandshake();
            while (true) {
                SSLEngineResult.HandshakeStatus status = engine.getHandshakeStatus();
                switch (status) {
                    case NEED_WRAP:
                        wrap(ByteBuffer.allocate(0));
                        break;
                    case NEED_UNWRAP: {
                        appIn.clear();
                        SSLEngineResult r = engine.unwrap(netIn, appIn);
                        if (r.getStatus() == SSLEngineResult.Status.BUFFER_UNDERFLOW) {
                            readMore();
                        } else if (r.getStatus() == SSLEngineResult.Status.CLOSED) {
                            throw new SSLException("the printer closed the secure channel");
                        } else if (r.getStatus() == SSLEngineResult.Status.BUFFER_OVERFLOW) {
                            throw new SSLException("unexpected data during handshake");
                        }
                        break;
                    }
                    case NEED_TASK: {
                        Runnable task;
                        while ((task = engine.getDelegatedTask()) != null) task.run();
                        break;
                    }
                    default:
                        return; // FINISHED or NOT_HANDSHAKING
                }
            }
        }

        private void readMore() throws IOException {
            netIn.compact();
            if (!netIn.hasRemaining()) { // record larger than the buffer: grow it
                ByteBuffer bigger = ByteBuffer.allocate(netIn.capacity() * 2);
                netIn.flip();
                bigger.put(netIn);
                netIn = bigger;
            }
            int n = in.read(chunk, 0, Math.min(chunk.length, netIn.remaining()));
            if (n < 0) throw new SSLException("the printer closed the secure channel");
            netIn.put(chunk, 0, n);
            netIn.flip();
        }

        private void wrap(ByteBuffer src) throws IOException {
            do {
                netOut.clear();
                SSLEngineResult r = engine.wrap(src, netOut);
                if (r.getStatus() != SSLEngineResult.Status.OK && r.getStatus() != SSLEngineResult.Status.CLOSED) {
                    throw new SSLException("secure channel error: " + r.getStatus());
                }
                out.write(netOut.array(), 0, netOut.position());
                if (r.getStatus() == SSLEngineResult.Status.CLOSED) break;
            } while (src.hasRemaining());
            out.flush();
        }

        void write(byte[] data, int offset, int length) throws IOException {
            wrap(ByteBuffer.wrap(data, offset, length));
        }

        void finish() throws IOException {
            engine.closeOutbound();
            while (!engine.isOutboundDone()) {
                wrap(ByteBuffer.allocate(0));
            }
            socket.close();
        }

        void abort() {
            closeQuietly(socket);
        }
    }

    private static final class FtpReply {
        final int code;
        final String text;

        FtpReply(int code, String text) {
            this.code = code;
            this.text = text;
        }
    }

    private final class FtpControl {
        private final BufferedReader in;
        private final OutputStream out;

        FtpControl(SSLSocket socket) throws IOException {
            socket.startHandshake();
            in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.ISO_8859_1));
            out = socket.getOutputStream();
            FtpReply hello = read();
            if (hello.code != 220) {
                throw new LinkException("Unexpected greeting from the printer (FTP " + hello.code + ")", false);
            }
        }

        void send(String line) throws IOException {
            out.write((line + "\r\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
        }

        /** Reads one reply, following multi-line replies ("123-..." up to "123 ..."). */
        FtpReply read() throws IOException {
            String first = in.readLine();
            if (first == null) throw new EOFException("printer closed the connection");
            if (first.length() < 3) throw new IOException("bad FTP reply: " + first);
            String code = first.substring(0, 3);
            String line = first;
            while (line.length() > 3 && line.charAt(3) == '-' || !line.startsWith(code)) {
                line = in.readLine();
                if (line == null) throw new EOFException("printer closed the connection");
            }
            try {
                return new FtpReply(Integer.parseInt(code), line);
            } catch (NumberFormatException e) {
                throw new IOException("bad FTP reply: " + first);
            }
        }

        FtpReply command(String line, int expected) throws IOException {
            send(line);
            FtpReply r = read();
            if (r.code != expected) {
                throw new LinkException("The printer answered \"" + r.text + "\" to " + line.split(" ")[0], false);
            }
            return r;
        }

        void login() throws IOException {
            send("USER " + USER);
            FtpReply r = read();
            if (r.code == 331) {
                send("PASS " + accessCode);
                r = read();
            }
            if (r.code == 530 || r.code == 430) {
                throw new LinkException("The printer rejected the access code.", false);
            }
            if (r.code != 230) {
                throw new LinkException("Login failed: " + r.text, false);
            }
        }

        int passivePort() throws IOException {
            send("PASV");
            FtpReply r = read();
            if (r.code == 227) {
                Matcher m = Pattern.compile("(\\d+),(\\d+),(\\d+),(\\d+),(\\d+),(\\d+)").matcher(r.text);
                if (m.find()) {
                    return Integer.parseInt(m.group(5)) * 256 + Integer.parseInt(m.group(6));
                }
            }
            send("EPSV");
            r = read();
            Matcher m = Pattern.compile("\\|\\|\\|(\\d+)\\|").matcher(r.text);
            if (r.code == 229 && m.find()) {
                return Integer.parseInt(m.group(1));
            }
            throw new LinkException("The printer did not open a data channel: " + r.text, false);
        }

        void quit() {
            try {
                send("QUIT");
            } catch (IOException ignored) {
                // the transfer already succeeded
            }
        }
    }

    // ------------------------------------------------------------------ MQTT

    /** Result of {@link #publish}: what the printer reported back, if anything. */
    static final class Reply {
        /** "success", "fail", or null when the printer sent no direct answer in time. */
        final String result;
        final String reason;

        Reply(String result, String reason) {
            this.result = result;
            this.reason = reason;
        }
    }

    /** Connects and disconnects; throws if the access code is refused. */
    void checkMqttLogin() throws IOException {
        SSLSocket s = connectOrExplain(mqttPort);
        try {
            mqttConnect(s);
            s.getOutputStream().write(new byte[]{(byte) 0xE0, 0});
            s.getOutputStream().flush();
        } finally {
            closeQuietly(s);
        }
    }

    /**
     * Publishes a JSON command to device/{serial}/request and waits up to waitMs for the
     * printer's report about that command.
     */
    Reply publish(String serial, String json, String command, int waitMs) throws IOException {
        SSLSocket s = connectOrExplain(mqttPort);
        try {
            DataInputStream in = mqttConnect(s);
            OutputStream out = s.getOutputStream();

            ByteArrayOutputStream sub = new ByteArrayOutputStream();
            sub.write(0);
            sub.write(1); // packet id
            writeString(sub, "device/" + serial + "/report");
            sub.write(0); // QoS 0
            out.write(packet(0x82, sub.toByteArray()));

            ByteArrayOutputStream pub = new ByteArrayOutputStream();
            writeString(pub, "device/" + serial + "/request");
            byte[] payload = json.getBytes(StandardCharsets.UTF_8);
            pub.write(payload, 0, payload.length);
            out.write(packet(0x30, pub.toByteArray()));
            out.flush();

            Pattern ours = Pattern.compile("\"command\"\\s*:\\s*\"" + Pattern.quote(command) + "\"");
            long deadline = System.currentTimeMillis() + waitMs;
            Reply reply = new Reply(null, null);
            while (true) {
                long left = deadline - System.currentTimeMillis();
                if (left <= 0) break;
                s.setSoTimeout((int) Math.max(1, left));
                byte[] body;
                int header;
                try {
                    header = in.readUnsignedByte();
                    body = readBody(in);
                } catch (SocketTimeoutException e) {
                    break;
                } catch (EOFException e) {
                    // Printers drop the connection when a client publishes to a topic for a
                    // different serial number.
                    throw new LinkException("The printer closed the connection. Check the serial number.", false);
                }
                int type = header >> 4;
                if (type == 9 && body.length >= 3 && (body[2] & 0x80) != 0) {
                    throw new LinkException("The printer refused the subscription. Check the serial number.", false);
                }
                if (type != 3 || body.length < 2) continue;
                int topicLength = ((body[0] & 0xff) << 8) | (body[1] & 0xff);
                int start = 2 + topicLength + (((header >> 1) & 3) > 0 ? 2 : 0);
                if (start > body.length) continue;
                String text = new String(body, start, body.length - start, StandardCharsets.UTF_8);
                if (!ours.matcher(text).find()) continue;
                String result = field(text, "result");
                if (result != null) {
                    reply = new Reply(result.toLowerCase(), field(text, "reason"));
                    break;
                }
            }
            out.write(new byte[]{(byte) 0xE0, 0});
            out.flush();
            return reply;
        } catch (LinkException e) {
            throw e;
        } catch (IOException e) {
            throw new LinkException("Lost the connection to the printer: " + describe(e), false);
        } finally {
            closeQuietly(s);
        }
    }

    private DataInputStream mqttConnect(SSLSocket s) throws IOException {
        s.startHandshake();
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        writeString(body, "MQTT");
        body.write(4);    // protocol level 3.1.1
        body.write(0xC2); // user name + password + clean session
        body.write(0);
        body.write(60);   // keep-alive seconds
        writeString(body, "scad2stl-" + Long.toHexString(System.nanoTime()));
        writeString(body, USER);
        writeString(body, accessCode);
        OutputStream out = s.getOutputStream();
        out.write(packet(0x10, body.toByteArray()));
        out.flush();

        DataInputStream in = new DataInputStream(s.getInputStream());
        int header;
        byte[] ack;
        try {
            header = in.readUnsignedByte();
            ack = readBody(in);
        } catch (EOFException e) {
            throw new LinkException("The printer rejected the access code.", false);
        }
        if (header >> 4 != 2 || ack.length < 2) {
            throw new LinkException("Unexpected answer from the printer.", false);
        }
        if (ack[1] == 4 || ack[1] == 5) {
            throw new LinkException("The printer rejected the access code.", false);
        }
        if (ack[1] != 0) {
            throw new LinkException("The printer refused the connection (code " + ack[1] + ").", false);
        }
        return in;
    }

    private static byte[] readBody(DataInputStream in) throws IOException {
        int length = 0;
        int shift = 0;
        int b;
        do {
            b = in.readUnsignedByte();
            length |= (b & 0x7f) << shift;
            shift += 7;
        } while ((b & 0x80) != 0 && shift < 28);
        byte[] body = new byte[length];
        in.readFully(body);
        return body;
    }

    private static byte[] packet(int header, byte[] body) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(body.length + 5);
        out.write(header);
        int length = body.length;
        do {
            int digit = length % 128;
            length /= 128;
            out.write(length > 0 ? digit | 0x80 : digit);
        } while (length > 0);
        out.write(body, 0, body.length);
        return out.toByteArray();
    }

    private static void writeString(ByteArrayOutputStream out, String s) {
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        out.write(b.length >> 8);
        out.write(b.length & 0xff);
        out.write(b, 0, b.length);
    }

    private static String field(String json, String name) {
        Matcher m = Pattern.compile("\"" + name + "\"\\s*:\\s*\"([^\"]*)\"").matcher(json);
        return m.find() ? m.group(1) : null;
    }

    // ------------------------------------------------------------------ discovery

    /**
     * Listens for the announcements Bambu printers broadcast on UDP 2021.
     * Returns one entry per printer: {ip, serial, name, model}.
     */
    static List<String[]> discover(int listenMs) throws IOException {
        Map<String, String[]> found = new LinkedHashMap<>();
        DatagramSocket socket = new DatagramSocket(null);
        try {
            socket.setReuseAddress(true);
            socket.setBroadcast(true);
            socket.bind(new InetSocketAddress(DISCOVERY_PORT));
            byte[] buf = new byte[4096];
            long deadline = System.currentTimeMillis() + listenMs;
            while (true) {
                long left = deadline - System.currentTimeMillis();
                if (left <= 0) break;
                socket.setSoTimeout((int) Math.max(1, Math.min(left, 1000)));
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                try {
                    socket.receive(p);
                } catch (SocketTimeoutException e) {
                    continue;
                }
                String text = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8);
                if (!text.contains("bambulab")) continue;
                String serial = header(text, "USN");
                if (serial == null) continue;
                String ip = header(text, "Location");
                if (ip == null || !ip.matches("[0-9.]+")) ip = p.getAddress().getHostAddress();
                String name = header(text, "DevName.bambu.com");
                String model = header(text, "DevModel.bambu.com");
                found.put(serial, new String[]{ip, serial, name == null ? "" : name, model == null ? "" : model});
            }
        } finally {
            socket.close();
        }
        return new ArrayList<>(found.values());
    }

    private static String header(String text, String name) {
        Matcher m = Pattern.compile("(?im)^" + Pattern.quote(name) + ":\\s*(.+?)\\s*$").matcher(text);
        return m.find() ? m.group(1) : null;
    }

    // ------------------------------------------------------------------ helpers

    private static String describe(IOException e) {
        if (e instanceof SocketTimeoutException) return "the printer stopped answering";
        String m = e.getMessage();
        return m == null ? e.getClass().getSimpleName() : m;
    }

    private static void closeQuietly(Socket s) {
        if (s == null) return;
        try {
            s.close();
        } catch (IOException ignored) {
            // nothing useful to do
        }
    }
}
