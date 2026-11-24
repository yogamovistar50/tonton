package id.tonton.app;

/** Alamat server Tonton yang dijalankan di Termux (perintah "tonton serve"; port bawaan 5000). */
final class Config {
    static final String HOST = "127.0.0.1";
    static final int PORT = 5000;
    static final String BASE_URL = "http://" + HOST + ":" + PORT + "/";

    private Config() {}
}
