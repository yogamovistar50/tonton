# Tonton

Aplikasi bergaya YouTube: cari video, lihat rekomendasi, tonton siaran langsung para creator, lalu unduh dalam format pilihanmu. Bisa dipakai sebagai **aplikasi desktop** (jendela sendiri, `Tonton.exe`), sebagai **situs lokal** di browser, atau **di Android** (lewat Termux, dengan aplikasi APK pembungkus bila mau).

| Jenis | Format | Pilihan kualitas |
|---|---|---|
| Video | MP4, WebM, MKV | Terbaik, 1080p, 720p, 480p, 360p |
| Audio | MP3, AAC, Opus | 128, 192, 256, 320 kbps |
| Audio | M4A, WAV, FLAC | Mengikuti sumber / lossless |

Backend memakai Flask dan [yt-dlp](https://github.com/yt-dlp/yt-dlp), konversi memakai FFmpeg. Pratinjau memakai pemutar embed resmi YouTube.

---

## A. Aplikasi desktop (Windows)

### Membangun Tonton.exe

1. Pasang **Python 3.9+** dari python.org. Centang **"Add python.exe to PATH"** saat instalasi.
2. Klik dua kali **`build_windows.bat`**.
   Skrip akan memasang dependensi, mengunduh FFmpeg otomatis, lalu membangun aplikasi. Butuh internet dan beberapa menit.
3. Hasilnya ada di folder `dist`:
   - `dist\Tonton\Tonton.exe` adalah aplikasinya. Buat shortcut ke desktop kalau mau.
   - `dist\Tonton-windows.zip` adalah arsip yang bisa dibagikan ke komputer lain.

Jangan pindahkan `Tonton.exe` sendirian. Seluruh folder `dist\Tonton` harus tetap utuh.

### Mencoba tanpa membangun .exe

Klik dua kali **`run_desktop.bat`**. Cara ini butuh FFmpeg: pasang lewat `winget install ffmpeg`, atau letakkan `ffmpeg.exe` dan `ffprobe.exe` di folder bernama `ffmpeg` di samping file ini.

### Cara kerja versi desktop

- Hasil unduhan langsung tersimpan di **`Downloads\Tonton`**. Setelah selesai, tombol **Tampilkan di folder** membuka Explorer dan menyorot filenya.
- Nama file dirapikan (kode video di akhir nama dibuang). Kalau namanya sudah ada, file baru diberi akhiran `(1)`, `(2)`, dan seterusnya, jadi tidak ada file lama yang tertimpa.
- Mau mengganti folder simpan? Atur variabel lingkungan `TONTON_SAVE_DIR`.

### Syarat dan masalah umum

- **Microsoft Edge WebView2 Runtime** harus ada. Windows 11 dan sebagian besar Windows 10 sudah punya. Kalau belum, Tonton menampilkan pesan dengan petunjuknya. Unduh dari microsoft.com/edge/webview2.
- **Windows SmartScreen atau antivirus** bisa memperingatkan saat pertama kali membuka `Tonton.exe`, karena aplikasinya tidak bertanda tangan digital. Ini umum untuk aplikasi buatan sendiri. Pilih "More info" lalu "Run anyway" kalau kamu percaya dengan sumbernya, yaitu build milikmu sendiri.
- **Catatan error** ada di `%LOCALAPPDATA%\Tonton\tonton.log`.
- **Pencarian atau unduhan mendadak gagal?** YouTube sering mengubah sistemnya dan yt-dlp ikut menyesuaikan. Karena yt-dlp ikut terbungkus di dalam `.exe`, **jalankan `build_windows.bat` lagi** untuk mendapatkan versi terbarunya.

---

## B. Mode browser

1. Pasang **Python 3.9+** dan **FFmpeg** (`winget install ffmpeg` di Windows, `brew install ffmpeg` di macOS, `sudo apt install ffmpeg` di Ubuntu/Debian).
2. `pip install -r requirements.txt`
3. `python app.py`, lalu buka http://127.0.0.1:5000

Di mode ini file dikirim lewat browser, jadi tersimpan di folder unduhan browser kamu. File sementara di server dihapus 30 menit setelah selesai.

| Variabel | Bawaan | Fungsi |
|---|---|---|
| `HOST` | `127.0.0.1` | Alamat yang didengarkan server |
| `PORT` | `5000` | Port server |

---

## C. Android (Termux)

Tonton berjalan langsung di HP lewat [Termux](https://termux.dev): Python, FFmpeg, dan yt-dlp lengkap, tanpa PC, dan dibuka di browser HP. Ini **bukan APK**: Termux harus dijalankan dulu setiap kali mau memakai Tonton.

### Memasang (sekali)

1. Pasang **Termux dari F-Droid** (f-droid.org/packages/com.termux). Jangan dari Play Store, versinya tidak dipelihara.
2. Simpan file zip Tonton ke folder **Download** di HP.
3. Buka Termux, lalu jalankan:
   ```
   pkg install -y unzip
   termux-setup-storage
   ```
   Tekan **Izinkan** pada jendela yang muncul. Lalu jalankan (sesuaikan nama file zip-nya):
   ```
   cd ~
   unzip -o ~/storage/downloads/tonton_v10.zip
   bash tonton/termux/install.sh
   ```
   Skrip memasang python, ffmpeg, dan nodejs, lalu yt-dlp dan Flask, dan membuat perintah `tonton`. Butuh internet dan beberapa menit. Aman dijalankan ulang.

Ekstrak zip-nya langsung di Termux. Kalau file skrip pernah dibuka dan disimpan ulang di Windows, akhir barisnya bisa berubah dan skrip gagal dijalankan.

### Menjalankan

Ketik `tonton` di Termux. Browser HP terbuka ke `http://127.0.0.1:5000`. Biarkan Termux tetap berjalan (boleh di latar belakang). Untuk berhenti, tekan **CTRL + C** di Termux.

Mau terbuka seperti aplikasi? Di Chrome, buka menu (tiga titik) lalu **Tambahkan ke layar utama** atau **Instal aplikasi**. Pintasannya membuka Tonton tanpa bilah alamat pada Chrome yang mendukungnya, tetapi `tonton` tetap harus dijalankan di Termux lebih dulu.

| Perintah | Fungsi |
|---|---|
| `tonton` | Jalankan Tonton lalu buka di browser |
| `tonton update` | Perbarui yt-dlp (lakukan bila YouTube mendadak gagal) |
| `PORT=5050 tonton` | Jalankan di port lain |
| `tonton help` | Tampilkan bantuan |

### Cara kerja versi Android

- Hasil unduhan langsung tersimpan di **Download/Tonton**. Setelah selesai, tombol **Buka file** membuka file dengan pemutar bawaan HP. Kalau izin penyimpanan belum diberikan, Tonton tetap jalan, dan file dikirim lewat browser (tersimpan di folder unduhan browser).
- Tombol atau gestur **Kembali** milik Android mundur satu layar di Tonton. Dari beranda barulah keluar.
- Selama Tonton berjalan, Termux menahan HP agar tidak tertidur (*wake lock*) supaya unduhan tidak terputus. Ini memakai baterai, dan dilepas saat Tonton dihentikan.
- Mau mengganti folder simpan? Atur `TONTON_SAVE_DIR` sebelum menjalankan, misalnya `TONTON_SAVE_DIR=~/storage/movies/Tonton tonton`.

### Masalah umum (Android)

- **Resolusi tinggi atau sebagian format tidak muncul.** yt-dlp terbaru butuh *JavaScript runtime* untuk YouTube. Pemasang sudah memasang `nodejs`. Periksa dengan `node --version` (perlu 22 atau lebih baru), lalu jalankan `tonton update`.
- **Pencarian atau unduhan mendadak gagal.** Jalankan `tonton update`.
- **Termux tertutup sendiri saat mengunduh.** Android 12 ke atas membatasi proses anak, dan FFmpeg berjalan sebagai proses anak. Pada sebagian versi Android ada pengaturan di Opsi Pengembang untuk menonaktifkan batasan itu.
- **Unduhan tersimpan di folder unduhan browser, bukan Download/Tonton.** Izin penyimpanan belum diberikan. Jalankan `termux-setup-storage`, izinkan, lalu jalankan `tonton` lagi.
- **Folder `tonton` dipindah.** Jalankan `bash tonton/termux/install.sh` lagi dari lokasi barunya.
- **Pesan "Address already in use".** Tonton sudah berjalan, atau port 5000 dipakai. Pakai `PORT=5050 tonton`.

## D. APK Android (pembungkus untuk Termux)

APK ini **pembungkus tipis**: WebView layar penuh yang menampilkan Tonton, lengkap dengan ikon di layar utama, tanpa bilah alamat browser, tombol Kembali Android, dan video layar penuh. Bila Tonton belum menyala, APK ini menyalakannya otomatis lewat Termux. **Mesin Tonton (Python, FFmpeg, yt-dlp) tetap berjalan di Termux**, jadi Termux dan bagian C tetap wajib. Ini bukan APK mandiri (alasannya di bawah).

### Mendapatkan APK-nya

File `.apk` dibangun di GitHub, jadi kamu tidak perlu memasang Android Studio. Gratis, dan sekitar 10 menit:

1. Buat akun di github.com (gratis), lalu buat repositori baru (boleh **Private**).
2. Di halaman repositori: **Add file**, **Upload files**. Seret **seluruh isi folder `tonton`**, termasuk folder `.github` dan `android`. Lalu **Commit changes**. (Batas unggah lewat browser: 100 file sekali unggah. Proyek ini jauh di bawahnya.)
3. Buka tab **Actions**, pilih **Bangun APK Tonton** di kiri, lalu **Run workflow**. Tunggu sampai ada tanda centang hijau (sekitar 5 sampai 10 menit).
4. Buka proses yang selesai itu, turun ke bagian **Artifacts**, unduh **Tonton-APK**, dan ekstrak. Di dalamnya ada `app-debug.apk`.

Kalau prosesnya gagal (tanda silang merah), buka proses itu, salin pesan error berwarna merah dari log, dan kirim ke pembuat. Ada juga artefak **laporan-build-gagal** untuk diagnosis.

Alternatif tanpa GitHub: pasang Android Studio, buka folder `android`, lalu **Build**, **Build APK(s)**.

### Memasang dan memakai

1. **Pasang Termux dan Tonton dulu** (bagian C). Pasang Termux sebelum APK ini.
2. Di Termux jalankan `tonton apk-setup`, lalu tutup dan buka lagi Termux. Perintah ini mengizinkan aplikasi lain yang kamu beri izin menyalakan Tonton.
3. Salin `app-debug.apk` ke HP dan buka. Izinkan "pasang dari sumber ini" bila diminta. Play Protect mungkin memperingatkan karena APK ini buatan sendiri dan tidak dari Play Store. Itu wajar.
4. Buka **Tonton**. Pertama kali, Android meminta izin **Jalankan perintah di Termux**. Pilih **Izinkan**. Tonton menyala sendiri dalam beberapa detik.

### Cara kerja dan batasan

- **Server tetap berjalan di Termux** setelah aplikasi ditutup, dan menahan HP agar tidak tertidur (*wake lock*), supaya unduhan tidak terputus. Hentikan dengan `tonton stop` di Termux. Kalau lupa, itu memakan baterai.
- **Port tetap 5000.** Jangan ubah `PORT` kalau memakai APK ini.
- **Keamanan.** `tonton apk-setup` mengizinkan aplikasi yang kamu beri izin "Jalankan perintah di Termux" menjalankan perintah di Termux. Beri izin itu **hanya** kepada Tonton. Di dalam APK, http polos hanya diizinkan ke `127.0.0.1`, dan jembatan JavaScript hanya menerima alamat https YouTube.
- **Ini APK debug.** Cukup untuk dipasang sendiri. Bukan untuk Play Store.
- **Kenapa bukan APK mandiri?** Itu butuh tiga komponen native sekaligus di dalam APK: Python, FFmpeg, dan runtime JavaScript untuk yt-dlp. Tidak ada yang bisa dibuktikan berfungsi tanpa perangkat Android sungguhan. Mesin yang sudah teruji tetap di Termux, dan APK ini bisa dipakai ulang bila kelak ada mesin mandiri.

### Masalah umum (APK)

- **Layar "Tonton belum menyala".** Buka Termux dan jalankan `tonton serve`, lalu tekan **Coba lagi**. Kalau penyalaan otomatis tidak pernah berhasil, ulangi `tonton apk-setup` lalu tutup dan buka lagi Termux. Pastikan izin "Jalankan perintah di Termux" diberikan (Info aplikasi, Izin).
- **Layar putih atau "tidak bisa dihubungi" setelah lama di latar belakang.** Android menghentikan Termux. APK mencoba menyalakannya lagi otomatis. Kalau gagal, jalankan `tonton serve` di Termux.
- **Tombol "Buka di YouTube"** membuka YouTube di aplikasi atau browser HP.

## Cara pakai

- **Rekomendasi di beranda**: bagian *Rekomendasi untukmu* menampilkan video dari tiga topik, yaitu pencarian terbarumu, diisi topik populer kalau riwayatmu masih sedikit. Keterangan di bawah judulnya menyebut topik yang dipakai. Scroll untuk memuat lebih banyak (sampai sekitar 120 video). Tombol **Segarkan** memilih topik lain dari riwayatmu. Shorts, channel, dan playlist tidak ditampilkan di sini.
- Ketik kata kunci di kolom cari, atau tempel tautan video langsung. Saat mengetik, muncul **saran pencarian** dari YouTube, digabung dengan **riwayat pencarianmu** (tombol × menghapus satu riwayat). Pakai tombol panah atas/bawah dan Enter, atau klik salah satu saran.
- Kalau yang dicari adalah nama orang, channel yang cocok muncul di atas hasil dan bisa langsung dibuka. Pencocokannya toleran salah ketik, misalnya "dedy cobruzier" tetap menemukan "Deddy Corbuzier". Daftar ini ditebak dari hasil pencarian, jadi hanya muncul kalau channelnya memang ada di hasil.
- **Masuk ke channel**: klik nama channel di bawah judul video mana pun (atau tombol **Buka channel** di halaman video). Di halaman channel ada foto profil, jumlah subscriber, deskripsi, dan tab **Video**, **Shorts**, **Live**, dan **Playlist**. Klik sebuah playlist untuk melihat isinya. Tombol **Kembali** selalu membawamu ke layar sebelumnya, lengkap dengan posisi scroll.
- Hasil dimuat bertahap, 24 video per halaman. Scroll ke bawah untuk memuat lebih banyak secara otomatis (atau tekan **Muat lebih banyak**), sampai maksimal sekitar 300 video per pencarian (halaman channel dan playlist sampai 2.000 video). Setelah membuka sebuah video, tombol **Kembali** membawamu ke posisi yang sama di daftar.
- **Siaran langsung**: video yang sedang tayang ditandai lencana merah **LIVE** beserta jumlah penontonnya, dan siaran yang dijadwalkan ditandai **Dijadwalkan** beserta waktu mulainya. Ada tiga cara menemukannya:
  - Di beranda, pilih salah satu topik di bagian **Sedang live sekarang**.
  - Di hasil pencarian apa pun, pilih **Sedang live** untuk menampilkan hanya siaran yang sedang tayang (**Semua** untuk kembali).
  - Buka channel creator. Kalau dia sedang tayang, muncul banner merah **LIVE** di bawah profilnya dan titik merah pada tab **Live**. Klik banner untuk langsung menonton.

  Di halaman siaran langsung, tombol **Tampilkan chat** membuka chat YouTube di panel kanan.
- **Lanjut ke video berikutnya**: di bawah pemutar ada kartu **Berikutnya**. Saat video selesai, muncul hitung mundur 5 detik, lalu Tonton memutar video itu otomatis. Tekan **Putar sekarang** untuk langsung pindah, atau **Batal** untuk tetap di video ini. Sakelar **Putar otomatis** mematikan hitung mundur (pilihannya diingat), dan kartu **Berikutnya** tetap bisa diklik manual.
  - Yang diputar berikutnya adalah video sesudahnya di daftar tempat kamu membuka video itu: rekomendasi beranda, hasil pencarian, channel, atau playlist. Kalau daftarnya habis, atau videonya dibuka dari tautan, Tonton lanjut ke rekomendasi beranda.
  - Siaran yang belum dimulai dilewati, dan Shorts hanya diputar berurutan dengan Shorts lain.
  - Tombol **Kembali** tetap membawamu ke daftar asal, bukan memutar ulang video sebelumnya.
- Klik video, lalu di panel kanan pilih **Video** atau **Audio**, format, dan kualitas.
- **Potong durasi**: sebelum mengunduh, centang **Potong durasi** lalu isi **Mulai** dan **Selesai** (mis. `1:30` dan `2:45`, atau `1:02:03`, atau detik saja). Kolom kosong berarti dari awal atau sampai akhir video. Ringkasan di bawahnya menunjukkan lama hasil potongan, dan bilah kuning menandai bagian yang dipilih. Hanya bagian itu yang diunduh, bukan seluruh video. Berlaku untuk semua format video maupun audio.
  - Nama file hasil memuat keterangan potongan, misalnya `Judul (potongan 1m30s-2m45s).mp4`.
- Tekan **Unduh**. Tombol **Unduhan** di pojok kanan atas menampilkan semua unduhan sesi ini.

## Catatan penting

- **Hak cipta dan ketentuan layanan.** Mengunduh dari YouTube melanggar Ketentuan Layanan YouTube, kecuali ada tombol unduh resmi. Gunakan hanya untuk konten milikmu, berlisensi terbuka (misalnya Creative Commons), atau yang pemiliknya mengizinkan. Tanggung jawab penggunaan ada pada pengguna.
- **Mode browser: jangan buka ke internet publik.** Tidak ada login, dan server menerima tautan apa pun dari pengunjung. Biarkan `HOST` tetap `127.0.0.1`.
- **YouTube butuh JavaScript runtime.** yt-dlp terbaru memakai Deno, Node.js, Bun, atau QuickJS untuk menyelesaikan tantangan YouTube. Tanpanya, sebagian format (misalnya resolusi tinggi) bisa hilang. Tonton mengaktifkan semuanya, dan yang tidak terpasang dilewati. Kalau hasil di komputer kamu kekurangan format, pasang salah satunya (misalnya Node.js 22 atau lebih baru) dan pastikan ada di PATH.
- **Rekomendasi bukan beranda pribadi YouTube.** Tonton tidak masuk ke akun YouTube, jadi rekomendasinya disusun dari hasil pencarian untuk topik-topik tadi. Riwayat pencarianmu tersimpan hanya di komputer ini. Topiknya dipakai sebagai kata kunci pencarian ke YouTube, sama seperti saat kamu mencari sendiri. Topik yang tidak mau dipakai bisa dihapus lewat tombol × pada saran pencarian. Hasilnya disimpan sementara 15 menit supaya beranda cepat dibuka, jadi **Segarkan** dengan topik yang sama bisa menampilkan video yang sama.
- **Siaran langsung tidak bisa diunduh selama masih tayang.** Tombol unduh diganti penjelasan, dan unduhan yang tetap dikirim ditolak. Setelah siarannya selesai, buka lagi videonya untuk mengunduh rekamannya (YouTube perlu waktu untuk memproses rekamannya, jadi mungkin belum langsung tersedia).
- **Pemutar siaran kosong?** Pemilik siaran bisa melarang pemutaran di luar YouTube. Kalau Tonton mendeteksinya, muncul catatan kuning dengan tombol **Buka di YouTube** (versi desktop membukanya di browser bawaan). Tidak semua kasus bisa dideteksi, jadi kalau pemutarnya kosong tanpa catatan, penyebabnya kemungkinan sama.
- **Putar otomatis memakai IFrame API resmi YouTube** untuk tahu kapan video selesai. Skripnya dimuat dari youtube.com (pemutarnya sendiri tetap dari youtube-nocookie.com). Kalau skrip itu gagal dimuat, video tetap diputar seperti biasa tetapi tanpa hitung mundur otomatis, dan kartu **Berikutnya** tetap bisa dipakai manual.
- **Chat dimuat dari youtube.com**, bukan dari youtube-nocookie.com seperti pemutarnya, jadi baru dimuat setelah kamu menekan **Tampilkan chat**. Pemilik siaran bisa membatasi chat, dan dalam kasus itu kotak chat bisa tampil kosong.
- Mencari **Sedang live** memakai filter pencarian YouTube. Hasilnya hanya siaran yang sedang tayang saat itu, dan sama seperti pencarian biasa, kata kunci yang terlalu umum bisa memunculkan siaran yang kurang relevan.
- Membuka halaman channel kini memuat tab **Live** di latar belakang (satu permintaan tambahan) supaya status "sedang live" langsung terlihat.
- Pratinjau hanya tersedia untuk video YouTube. Untuk situs lain yang didukung yt-dlp, unduhan tetap bisa dipakai tanpa pratinjau.
- Playlist tidak didukung. Yang diunduh hanya satu video per tautan.

## Struktur

```
desktop.py               Pembungkus jendela desktop (pywebview)
app.py                   Server Flask: pencarian, info video, antrean unduhan
static/                  Antarmuka (index.html, style.css, app.js, manifest.json, ikon)
termux/                  Pemasang dan perintah "tonton" untuk Android (Termux)
android/                 Proyek APK pembungkus (WebView) untuk Android
.github/workflows/       Skrip GitHub yang membangun APK
icon.ico                 Ikon aplikasi
build_windows.bat / .ps1 Membangun Tonton.exe
run_desktop.bat          Menjalankan versi desktop tanpa membangun .exe
requirements.txt         Dependensi mode browser
requirements-desktop.txt Dependensi versi desktop
```
