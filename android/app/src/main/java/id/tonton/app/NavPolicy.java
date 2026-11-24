package id.tonton.app;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** Aturan alamat mana yang boleh dimuat di dalam aplikasi dan mana yang boleh dibuka ke luar. Java murni. */
final class NavPolicy {
    private NavPolicy() {}

    /** True hanya untuk server Tonton di perangkat ini (http://127.0.0.1:PORT), tanpa nama pengguna di alamat. */
    static boolean isInternal(String url) {
        URI uri = parse(url);
        return uri != null
                && "http".equals(uri.getScheme())
                && Config.HOST.equals(uri.getHost())
                && uri.getPort() == Config.PORT
                && uri.getUserInfo() == null;
    }

    /**
     * Alamat yang boleh dibuka ke luar lewat jembatan JavaScript: hanya https ke YouTube. Jembatan terbuka untuk
     * semua frame di halaman (termasuk iframe pemutar), jadi daftar ini sengaja sempit.
     */
    static boolean isAllowedExternal(String url) {
        URI uri = parse(url);
        if (uri == null || !"https".equals(uri.getScheme()) || uri.getUserInfo() != null || uri.getHost() == null) {
            return false;
        }
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        return host.equals("www.youtube.com") || host.equals("m.youtube.com") || host.equals("youtube.com")
                || host.equals("youtu.be");
    }

    /** Alamat http(s) biasa: boleh diserahkan ke browser bila pengguna menavigasi keluar dari Tonton. */
    static boolean isWebUrl(String url) {
        URI uri = parse(url);
        return uri != null && uri.getHost() != null && ("http".equals(uri.getScheme()) || "https".equals(uri.getScheme()));
    }

    private static URI parse(String url) {
        if (url == null || url.isEmpty()) {
            return null;
        }
        try {
            return new URI(url);
        } catch (URISyntaxException e) {
            return null;
        }
    }
}
