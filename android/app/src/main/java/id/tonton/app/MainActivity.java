package id.tonton.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * Pembungkus tipis: WebView layar penuh yang menampilkan Tonton dari server di Termux (127.0.0.1). Bila server belum
 * jalan, aplikasi ini mencoba menyalakannya lewat Termux dan menunggu sampai siap.
 */
public class MainActivity extends Activity {
    private static final int REQ_RUN_COMMAND = 1;
    private static final long START_TIMEOUT_MS = 90000L;
    private static final int BG = 0xFF101319;
    private static final int TEXT = 0xFFEEF0F5;
    private static final int MUTED = 0xFF98A0B3;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView web;
    private View statusPanel;
    private TextView titleView;
    private TextView bodyView;
    private ProgressBar spinner;
    private Button retryBtn;
    private Button termuxBtn;
    private Button grantBtn;
    private Button fdroidBtn;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;
    private volatile int generation = 0;   // setiap percobaan menyala punya nomor; hasil percobaan lama diabaikan
    private boolean askedPermission = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        setContentView(root);
        buildWebView();
        buildStatusPanel();
        startup();
    }

    // ------------------------------------------------------------------ WebView

    private void buildWebView() {
        web = new WebView(this);
        web.setBackgroundColor(BG);
        web.setVisibility(View.GONE);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                      // riwayat pencarian dan pilihan putar otomatis (localStorage)
        s.setMediaPlaybackRequiresUserGesture(false);      // pemutar YouTube memutar otomatis setelah dipilih
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);   // pemutar YouTube ada di iframe

        web.addJavascriptInterface(new Bridge(), "TontonAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) {
                    return false;
                }
                String url = request.getUrl().toString();
                if (NavPolicy.isInternal(url)) {
                    return false;
                }
                if (NavPolicy.isWebUrl(url)) {
                    openExternal(url);                     // keluar dari Tonton: buka di browser, jangan ganti halaman
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && web.getVisibility() == View.VISIBLE) {
                    web.setVisibility(View.GONE);
                    startup();                              // server mati (mis. Termux dihentikan): coba nyalakan lagi
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customCallback = callback;
                web.setVisibility(View.GONE);
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                applyFullscreen(true);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }
        });
        // Bila server memaksa unduhan lewat browser (Termux belum punya izin penyimpanan): serahkan ke browser HP.
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (NavPolicy.isInternal(url)) {
                openExternal(url);
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    /** Jembatan untuk halaman Tonton. Terbuka bagi semua frame, jadi hanya menerima alamat YouTube. */
    private final class Bridge {
        @JavascriptInterface
        public void openUrl(final String url) {
            if (NavPolicy.isAllowedExternal(url)) {
                ui.post(() -> openExternal(url));
            }
        }
    }

    private void exitFullscreen() {
        if (customView == null) {
            return;
        }
        root.removeView(customView);
        customView = null;
        if (customCallback != null) {
            customCallback.onCustomViewHidden();
            customCallback = null;
        }
        web.setVisibility(View.VISIBLE);
        applyFullscreen(false);
    }

    @SuppressWarnings("deprecation")
    private void applyFullscreen(boolean on) {
        int flags = on
                ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                : View.SYSTEM_UI_FLAG_VISIBLE;
        getWindow().getDecorView().setSystemUiVisibility(flags);
    }

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException ignored) {
            // tidak ada aplikasi yang bisa membukanya
        }
    }

    // ------------------------------------------------------------------ menyalakan dan menunggu server

    private void startup() {
        final int gen = ++generation;
        showStatus(R.string.connecting_title, R.string.connecting_body, true, false, false, false, false);
        new Thread(() -> {
            if (ServerProbe.isUp(Config.BASE_URL, 1200)) {
                ui.post(() -> showApp(gen));
                return;
            }
            if (!TermuxLauncher.isInstalled(this)) {
                ui.post(() -> showStatus(R.string.no_termux_title, R.string.no_termux_body, false, true, false, false, true));
                return;
            }
            if (!TermuxLauncher.hasPermission(this)) {
                ui.post(() -> needPermission(gen));
                return;
            }
            TermuxLauncher.startServer(this);
            ui.post(() -> showStatus(R.string.starting_title, R.string.starting_body, true, false, false, false, false));
            long deadline = SystemClock.elapsedRealtime() + START_TIMEOUT_MS;
            while (SystemClock.elapsedRealtime() < deadline && gen == generation) {
                if (ServerProbe.isUp(Config.BASE_URL, 1200)) {
                    ui.post(() -> showApp(gen));
                    return;
                }
                SystemClock.sleep(1000);
            }
            if (gen == generation) {
                ui.post(() -> showStatus(R.string.timeout_title, R.string.timeout_body, false, true, true, false, false));
            }
        }, "tonton-startup").start();
    }

    private void needPermission(int gen) {
        if (gen != generation) {
            return;
        }
        showStatus(R.string.permission_title, R.string.permission_body, false, true, true, true, false);
        if (!askedPermission) {
            askedPermission = true;
            requestTermuxPermission();
        }
    }

    private void requestTermuxPermission() {
        if (Build.VERSION.SDK_INT >= 23) {
            requestPermissions(new String[] {TermuxLauncher.PERMISSION}, REQ_RUN_COMMAND);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_RUN_COMMAND) {
            return;
        }
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startup();
        } else {
            showStatus(R.string.permission_title, R.string.permission_denied_body, false, true, true, true, false);
        }
    }

    private void showApp(int gen) {
        if (gen != generation) {
            return;
        }
        statusPanel.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(Config.BASE_URL);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web.getVisibility() != View.VISIBLE) {
            return;
        }
        final int gen = generation;
        new Thread(() -> {          // Termux mungkin menghentikan server saat aplikasi di latar belakang
            if (!ServerProbe.isUp(Config.BASE_URL, 1500) && gen == generation) {
                ui.post(() -> {
                    if (web.getVisibility() == View.VISIBLE) {
                        web.setVisibility(View.GONE);
                        startup();
                    }
                });
            }
        }, "tonton-alive").start();
    }

    // ------------------------------------------------------------------ tombol Kembali sistem

    @Override
    public void onBackPressed() {
        if (customView != null) {
            exitFullscreen();
            return;
        }
        if (web.getVisibility() != View.VISIBLE) {
            super.onBackPressed();
            return;
        }
        // Tonton punya tumpukan layar sendiri: tanyakan ke halamannya, keluar hanya bila sudah di beranda.
        web.evaluateJavascript("window.tontonBack ? window.tontonBack() : 'exit'", value -> {
            if (value == null || "null".equals(value) || value.contains("exit")) {
                finish();
            }
        });
    }

    @Override
    protected void onDestroy() {
        generation++;
        web.destroy();
        super.onDestroy();
    }

    // ------------------------------------------------------------------ layar status (tanpa file layout)

    private void buildStatusPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(28), dp(28), dp(28), dp(28));
        panel.setBackgroundColor(BG);

        spinner = new ProgressBar(this);
        titleView = text(20, TEXT, true);
        bodyView = text(15, MUTED, false);
        retryBtn = button(R.string.btn_retry, v -> startup());
        termuxBtn = button(R.string.btn_open_termux, v -> openTermux());
        grantBtn = button(R.string.btn_grant, v -> requestTermuxPermission());
        fdroidBtn = button(R.string.btn_fdroid, v -> openExternal("https://f-droid.org/packages/com.termux/"));

        panel.addView(spinner, params(0, 0, 0, 20));
        panel.addView(titleView, params(0, 0, 0, 10));
        panel.addView(bodyView, params(0, 0, 0, 24));
        for (Button b : new Button[] {retryBtn, grantBtn, termuxBtn, fdroidBtn}) {
            panel.addView(b, params(0, 4, 0, 4));
        }
        root.addView(panel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        statusPanel = panel;
    }

    private void showStatus(int title, int body, boolean spin, boolean retry, boolean termux, boolean grant, boolean fdroid) {
        statusPanel.setVisibility(View.VISIBLE);
        titleView.setText(title);
        bodyView.setText(body);
        spinner.setVisibility(spin ? View.VISIBLE : View.GONE);
        retryBtn.setVisibility(retry ? View.VISIBLE : View.GONE);
        termuxBtn.setVisibility(termux ? View.VISIBLE : View.GONE);
        grantBtn.setVisibility(grant ? View.VISIBLE : View.GONE);
        fdroidBtn.setVisibility(fdroid ? View.VISIBLE : View.GONE);
    }

    private void openTermux() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(TermuxLauncher.PACKAGE);
        if (launch != null) {
            startActivity(launch);
        }
    }

    private TextView text(int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setGravity(Gravity.CENTER);
        if (bold) {
            t.setTypeface(t.getTypeface(), android.graphics.Typeface.BOLD);
        }
        return t;
    }

    private Button button(int label, View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setOnClickListener(onClick);
        b.setVisibility(View.GONE);
        return b;
    }

    private LinearLayout.LayoutParams params(int left, int top, int right, int bottom) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(dp(left), dp(top), dp(right), dp(bottom));
        lp.gravity = Gravity.CENTER_HORIZONTAL;
        return lp;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
