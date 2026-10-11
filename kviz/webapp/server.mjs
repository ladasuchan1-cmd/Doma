#!/usr/bin/env node
/*
 * Sestaví veřejnou webovou verzi Boubínského kvízu (GitHub Pages, větev kviz-web) s ukázkami pod heslem.
 *
 *   KVIZ_HESLO=… node kviz/webapp/server.mjs VÝSTUP SLOŽKA_S_UKÁZKAMI
 *
 * Ukázky (soubory pojmenované jako ve složkách videos/hudba na Disku) se zašifrují AES-256-GCM klíčem
 * odvozeným z hesla (PBKDF2-SHA256); heslo se nikam neuloží. Když VÝSTUP už obsahuje předchozí sestavení,
 * zůstane stejná sůl i nezměněné ukázky, takže uložená hesla v telefonech dál platí a git nahrává jen nové.
 */
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "../web");
const APP = path.join(HERE, "../android/app/src/main/assets/app");
const [out, clipsDir] = process.argv.slice(2);
const password = process.env.KVIZ_HESLO;
if (!out || !clipsDir || !password) {
  console.error("Použití: KVIZ_HESLO=… node kviz/webapp/server.mjs VÝSTUP SLOŽKA_S_UKÁZKAMI");
  process.exit(1);
}

const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]/g, "");
const MIME = { mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav" };
const write = (p, data) => { fs.mkdirSync(path.dirname(path.join(out, p)), { recursive: true }); fs.writeFileSync(path.join(out, p), data); };
const b64 = (buf) => Buffer.from(buf).toString("base64");

// Předchozí sestavení: stejná sůl a nezměněné ukázky zůstanou.
let prev = null;
try {
  prev = JSON.parse(fs.readFileSync(path.join(out, "ukazky.js"), "utf8").replace(/^window\.KVIZ_SIFRA = /, "").replace(/;\s*$/, ""));
} catch (e) {}
const salt = prev ? Buffer.from(prev.salt, "base64") : randomBytes(16);
const iter = prev ? prev.iter : 210000;
const key = pbkdf2Sync(password, salt, iter, 32, "sha256");
const encrypt = (data, iv = randomBytes(12)) => {
  const c = createCipheriv("aes-256-gcm", key, iv);
  return { iv: b64(iv), data: Buffer.concat([c.update(data), c.final(), c.getAuthTag()]) };
};
const check = encrypt(Buffer.from("boubin"));
if (prev) {
  const old = createCipheriv("aes-256-gcm", key, Buffer.from(prev.check.iv, "base64"));
  const same = Buffer.concat([old.update("boubin"), old.final(), old.getAuthTag()]).equals(Buffer.from(prev.check.data, "base64"));
  if (!same) { console.error("Heslo se liší od předchozího sestavení – smaž VÝSTUP, nebo použij původní heslo."); process.exit(1); }
}

// Kvízy a jejich ukázky
const quizzes = fs.readdirSync(WEB).filter((f) => /^kviz-.*\.html$/.test(f)).sort().map((file) => {
  const html = fs.readFileSync(path.join(WEB, file), "utf8");
  const blocks = JSON.parse(html.match(/const BLOCKS = (\[.*?\]);\nconst SECONDS/s)[1]);
  const title = html.match(/<title>(.*?)<\/title>/)[1];
  const clips = blocks.flatMap((b) => b.flatMap((r) => r.items.filter((it) => it.t === "m").map((it) => norm(it.f[0]))));
  return { file, html, title, no: title.match(/(\d+)\s*$/)[1], rounds: blocks.flatMap((b) => b.map((r) => r.name)), clips };
});

// Ukázky: přesná shoda normalizovaného názvu (jako ve složkách na Disku)
const available = new Map(fs.readdirSync(clipsDir).filter((f) => MIME[f.split(".").pop().toLowerCase()])
  .map((f) => [norm(f), path.join(clipsDir, f)]));
const manifest = { salt: b64(salt), iter, check: { iv: check.iv, data: b64(check.data) }, clips: {} };
const missing = [];
let reused = 0;
for (const k of [...new Set(quizzes.flatMap((q) => q.clips))]) {
  const src = available.get(k);
  if (!src) { missing.push(k); continue; }
  const data = fs.readFileSync(src);
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
  const file = "ukazky/" + createHash("sha256").update(salt).update(k).digest("hex").slice(0, 16) + ".bin";
  const old = prev && prev.clips[k];
  if (old && old.h === hash && old.f === file && fs.existsSync(path.join(out, file))) { manifest.clips[k] = old; reused++; continue; }
  const e = encrypt(data);
  write(file, e.data);
  manifest.clips[k] = { f: file, iv: e.iv, t: MIME[src.split(".").pop().toLowerCase()], h: hash };
}
// Zašifrované soubory, které už žádná ukázka nepoužívá, pryč
const used = new Set(Object.values(manifest.clips).map((c) => path.basename(c.f)));
for (const f of fs.existsSync(path.join(out, "ukazky")) ? fs.readdirSync(path.join(out, "ukazky")) : []) {
  if (!used.has(f)) fs.rmSync(path.join(out, "ukazky", f));
}
write("ukazky.js", "window.KVIZ_SIFRA = " + JSON.stringify(manifest) + ";\n");

// Stránky: kvízy beze změny + mobilní vrstva a dešifrování; menu ze společné šablony
const scripts = '<script src="ukazky.js"></script>\n<script src="sifra.js"></script>\n';
for (const q of quizzes) {
  let html = q.html.replace("</head>", '<link rel="stylesheet" href="mobile.css">\n</head>');
  const i = html.lastIndexOf("</body>");
  write(q.file, html.slice(0, i) + scripts + '<script src="bridge.js"></script>\n' + html.slice(i));
}
const kvizy = quizzes.map((q) => ({ file: q.file, title: q.title, no: q.no, rounds: q.rounds, have: q.clips.filter((k) => manifest.clips[k]).length, total: q.clips.length }));
const menu = fs.readFileSync(path.join(HERE, "index.html"), "utf8").replace("/*KVIZY*/[]", JSON.stringify(kvizy)).replace("<!--SKRIPTY-->", scripts);
write("index.html", '<!DOCTYPE html>\n<html lang="cs">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n'
  + '<meta name="robots" content="noindex">\n</head>\n<body>\n' + menu + "</body>\n</html>\n");
for (const f of ["mobile.css", "bridge.js"]) fs.copyFileSync(path.join(APP, f), path.join(out, f));
fs.copyFileSync(path.join(HERE, "sifra.js"), path.join(out, "sifra.js"));
for (const f of fs.readdirSync(path.join(WEB, "pozadi"))) {       // kvíz volá pozadi/x.png, obsah je zmenšený JPEG
  write("pozadi/" + f.replace(/\.jpg$/, ".png"), fs.readFileSync(path.join(WEB, "pozadi", f)));
}
write(".nojekyll", "");

const total = new Set(quizzes.flatMap((q) => q.clips)).size;
console.log(`Ukázky: ${Object.keys(manifest.clips).length} z ${total} (${reused} beze změny)` + (missing.length ? `, chybí: ${missing.join(", ")}` : ""));
