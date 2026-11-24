package id.tonton.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

/**
 * Menyalakan server Tonton di Termux lewat intent RUN_COMMAND milik Termux. Syaratnya: Termux terpasang, aplikasi ini
 * diberi izin "Jalankan perintah di Termux", dan di Termux sudah dijalankan  tonton apk-setup  (allow-external-apps).
 */
final class TermuxLauncher {
    static final String PACKAGE = "com.termux";
    static final String PERMISSION = "com.termux.permission.RUN_COMMAND";
    private static final String PREFIX = "/data/data/com.termux/files/usr";
    private static final String HOME = "/data/data/com.termux/files/home";

    private TermuxLauncher() {}

    static boolean isInstalled(Context context) {
        try {
            context.getPackageManager().getPackageInfo(PACKAGE, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    static boolean hasPermission(Context context) {
        return Build.VERSION.SDK_INT < 23
                || context.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Menjalankan  tonton serve  di latar belakang Termux. False bila Android menolak mengirim intent-nya. True
     * hanya berarti intent terkirim: Termux bisa saja menolaknya (mis. allow-external-apps belum aktif), jadi
     * pemanggil tetap harus memeriksa apakah server benar-benar menyala.
     */
    static boolean startServer(Context context) {
        Intent intent = new Intent("com.termux.RUN_COMMAND");
        intent.setClassName(PACKAGE, "com.termux.app.RunCommandService");
        intent.putExtra("com.termux.RUN_COMMAND_PATH", PREFIX + "/bin/tonton");
        intent.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[] {"serve"});
        intent.putExtra("com.termux.RUN_COMMAND_WORKDIR", HOME);
        intent.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
            return true;
        } catch (RuntimeException e) {
            // SecurityException (izin belum ada), IllegalStateException (larangan layanan latar belakang), dll.
            return false;
        }
    }
}
