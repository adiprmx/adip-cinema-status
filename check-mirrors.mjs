#!/usr/bin/env node
/* check-mirrors.mjs - MONITOR PRODUKSI v5 (repo adiprmx/adip-cinema-status).
 *
 * Monitor uptime Adip Cinema, dijalankan GitHub Actions terjadwal di repo
 * status PUBLIK ini (menit Actions tidak terbatas di repo publik;
 * status.json disajikan lewat GitHub Pages untuk dibaca pintu pintar).
 *
 * Cara kerja per run:
 *   1. Baca mirrors.json dari URL live situs utama dulu
 *      (https://cinema.adipmusic.my.id/mirrors.json - file yang sama
 *      dengan yang disajikan situs, jadi daftar selalu sinkron tanpa
 *      salin manual); jatuh ke salinan lokal di repo ini bila URL mati.
 *   2. Cek tiap mirror live: fetch + verifikasi <title> (logika yang sama
 *      dengan pintu-pintar.js, dipakai ulang lewat require).
 *   3. Mirror yang gagal dicek SEKALI LAGI sesudah jeda 5 detik sebelum
 *      dihitung gagal. Satu paket hilang tidak boleh jadi alarm.
 *   4. Baca status.json sebelumnya (bila ada) untuk menghitung gagal /
 *      sukses BERTURUT-TURUT (histeresis: sembunyikan sesudah 3 gagal,
 *      pulih sesudah 2 sukses - angka yang sama dengan pintu-pintar.js).
 *   5. Tulis status.json baru + ringkasan ke stdout.
 *
 * Exit code: 0 bila cek berjalan (mirror mati adalah DATA, bukan error
 * workflow); 1 bila skripnya sendiri gagal (mirrors.json tidak terbaca).
 *
 * Opsi:
 *   --mirrors <file>   daftar mirror (default: ./mirrors.json)
 *   --mirrors-url <url>  coba ambil mirrors.json dari URL ini DULU
 *                      (mis. https://cinema.adipmusic.my.id/mirrors.json -
 *                      file yang sama dengan yang disajikan situs live,
 *                      jadi tidak perlu sinkronisasi salinan manual).
 *                      Bila gagal (situs utama mati / timeout 10 dtk),
 *                      jatuh ke file lokal --mirrors. Tanpa opsi ini,
 *                      langsung baca file lokal.
 *   --prev <file>      status.json run sebelumnya (default: ./status.json)
 *   --out <file>       status.json yang ditulis (default: ./status.json)
 *   --map <file>       JSON {id: url} yang menimpa URL mirror (HANYA
 *                      untuk tes lokal; jangan dipakai di Actions)
 *   --timeout <ms>     timeout per percobaan (default 10000)
 *   --retry-delay <ms> jeda sebelum percobaan kedua (default 5000)
 */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const Pintu = require("./pintu-pintar.js");

const HIDE_AFTER_FAILS = Pintu.DEFAULTS.hideAfterFails; // 3
const FLAG_AFTER_FAILS = Pintu.DEFAULTS.flagAfterFails; // 2
const RECOVER_AFTER_OK = Pintu.DEFAULTS.recoverAfterOk; // 2

function parseArgs(argv) {
  const out = {
    mirrors: "./mirrors.json",
    mirrorsUrl: null,
    prev: "./status.json",
    out: "./status.json",
    map: null,
    timeout: 10000,
    retryDelay: 5000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mirrors") out.mirrors = argv[++i];
    else if (a === "--mirrors-url") out.mirrorsUrl = argv[++i];
    else if (a === "--prev") out.prev = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--map") out.map = argv[++i];
    else if (a === "--timeout") out.timeout = Number(argv[++i]);
    else if (a === "--retry-delay") out.retryDelay = Number(argv[++i]);
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* Satu percobaan cek: fetch + verifikasi judul. Di Node tidak ada
   DOMParser, jadi hasExpectedTitle memakai jalur fallback (buang
   noscript + komentar + script, lalu ambil <title>). Jalur browser
   tetap DOMParser. */
async function attempt(mirror, timeoutMs) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(mirror.url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "adip-cinema-monitor/1.0 (+https://cinema.adipmusic.my.id/)" },
    });
    if (!res.ok) return { ok: false, ms: Date.now() - started, error: "http-" + res.status };
    const text = await res.text();
    const ok = Pintu.hasExpectedTitle(text, Pintu.DEFAULTS.expectedTitle, {});
    return { ok, ms: Date.now() - started, error: ok ? null : "bad-title" };
  } catch (err) {
    const name = err && err.name === "AbortError" ? "timeout" : "network";
    return { ok: false, ms: Date.now() - started, error: name };
  } finally {
    clearTimeout(timer);
  }
}

async function checkOne(mirror, opts) {
  const first = await attempt(mirror, opts.timeout);
  if (first.ok) return first;
  await sleep(opts.retryDelay);
  const second = await attempt(mirror, opts.timeout);
  /* Percobaan kedua yang sukses menebus yang pertama: catat waktu
     percobaan kedua (waktu respons yang sebenarnya), bukan jumlahnya. */
  return second;
}

/* Ambil daftar mirror: coba URL live dulu (bila diminta), jatuh ke file
   lokal bila URL gagal. Mengembalikan null bila keduanya gagal. */
async function loadMirrors(opts) {
  if (opts.mirrorsUrl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(opts.mirrorsUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.mirrors)) {
          console.log(`mirrors.json dari URL live: ${opts.mirrorsUrl}`);
          return data;
        }
      }
      console.log("URL live tidak memberi daftar mirror yang sah, pakai file lokal.");
    } catch (err) {
      console.log(`URL live gagal (${err.message}), pakai file lokal.`);
    }
  }
  try {
    return JSON.parse(readFileSync(opts.mirrors, "utf8"));
  } catch (err) {
    console.error("GAGAL baca mirrors.json:", err.message);
    return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const data = await loadMirrors(opts);
  if (!data) process.exit(1);

  let urlMap = {};
  if (opts.map) {
    urlMap = JSON.parse(readFileSync(opts.map, "utf8"));
  }

  let prev = {};
  if (existsSync(opts.prev)) {
    try {
      prev = JSON.parse(readFileSync(opts.prev, "utf8")).mirrors || {};
    } catch {
      prev = {};
    }
  }

  const cands = Pintu.candidatesOf(data).map((m) => ({
    ...m,
    url: urlMap[m.id] || m.url,
  }));

  const startedAll = Date.now();
  Promise.all(cands.map((m) => checkOne(m, opts).then((r) => ({ m, r })))).then(
    (pairs) => {
      const now = Date.now();
      const mirrors = {};
      let up = 0;
      for (const { m, r } of pairs) {
        const p = prev[m.id] || {};
        const fails = r.ok ? 0 : (p.fails || 0) + 1;
        /* oks (sukses berturut-turut) hanya dipakai untuk pemulihan
           label: mirror yang sempat ditandai baru bersih sesudah
           RECOVER_AFTER_OK sukses. fails sudah 0 sejak sukses pertama,
           jadi oks dihitung terpisah. */
        const oks = r.ok ? (p.oks || 0) + 1 : 0;
        const flagged = fails >= FLAG_AFTER_FAILS;
        const hidden = fails >= HIDE_AFTER_FAILS;
        /* Pulih: label hilang sesudah 2 sukses berturut-turut. Bila
           baru 1 sukses sesudah sempat ditandai, label dipertahankan
           satu run lagi (p.flaggedPrev dibawa dari run sebelumnya). */
        const wasFlagged = p.flagged === true;
        const stillFlagged = flagged || (wasFlagged && oks < RECOVER_AFTER_OK && r.ok);
        mirrors[m.id] = {
          ok: r.ok,
          ms: r.ms,
          fails,
          oks,
          flagged: stillFlagged,
          hidden,
          checkedAt: now,
          error: r.error,
        };
        if (r.ok) up++;
        const mark = r.ok ? "HIDUP" : "MATI ";
        const extra = hidden ? " [disembunyikan dari alihan otomatis]"
          : stillFlagged ? " [sedang bermasalah]" : "";
        console.log(`${mark} ${m.id} ${r.ms}ms${r.error ? " (" + r.error + ")" : ""}${extra}`);
      }
      const status = {
        generatedAt: now,
        generatedAtIso: new Date(now).toISOString(),
        checked: pairs.length,
        up,
        mirrors,
      };
      writeFileSync(opts.out, JSON.stringify(status, null, 2) + "\n");
      console.log(
        `Selesai: ${up}/${pairs.length} hidup, ${Date.now() - startedAll}ms total. -> ${opts.out}`
      );
    }
  );
}

main();
