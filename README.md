# adip-cinema-status

Monitor uptime untuk semua alamat (mirror) Adip Cinema. Repo publik
yang terpisah dari repo utama, supaya menit GitHub Actions-nya tidak
terbatas dan statusnya bisa dibaca lewat GitHub Pages tanpa token.

## Cara kerja

Setiap 15 menit, GitHub Actions menjalankan `check-mirrors.mjs`:

1. Ambil daftar mirror dari `https://cinema.adipmusic.my.id/mirrors.json`
   (file yang sama dengan yang disajikan situs, jadi daftar selalu
   sinkron). Bila situs utama mati, pakai salinan `mirrors.json` di
   repo ini.
2. Cek tiap mirror yang live: ambil halamannya, pastikan judulnya
   persis "Adip Cinema". Mirror yang gagal dicek sekali lagi sesudah
   jeda 5 detik sebelum dihitung gagal.
3. Tulis `status.json` dan commit bila status berubah (ditambah
   heartbeat tiap 45 menit supaya status tidak basi).

Pintu pintar di situs membaca `status.json` ini untuk tahu alamat
mana yang sedang bermasalah. Pintu tetap mengecek live sendiri,
jadi monitor yang mati tidak pernah mematikan pintu.

## Aturan status (K-C82)

- 2 gagal berturut-turut: label "Sedang bermasalah". Tetap bisa
  dipilih otomatis.
- 3 gagal berturut-turut: keluar dari alihan otomatis. Tetap tampil
  di daftar manual dengan tombol Buka.
- Pulih sesudah 2 sukses berturut-turut.
- Bila monitor bilang semua mati, pintu mengabaikan monitor
  (fail-open).

## Tautan

- Status mentah: https://adiprmx.github.io/adip-cinema-status/status.json
- Halaman status: https://adiprmx.github.io/adip-cinema-status/
- Repo utama (privat): adip-cinema-web
- Situs utama: https://cinema.adipmusic.my.id/

## Biaya

Rp0. GitHub Actions di repo publik tidak dibatasi menitnya,
GitHub Pages gratis. Workflow tidak memakai secret apa pun.
