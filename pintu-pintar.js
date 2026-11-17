/* pintu-pintar-module.js - MODUL PRODUKSI v5 (Adip Cinema).
 *
 * Pintu pintar Adip Cinema: cek semua mirror secara live dari browser
 * pengunjung, lalu arahkan ke mirror yang tercepat DAN hidup.
 *
 * Beda dari pintu.js v3/v4: pintu lama mengarahkan ke mirror
 * TERVERIFIKASI pertama menurut URUTAN PRIORITAS (primary dulu, walau
 * lambat). Pintu pintar memilih dari hasil cek live: tier versi dulu
 * (v4 mengalahkan v2), lalu yang tidak ditandai bermasalah oleh monitor,
 * lalu yang tercepat. Kecepatan tidak pernah mengalahkan versi: mirror
 * v2 yang cepat tetap kalah dari mirror v4 yang agak lambat.
 *
 * Modul ini tanpa dependensi, jalan di browser dan di Node (UMD).
 * Semua yang berbau lingkungan (fetch, jam, penyimpanan, DOMParser)
 * disuntikkan lewat `deps`, supaya logikanya bisa diuji di Node tanpa
 * browser. Nilai default `deps` memakai global browser/Node.
 *
 * SUMBER KEBENARAN TUNGGAL: file ini. Dipakai di dua tempat:
 *   - pintu.js (disuntikkan scripts/gen-pintu.mjs dari template)
 *   - repo monitor adiprmx/adip-cinema-status (salinan pintu-pintar.js,
 *     dipakai check-mirrors.mjs) — salinan itu WAJIB identik dengan
 *     file ini; bila file ini berubah, salin ulang ke repo status.
 * Tes Node 87 cek (v5/scratch/pintu-pintar/test-pintu-pintar.mjs,
 * dijalankan terhadap file ini lewat harness
 * v5/scratch/paket5-pintu/node-suite/) + uji browser Playwright 17 cek.
 *
 * RETRY (K-C97, Paket 5): cermin yang TIMEOUT mendapat satu percobaan
 * ulang dengan timeout lebih panjang, sebelum dinyatakan gagal. Akar
 * masalahnya: putaran pertama uji live 17 Nov 15:46 WIB memberi 0/7
 * timeout total (~4000 ms semua), lalu putaran ulang 6/7 lolos — jeda
 * dingin bersama di sisi browser (DNS/TLS/proksi baru), bukan cermin
 * yang mati. Tanpa retry, satu cek dingin memvonis semua cermin mati.
 * Retry HANYA untuk timeout; network/bad-title/http tidak diulang
 * karena pengulangan tidak mengubah hasilnya. Jalur cepat (fastPath)
 * TIDAK mengulang: tugasnya hanya probe cepat, dan cek penuh yang
 * mengambil alih bila probe gagal. Batas global naik 6 -> 10 detik
 * supaya satu siklus penuh (4 detik + 5 detik retry) muat di dalamnya;
 * batas hanya mengikat bila tidak ada satu pun cermin yang terverifikasi.
 * Perilaku grace + fail-open + daftar manual tidak berubah (laporan 19
 * §5.3 dipertahankan).
 *
 * Keamanan (diwarisi dari pintu.js, temuan Red Team r1-r3):
 * - Hanya mirror berstatus live/live-v2 yang jadi kandidat (N-STATUS).
 * - Auto-redirect HANYA ke mirror yang lolos verifikasi isi: <title>
 *   dokumen harus persis "Adip Cinema", dibaca lewat DOMParser setelah
 *   blok <noscript> dihapus dari teks mentah (N-Q1C2). Judul di komentar,
 *   <script>, atau <noscript> tidak dihitung.
 * - Cek hanya ke URL di daftar kurasi owner (mirrors.json). Tidak ada
 *   beacon, analitik, atau panggilan ke pihak ketiga. Fetch lintas origin
 *   tidak mengirim cookie (default credentials same-origin).
 */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.PintuPintar = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Konfigurasi. Setiap angka punya satu alasan (R-31).                 */
  /* ------------------------------------------------------------------ */
  var DEFAULTS = {
    expectedTitle: "Adip Cinema",
    /* 4000: sama seperti pintu.js sekarang. Mirror yang tidak menjawab
       + terverifikasi dalam 4 detik bukan tujuan alihan yang bagus;
       layanan Render yang sedang tidur (~60 detik bangun) ikut gagal,
       dan itu benar: pengunjung tidak boleh dilempar ke layar loading
       60 detik. */
    timeoutMs: 4000,
    /* 5000: timeout percobaan ULANG (K-C97, Paket 5). Lebih panjang
       dari percobaan pertama (4000) supaya cermin yang masih
       menyelesaikan pemanasan dinginnya mendapat ruang; 4000 + 5000
       = 9000 masih di bawah batas global 10000 dengan sisa 1 detik,
       jadi batas global tidak pernah memotong retry di tengah jalan.
       Retry hanya untuk timeout; lihat checkMirror. */
    retryTimeoutMs: 5000,
    /* 1: satu percobaan ulang, tidak lebih. Satu retry sudah
       menyelamatkan anomali 0/7 (putaran kedua uji live selalu cepat);
       retry kedua hanya menambah waktu tunggu tanpa bukti manfaat,
       dan cermin yang gagal dua kali memang tidak layak jadi tujuan
       alihan. Jalur cepat memakai 0 (lihat fastPath). */
    maxRetries: 1,
    /* 10000: naik dari 6000 (K-C97, Paket 5). Batas global WAJIB
       menampung satu siklus penuh percobaan pertama + retry
       (4000 + 5000 = 9000) ditambah sisa 1 detik; bila batas tetap
       6000, batas akan memotong retry di detik ke-2 dan retry menjadi
       kode mati di skenario yang justru membutuhkannya. Batas hanya
       mengikat bila TIDAK ADA cermin yang terverifikasi (semua mati
       atau menggantung); dalam kunjungan normal, jendela grace
       mengakhiri cek dalam ~1 detik, tidak berubah. Harga yang
       dibayar: daftar manual paling lambat tampil di 10 detik, bukan
       6 detik, dan hanya dalam skenario semua-gagal. */
    globalCapMs: 10000,
    /* 500: sesudah mirror pertama terverifikasi, tunggu paling lama
       500 ms lagi. Tujuannya BUKAN mencari yang lebih cepat (yang
       pertama terverifikasi sudah yang tercepat), melainkan memberi
       kesempatan pada mirror TIER LEBIH TINGGI (v4) atau yang TIDAK
       ditandai bermasalah untuk ikut masuk keputusan. Tambahan tunggu
       maksimal 500 ms per kunjungan. */
    graceMs: 500,
    /* 50: selisih waktu di bawah 50 ms dianggap setara (jitter jaringan
       biasa); yang menang adalah urutan prioritas, supaya pilihan tidak
       flip-flop tiap kunjungan. */
    tieMs: 50,
    /* 600000 (10 menit): hasil cek disimpan selama ini. Mirror jarang
       mati dalam 10 menit; kunjungan ulang dalam jendela ini cukup
       memverifikasi 1 mirror (yang tercepat kemarin), bukan 6-7. */
    cacheTtlMs: 600000,
    cacheKey: "pintu-pintar:v1",
    /* 2000: status monitor (status.json) tidak boleh memperlambat pintu.
       Gagal dimuat dalam 2 detik = pintu jalan tanpa status, cek live
       saja. Monitor tidak pernah boleh mematikan pintu. */
    statusTimeoutMs: 2000,
    /* 3600000 (1 jam): status monitor yang lebih tua dari ini diabaikan.
       Monitor yang berhenti menulis tidak boleh meracuni pintu dengan
       info basi. */
    statusMaxAgeMs: 3600000,
    /* 3: mirror baru dikeluarkan dari kandidat auto-redirect sesudah 3
       kali gagal berturut-turut di monitor. Satu-dua gagal bisa jadi
       flap egress di sisi monitor, bukan mirror yang mati. */
    hideAfterFails: 3,
    /* 2: mirror ditandai "sedang bermasalah" di daftar sesudah 2 kali
       gagal berturut-turut. Tetap bisa dipilih otomatis sampai 3. */
    flagAfterFails: 2,
    /* 2: mirror yang tadinya bermasalah baru dianggap pulih sesudah 2
       kali sukses berturut-turut. Mencegah label berkedip hidup-mati. */
    recoverAfterOk: 2
  };

  /* ------------------------------------------------------------------ */
  /* Utilitas murni (tanpa efek samping, mudah diuji).                    */
  /* ------------------------------------------------------------------ */

  function isUsableUrl(raw) {
    if (typeof raw !== "string" || !raw) return false;
    var url;
    try {
      url = new URL(raw);
    } catch (err) {
      return false;
    }
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" || url.hostname === "[::1]")) return true;
    return false;
  }

  function isLiveStatus(status) {
    return status === "live" || status === "live-v2";
  }

  /* Tier versi: live (versi terbaru) = 0, live-v2 (versi lama) = 1.
     Tier yang lebih kecil menang, apa pun kecepatannya. */
  function tierOf(status) {
    if (status === "live") return 0;
    if (status === "live-v2") return 1;
    return 99;
  }

  /* K-C80 (deep research eksternal, 17 Nov 2026): host berikut MATI dan
     TIDAK BOLEH masuk daftar mirror, apa pun yang tertulis di config:
     Glitch (tutup Jul 2025), Fleek (tutup Jan 2026), Fly.io free tier
     (hilang Okt 2024), Koyeb free (tutup Feb 2026), Stormkit cloud
     (hanya self-hosted), Deno Deploy (tutup ~6 bulan sesudah Okt 2026).
     Pengaman ini bekerja dua lapis: token pada `id` mirror (kurasi
     owner, mis. "fleek" dan "stormkit" yang masih tercantum di
     mirrors.json) + sufiks hostname yang dikenal. Bila suatu hari
     seorang host hidup lagi, hapus dari daftar ini secara eksplisit. */
  var DEAD_HOST_TOKENS = ["glitch", "fleek", "fly", "koyeb", "stormkit", "deno"];
  var DEAD_HOST_SUFFIXES = [".glitch.me", ".fly.dev", ".koyeb.app"];

  function isExcludedHost(mirror) {
    if (!mirror) return false;
    var id = String(mirror.id || "").toLowerCase();
    var tokens = id.split(/[-_]/);
    for (var i = 0; i < tokens.length; i++) {
      if (DEAD_HOST_TOKENS.indexOf(tokens[i]) !== -1) return true;
    }
    if (typeof mirror.url === "string" && mirror.url) {
      try {
        var host = new URL(mirror.url).hostname.toLowerCase();
        for (var j = 0; j < DEAD_HOST_SUFFIXES.length; j++) {
          if (host.endsWith(DEAD_HOST_SUFFIXES[j])) return true;
        }
      } catch (err) { /* URL tidak sah ditangani isUsableUrl */ }
    }
    return false;
  }

  /* Urutan kandidat: primary dulu, lalu field `priority` (angka kecil
     menang; tanpa priority = urutan daftar). K-C80: Cloudflare Pages
     adalah host statis terkuat (bandwidth unlimited, tanpa kartu) dan
     layak diprioritaskan sebagai mirror utama bersama Vercel, Render,
     dan Firebase yang sudah live; GitHub Pages sebagai fallback.
     Nilai priority yang diusulkan ada di laporan (bukan di sini),
     karena urutan adalah DATA (mirrors.json), bukan logika.
     Urutan ini hanya memecah seri: dua mirror dengan selisih waktu
     di bawah tieMs dianggap setara, dan yang berprioritas lebih tinggi
     menang. Kecepatan tetap diukur live; prioritas tidak pernah
     mengalahkan hasil cek. */
  function orderedMirrors(data) {
    var mirrors = (data && Array.isArray(data.mirrors)) ? data.mirrors.slice() : [];
    var primary = data ? data.primary : null;
    mirrors.sort(function (a, b) {
      if (a.id === primary) return -1;
      if (b.id === primary) return 1;
      var pa = (typeof a.priority === "number") ? a.priority : Infinity;
      var pb = (typeof b.priority === "number") ? b.priority : Infinity;
      if (pa !== pb) return pa - pb;
      return 0; /* sort stabil: tanpa priority, urutan daftar bertahan */
    });
    return mirrors;
  }

  function candidatesOf(data) {
    return orderedMirrors(data).filter(function (m) {
      return isUsableUrl(m.url) && isLiveStatus(m.status) && !isExcludedHost(m);
    });
  }

  /* Regex yang SAMA dengan pintu.js (terverifikasi Red r3): hapus blok
     <noscript> dari teks mentah SEBELUM parse, karena DOMParser dengan
     scripting nonaktif mengurai isi noscript sebagai DOM dan mengangkat
     <title> di dalamnya ke <head>. */
  var NOSCRIPT_RE = /<noscript\b[^>]*>[\s\S]*?(<\/noscript\s*>|$)/gi;

  function stripNoscript(text) {
    return text.replace(NOSCRIPT_RE, "");
  }

  /* Ekstraktor <title> cadangan untuk lingkungan tanpa DOMParser
     (Node, saat pengujian). BUKAN jalur produksi: sebelum mengambil
     <title>, ia juga membuang komentar HTML dan blok <script>, supaya
     judul palsu yang disembunyikan di sana tidak ikut terhitung.
     Jalur browser selalu memakai DOMParser (persis pintu.js). */
  function extractTitleFallback(text) {
    var bersih = stripNoscript(text)
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<script\b[^>]*>[\s\S]*?(<\/script\s*>|$)/gi, "");
    var m = bersih.match(/<title[^>]*>([^<]*)<\/title\s*>/i);
    return m ? m[1].trim() : null;
  }

  function hasExpectedTitle(text, expectedTitle, env) {
    try {
      var bersih = stripNoscript(text);
      var DP = env && env.DOMParser;
      if (typeof DP === "function") {
        var doc = new DP().parseFromString(bersih, "text/html");
        return doc.title === expectedTitle;
      }
      return extractTitleFallback(text) === expectedTitle;
    } catch (err) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Cek satu mirror: fetch + verifikasi isi + ukur waktu.               */
  /* ------------------------------------------------------------------ */

  /* Cek satu mirror: fetch + verifikasi isi + ukur waktu. Hasil
     membawa `attempts` (jumlah percobaan yang dipakai: 1 atau 2) dan
     `ms` adalah WAKTU TOTAL sejak percobaan pertama dimulai, supaya
     peringkat kecepatan jujur: cermin yang butuh retry memang membuat
     pengunjung menunggu lebih lama. */
  function checkMirror(mirror, opts, deps) {
    var fetchFn = deps.fetchFn;
    var now = deps.now;
    if (typeof fetchFn !== "function") {
      return Promise.resolve({ id: mirror.id, ok: false, ms: null, error: "no-fetch", attempts: 0 });
    }
    var started = now();
    var maxRetries = (typeof opts.maxRetries === "number") ? opts.maxRetries : 1;
    var retryMs = (typeof opts.retryTimeoutMs === "number") ? opts.retryTimeoutMs : opts.timeoutMs;
    var attempts = 0;

    function attempt(timeoutMs) {
      attempts++;
      var controller = null;
      var timer = null;
      var options = { mode: "cors", cache: "no-store" };
      var AC = deps.AbortController;
      if (typeof AC === "function") {
        controller = new AC();
        options.signal = controller.signal;
        timer = setTimeout(function () { controller.abort(); }, timeoutMs);
      }
      function finish(ok, error) {
        if (timer) clearTimeout(timer);
        return { id: mirror.id, ok: ok, ms: now() - started, error: error || null, attempts: attempts };
      }
      /* TIMEOUT adalah satu-satunya kegagalan yang diulang (K-C97).
         Percobaan pertama bisa gagal karena jalurnya dingin
         (DNS/TLS/proksi baru di browser pengunjung), bukan karena
         cerminnya mati; bukti uji live: putaran pertama 0/7 timeout,
         putaran ulang 6/7 lolos. Percobaan ulang memakai timeout
         lebih panjang (retryTimeoutMs). Kegagalan lain tidak diulang:
         network (termasuk blokir CORS — pengulangan tidak mengubah
         header cermin), bad-title (isi halaman tidak berubah dalam
         hitungan detik), http-XXX, body. */
      function fail(name) {
        if (name === "timeout" && attempts <= maxRetries) {
          if (timer) clearTimeout(timer);
          return attempt(retryMs);
        }
        return finish(false, name);
      }
      return fetchFn(mirror.url, options).then(
        function (res) {
          if (!res.ok) return finish(false, "http-" + res.status);
          return res.text().then(
            function (text) {
              var ok = hasExpectedTitle(text, opts.expectedTitle, deps.env);
              return finish(ok, ok ? null : "bad-title");
            },
            function (err) {
              /* Abort saat membaca bodi (server mengirim header lalu
                 menahan bodi melewati timeout) adalah timeout juga,
                 bukan "body": tanpa ini, cermin yang menahan bodi
                 tidak pernah mendapat retry. */
              return fail(err && err.name === "AbortError" ? "timeout" : "body");
            }
          );
        },
        function (err) {
          return fail(err && err.name === "AbortError" ? "timeout" : "network");
        }
      );
    }

    return attempt(opts.timeoutMs);
  }

  /* ------------------------------------------------------------------ */
  /* Keputusan: dari hasil cek + status monitor, pilih satu mirror.      */
  /* Murni (tanpa timer/fetch) supaya bisa diuji langsung di Node.       */
  /* ------------------------------------------------------------------ */

  /* Status monitor untuk satu mirror: { ok, fails, oks, checkedAt }.
     fails = gagal berturut-turut, oks = sukses berturut-turut. */
  function monitorState(statusEntry, opts) {
    if (!statusEntry) return { flagged: false, hidden: false };
    /* Bila monitor sudah menghitung flag-nya sendiri (dengan histeresis
       pemulihan), pakai angka monitor. Bila status hanya berisi fails
       mentah, hitung dari ambang di sini. */
    if (typeof statusEntry.hidden === "boolean" || typeof statusEntry.flagged === "boolean") {
      return { flagged: !!statusEntry.flagged, hidden: !!statusEntry.hidden };
    }
    var fails = statusEntry.fails || 0;
    return {
      flagged: fails >= opts.flagAfterFails,
      hidden: fails >= opts.hideAfterFails
    };
  }

  /* Aturan pilih (berurutan):
     1. Hanya yang terverifikasi live di browser ini.
     2. Tier versi terendah (v4 mengalahkan v2).
     3. Yang tidak disembunyikan monitor mengalahkan yang disembunyikan,
        KECUALI bila yang disembunyikan satu-satunya yang terverifikasi
        (fail-open: cek live lebih kuat dari kata monitor).
     4. Tercepat; selisih di bawah tieMs dianggap setara.
     5. Urutan prioritas (primary dulu) sebagai pemecah seri terakhir. */
  function decide(results, mirrors, statusMap, opts) {
    var byId = {};
    mirrors.forEach(function (m, i) { byId[m.id] = { mirror: m, index: i }; });
    var verified = results.filter(function (r) { return r.ok && byId[r.id]; });
    if (verified.length === 0) return { best: null, ranked: [] };

    function score(r) {
      var entry = byId[r.id];
      var st = monitorState(statusMap ? statusMap[r.id] : null, opts);
      return {
        result: r,
        mirror: entry.mirror,
        index: entry.index,
        tier: tierOf(entry.mirror.status),
        hidden: st.hidden,
        flagged: st.flagged
      };
    }
    var scored = verified.map(score);
    var usable = scored.filter(function (s) { return !s.hidden; });
    /* Fail-open: bila monitor menyembunyikan SEMUA yang terverifikasi,
       abaikan monitor sepenuhnya. Monitor yang rusak tidak boleh
       mematikan pintu. */
    var pool = usable.length > 0 ? usable : scored;
    pool.sort(function (a, b) {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (Math.abs(a.result.ms - b.result.ms) > opts.tieMs) {
        return a.result.ms - b.result.ms;
      }
      return a.index - b.index;
    });
    return { best: pool[0], ranked: pool };
  }

  /* Label satu mirror untuk daftar manual, bahasa sehari-hari.
     Status config non-live menang atas hasil cek (sama seperti pintu.js).
     Mirror yang disembunyikan monitor TETAP TAMPIL di daftar manual
     dengan tombol Buka: daftar manual adalah jalan terakhir pengunjung,
     menyembunyikan entri di sana hanya mengurangi pilihan tanpa manfaat. */
  function labelFor(mirror, verified, statusEntry, opts) {
    if (!isLiveStatus(mirror.status)) {
      return mirror.status === "down"
        ? { text: "Tidak bisa dibuka", reason: "Alamat ini sedang tidak bisa dipakai.", dot: "red", openable: false }
        : { text: "Segera hadir", reason: "Alamat ini belum ada.", dot: "gray", openable: false };
    }
    if (!isUsableUrl(mirror.url)) {
      return { text: "Segera hadir", reason: "Alamat ini belum ada.", dot: "gray", openable: false };
    }
    var st = monitorState(statusEntry, opts);
    if (verified) {
      if (st.flagged) {
        return { text: "Bisa dibuka", reason: "Alamat ini sempat bermasalah, tapi barusan bisa dibuka.", dot: "green", openable: true };
      }
      return { text: "Bisa dibuka", reason: null, dot: "green", openable: true };
    }
    if (st.hidden || st.flagged) {
      return { text: "Sedang bermasalah", reason: "Alamat ini sudah beberapa kali tidak menjawab.", dot: "red", openable: true };
    }
    return { text: "Belum bisa dipastikan", reason: "Tidak menjawab atau isinya tidak bisa dipastikan.", dot: "red", openable: true };
  }

  /* ------------------------------------------------------------------ */
  /* Cache hasil cek (localStorage di browser, disuntikkan di tes).      */
  /* ------------------------------------------------------------------ */

  function readCache(storage, opts, now) {
    if (!storage) return null;
    try {
      var raw = storage.getItem(opts.cacheKey);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || typeof data.checkedAt !== "number") return null;
      if (now() - data.checkedAt > opts.cacheTtlMs) return null;
      return data;
    } catch (err) {
      return null;
    }
  }

  function writeCache(storage, opts, data) {
    if (!storage) return;
    try {
      storage.setItem(opts.cacheKey, JSON.stringify(data));
    } catch (err) { /* penyimpanan penuh / privat: pintu tetap jalan */ }
  }

  /* ------------------------------------------------------------------ */
  /* Orkestrasi: cek paralel + jendela grace + batas global.             */
  /* ------------------------------------------------------------------ */

  /* statusMap boleh berupa objek ATAU fungsi pengambil (() => map).
     Bentuk fungsi dipakai pintu di browser: fetch status.json jalan
     PARALEL dengan cek mirror, dan peta yang dipakai adalah yang
     terbaru saat keputusan dibuat (bukan cuplikan saat cek dimulai).
     Bila status belum tiba saat keputusan dibuat, pengambil
     mengembalikan null dan pintu jalan tanpa status (fail-open). */
  function resolveStatusMap(statusMap) {
    return (typeof statusMap === "function") ? statusMap() : statusMap;
  }

  function runChecks(cands, statusMap, opts, deps) {
    return new Promise(function (resolve) {
      var results = [];
      var settled = 0;
      var firstVerifiedAt = null;
      var finished = false;
      var graceTimer = null;
      var capTimer = null;

      function finish() {
        if (finished) return;
        finished = true;
        if (graceTimer) clearTimeout(graceTimer);
        if (capTimer) clearTimeout(capTimer);
        /* results ikut dikembalikan: daftar manual butuh status
           per-mirror (terverifikasi/tidak), bukan hanya pemenang. */
        var out = decide(results, cands, resolveStatusMap(statusMap), opts);
        out.results = results;
        resolve(out);
      }

      capTimer = setTimeout(finish, opts.globalCapMs);

      cands.forEach(function (mirror) {
        checkMirror(mirror, opts, deps).then(function (r) {
          if (finished) return;
          results.push(r);
          settled++;
          if (r.ok && firstVerifiedAt === null) {
            firstVerifiedAt = deps.now();
            /* Jendela grace: beri kesempatan pada mirror tier lebih
               tinggi / tidak bermasalah yang sedikit lebih lambat. */
            graceTimer = setTimeout(finish, opts.graceMs);
          }
          if (settled === cands.length) finish();
        });
      });
    });
  }

  /* Jalur cepat kunjungan ulang: verifikasi SATU mirror (yang tercepat
     di cache yang masih segar). Berhasil = langsung pakai; gagal =
     panggil runChecks penuh. Mengembalikan null bila cache tidak bisa
     dipakai. Jalur cepat TIDAK mengulang (maxRetries 0): tugasnya
     hanya probe cepat, dan fallback-nya ADALAH cek penuh (yang
     mengulang). Mengulang di sini akan menghabiskan batas global
     untuk satu cermin dan membuat cek penuh tidak pernah jalan. */
  function fastPath(cache, cands, statusMap, opts, deps) {
    if (!cache || !cache.bestId) return Promise.resolve(null);
    var target = null;
    for (var i = 0; i < cands.length; i++) {
      if (cands[i].id === cache.bestId) { target = cands[i]; break; }
    }
    if (!target) return Promise.resolve(null);
    var fastOpts = {};
    for (var k in opts) fastOpts[k] = opts[k];
    fastOpts.maxRetries = 0;
    return checkMirror(target, fastOpts, deps).then(function (r) {
      if (!r.ok) return null;
      var out = decide([r], cands, resolveStatusMap(statusMap), opts);
      out.results = [r];
      return out;
    });
  }

  /* Ambil status monitor (status.json). Gagal / lambat / basi = null,
     dan pintu jalan tanpa status. Tidak pernah melempar. */
  function fetchStatus(statusUrl, opts, deps) {
    if (!statusUrl || typeof deps.fetchFn !== "function") {
      return Promise.resolve(null);
    }
    /* fetchFn WAJIB dipanggil sebagai fungsi biasa (bukan
       deps.fetchFn(...)): pemanggilan metode mengikat `this` ke objek
       deps, dan fetch bawaan browser menolak `this` yang bukan Window
       ("Illegal invocation") sehingga status TIDAK PERNAH terbaca di
       browser — pintu selalu jalan tanpa status. checkMirror sudah
       memakai pola ini; fetchStatus sempat memakai pola metode dan
       cacatnya hanya ketahuan di uji browser Playwright (tes Node
       75/75 lolos karena fetch Node tidak peduli `this`). */
    var fetchFn = deps.fetchFn;
    var controller = null;
    var timer = null;
    var options = { cache: "no-store" };
    if (typeof deps.AbortController === "function") {
      controller = new deps.AbortController();
      options.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, opts.statusTimeoutMs);
    }
    return fetchFn(statusUrl, options).then(
      function (res) {
        if (timer) clearTimeout(timer);
        if (!res.ok) return null;
        return res.json().then(
          function (data) {
            if (!data || !data.mirrors) return null;
            if (typeof data.generatedAt === "number" &&
                deps.now() - data.generatedAt > opts.statusMaxAgeMs) return null;
            return data.mirrors;
          },
          function () { return null; }
        );
      },
      function () {
        if (timer) clearTimeout(timer);
        return null;
      }
    );
  }

  return {
    DEFAULTS: DEFAULTS,
    isUsableUrl: isUsableUrl,
    isLiveStatus: isLiveStatus,
    isExcludedHost: isExcludedHost,
    tierOf: tierOf,
    orderedMirrors: orderedMirrors,
    candidatesOf: candidatesOf,
    stripNoscript: stripNoscript,
    extractTitleFallback: extractTitleFallback,
    hasExpectedTitle: hasExpectedTitle,
    checkMirror: checkMirror,
    monitorState: monitorState,
    decide: decide,
    labelFor: labelFor,
    readCache: readCache,
    writeCache: writeCache,
    runChecks: runChecks,
    fastPath: fastPath,
    fetchStatus: fetchStatus
  };
});
