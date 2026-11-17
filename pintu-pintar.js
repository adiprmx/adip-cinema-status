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
 * Tes Node 75 cek (v5/scratch/pintu-pintar/test-pintu-pintar.mjs)
 * dijalankan terhadap file ini.
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
    /* 6000: sama seperti pintu.js sekarang. Pengunjung tidak pernah
       menunggu lebih dari 6 detik sebelum melihat daftar manual. */
    globalCapMs: 6000,
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

  function checkMirror(mirror, opts, deps) {
    var fetchFn = deps.fetchFn;
    var now = deps.now;
    if (typeof fetchFn !== "function") {
      return Promise.resolve({ id: mirror.id, ok: false, ms: null, error: "no-fetch" });
    }
    var started = now();
    var controller = null;
    var timer = null;
    var options = { mode: "cors", cache: "no-store" };
    var AC = deps.AbortController;
    if (typeof AC === "function") {
      controller = new AC();
      options.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, opts.timeoutMs);
    }
    function done(ok, error) {
      if (timer) clearTimeout(timer);
      return { id: mirror.id, ok: ok, ms: now() - started, error: error || null };
    }
    return fetchFn(mirror.url, options).then(
      function (res) {
        if (!res.ok) return done(false, "http-" + res.status);
        return res.text().then(
          function (text) {
            var ok = hasExpectedTitle(text, opts.expectedTitle, deps.env);
            return done(ok, ok ? null : "bad-title");
          },
          function () { return done(false, "body"); }
        );
      },
      function (err) {
        var name = err && err.name === "AbortError" ? "timeout" : "network";
        return done(false, name);
      }
    );
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
     dipakai. */
  function fastPath(cache, cands, statusMap, opts, deps) {
    if (!cache || !cache.bestId) return Promise.resolve(null);
    var target = null;
    for (var i = 0; i < cands.length; i++) {
      if (cands[i].id === cache.bestId) { target = cands[i]; break; }
    }
    if (!target) return Promise.resolve(null);
    return checkMirror(target, opts, deps).then(function (r) {
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
