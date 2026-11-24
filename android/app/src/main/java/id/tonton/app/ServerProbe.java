package id.tonton.app;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Memeriksa apakah Tonton sudah menjawab. Java murni (tanpa API Android) supaya bisa diuji di JVM. */
final class ServerProbe {
    private ServerProbe() {}

    /**
     * True bila {@code baseUrl + "api/health"} menjawab 200 dengan isi khas Tonton. Mengenali isinya penting:
     * port itu bisa saja dipakai layanan lain. Panggil dari thread latar belakang, bukan thread utama.
     */
    static boolean isUp(String baseUrl, int timeoutMs) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(baseUrl + "api/health").openConnection();
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setUseCaches(false);
            if (conn.getResponseCode() != 200) {
                return false;
            }
            InputStream in = conn.getInputStream();
            byte[] buf = new byte[512];
            int n = in.read(buf);
            return n > 0 && new String(buf, 0, n, "UTF-8").contains("\"ffmpeg\"");
        } catch (IOException e) {
            return false;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }
}
