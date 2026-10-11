/* Ukázky zašifrované heslem pro veřejný server (GitHub Pages).
   Z hesla se odvodí klíč (PBKDF2-SHA256), ukázky jsou AES-GCM. Heslo se nikam neukládá, v prohlížeči
   zůstane jen odvozený klíč. V menu odemyká (window.KvizSifra), v kvízu ukázku stáhne a rozšifruje až
   ve chvíli, kdy je potřeba, a předá ji kvízu přes jeho MEDIA. Popis dat: window.KVIZ_SIFRA z ukazky.js. */
(function(){
  const S = window.KVIZ_SIFRA;
  if (!S || !window.crypto || !crypto.subtle) return;
  const KEY = "kviz-klic";
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const decrypt = (key, iv, data) => crypto.subtle.decrypt({name: "AES-GCM", iv: b64(iv)}, key, data);
  const read = () => { try { return localStorage.getItem(KEY); } catch(e) { return null; } };
  const forget = () => { try { localStorage.removeItem(KEY); } catch(e) {} keyP = null; };

  let keyP = null;
  function storedKey(){
    if (!keyP) keyP = (async () => {
      const raw = read();
      return raw ? crypto.subtle.importKey("raw", b64(raw), "AES-GCM", false, ["decrypt"]).catch(() => null) : null;
    })();
    return keyP;
  }

  const cache = {};
  window.KvizSifra = {
    unlocked: () => !!read(),
    has: k => !!S.clips[k],
    async unlock(password){
      const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password.trim()), "PBKDF2", false, ["deriveKey"]);
      const key = await crypto.subtle.deriveKey({name: "PBKDF2", salt: b64(S.salt), iterations: S.iter, hash: "SHA-256"},
        base, {name: "AES-GCM", length: 256}, true, ["decrypt"]);
      try {
        if (new TextDecoder().decode(await decrypt(key, S.check.iv, b64(S.check.data))) !== "boubin") return false;
      } catch(e) { return false; }
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
      try { localStorage.setItem(KEY, btoa(String.fromCharCode(...raw))); } catch(e) {}
      keyP = Promise.resolve(key);
      return true;
    },
    /* Adresa (blob:) rozšifrované ukázky; chyba "locked" = chybí nebo nesedí heslo. */
    clip(k){
      if (!cache[k]) cache[k] = (async () => {
        const c = S.clips[k];
        if (!c) throw new Error("missing");
        const key = await storedKey();
        if (!key) throw new Error("locked");
        const r = await fetch(c.f);
        if (!r.ok) throw new Error("HTTP " + r.status);
        let data;
        try { data = await decrypt(key, c.iv, await r.arrayBuffer()); }
        catch(e) { forget(); throw new Error("locked"); }      // klíč z jiného hesla (web přestavěný s jiným heslem)
        return URL.createObjectURL(new Blob([data], {type: c.t}));
      })().catch(e => { delete cache[k]; throw e; });
      return cache[k];
    }
  };

  /* V kvízu: obal load/play/render z původního skriptu (slides, idx, cur, norm, MEDIA jsou jeho proměnné). */
  if (typeof slides === "undefined") return;
  const keyOf = s => s && s.kind === "m" ? norm(s.it.f[0]) : null;
  const ready = k => !!MEDIA[k];
  const waiting = k => k && S.clips[k] && !ready(k);
  const fetchClip = s => KvizSifra.clip(keyOf(s)).then(url => { MEDIA[keyOf(s)] = {url, name: keyOf(s)}; });
  const origLoad = load, origPlay = play, origRender = render;

  load = function(s, force){
    if (!waiting(keyOf(s))) return origLoad(s, force);
    const p = s.node.querySelector(".cover p"), text = p && p.textContent;
    if (p) p.textContent = "Načítám ukázku…";
    fetchClip(s).then(() => {
      if (p) p.textContent = text;
      origLoad(s, true);
      if ("queued" in s && cur() === s) { const v = s.queued; delete s.queued; origPlay(v); }
    }).catch(e => {
      if (p) p.textContent = text;
      delete s.queued;
      const d = s.node.querySelector(".err > div");
      if (e.message === "locked" && d && d.firstChild) d.firstChild.textContent = "Ukázky jsou zamčené heslem, zadej ho v menu. ";
      origLoad(s, force);                                     // nic nenajde a ukáže hlášku s tlačítky pro ruční výběr
    });
  };
  play = function(withVideo){
    const s = cur();
    if (waiting(keyOf(s))) { s.queued = withVideo; return; }  // pustí se samo, jakmile se ukázka rozšifruje
    origPlay(withVideo);
  };
  render = function(){
    origRender();
    for (let i = idx + 1, n = 0; i < slides.length && n < 2; i++) {   // dvě nejbližší ukázky si připraví dopředu
      if (!keyOf(slides[i])) continue;
      n++;
      if (waiting(keyOf(slides[i]))) fetchClip(slides[i]).catch(() => {});
    }
  };
})();
