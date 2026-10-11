/* Propojení kvízu s aplikací: ukázky uložené v telefonu, listování prstem, uložená pozice a tlačítko Menu.
   Běží za původním skriptem kvízu a používá jeho proměnné (slides, idx, cur, go, load, render, MEDIA).
   V Android aplikaci mluví s window.KvizApp; ve webové verzi (kviz/webapp) bere ukázky z window.KVIZ_MEDIA
   (normalizovaný název → adresa) nebo je rozšifruje sifra.js, a Menu vede na stránku, kterou si menu uložilo. */
(function(){
  const app = window.KvizApp;
  const file = decodeURIComponent(location.pathname.split("/").pop());
  const PKEY = "kviz-pos:" + file;
  const info = document.getElementById("pickinfo");
  const plural = (n,a,b,c) => n===1 ? a : (n>=2 && n<=4 ? b : c);

  /* Tlačítko zpět do menu vlevo v hlavičce */
  const back = document.createElement("button");
  back.className = "appback";
  back.innerHTML = "<b>‹</b><span>Menu</span>";
  back.onclick = () => {
    if (app) return app.exitQuiz();
    let menu = "./";
    try { menu = localStorage.getItem("kviz-menu") || menu; } catch(e){}
    location.href = menu;
  };
  document.querySelector("#stage > header").prepend(back);

  /* Ukázky: místo výběru složky v prohlížeči se otevře výběr souborů v telefonu a aplikace si je uloží */
  document.getElementById("btnPick").textContent = "Ukázky";
  document.querySelectorAll('[data-err="folder"]').forEach(b => b.textContent = "Načíst ukázky");
  document.querySelectorAll(".err > div").forEach(d => { if (d.firstChild) d.firstChild.textContent = app ? "Ukázka zatím není v telefonu. " : "Ukázka tu zatím není. "; });
  if (window.KVIZ_MEDIA) Object.entries(window.KVIZ_MEDIA).forEach(([k, url]) => { MEDIA[k] = {url, name: k}; });
  const pick = document.getElementById("pick"), one = document.getElementById("pickone");
  if (app) {
    pick.click = () => app.importFiles();
    one.click = () => { const s = slides[+one.dataset.slide]; if (s && s.it) app.pickClip(s.it.f[0]); };
  }
  // Soubory jsou v telefonu, takže chybějící ukázka se pozná hned po otevření snímku, ne až po Přehrát.
  document.querySelectorAll("video").forEach(v => v.preload = "metadata");

  /* Po nahrání nových ukázek se snímky s videem načtou znovu (aktuální hned, ostatní při zobrazení) */
  const stale = new Set();
  function refreshCurrent(){
    if (stale.has(idx) && cur().kind === "m") { stale.delete(idx); load(cur(), true); }
  }
  function resetMedia(){
    slides.forEach((s,i) => { const v = s.kind === "m" && s.node.querySelector("video"); if (v && v.dataset.bound) stale.add(i); });
    refreshCurrent();
  }

  const myLabels = [];
  BLOCKS.forEach(b => b.forEach(r => r.items.forEach((it,i) => { if (it.t === "m") myLabels.push(`${r.name} ${i+1} · ${it.f[0]}`); })));
  const fmt = n => n >= 1048576 ? (n/1048576).toFixed(1).replace(".", ",") + " MB" : Math.round(n/1024) + " kB";
  let hideT = null;
  function say(text, autoHide){
    info.hidden = false; info.textContent = text;
    clearTimeout(hideT);
    if (autoHide) hideT = setTimeout(() => { info.hidden = true; }, 9000);
  }
  window.kvizProgress = p => {
    if (p.message) return say(p.message);
    const part = p.size > 0 ? Math.min(100, Math.round(p.done / p.size * 100)) + " %" : fmt(p.done);
    say(`Kopíruji ukázku ${p.index} z ${p.count}: ${p.name} · ${part}`);
  };
  window.kvizImportDone = r => {
    if (r.error) say("Ukázky se nepodařilo načíst: " + r.error);
    else if (r.deleted) say("Ukázky jsou smazané.", true);
    else {
      const n = r.copied.length;
      let t = n ? `Nahráno ${n} ${plural(n,"ukázka","ukázky","ukázek")}.`
                : (r.kept ? "Vybrané ukázky už v aplikaci jsou." : "Ve vybraných souborech není žádná ukázka z kvízů.");
      if (r.failed.length) t += ` ${r.failed.length} se nepodařilo zkopírovat (${r.failed[0].error}).`;
      const miss = myLabels.filter(l => r.missing.includes(l)).length;
      t += miss ? ` V tomto kvízu ještě chybí ${miss} z ${myLabels.length}.` : " Všechny ukázky tohoto kvízu jsou připravené.";
      say(t, true);
    }
    resetMedia();
  };
  if (app && app.busy()) say("Ukázky se nahrávají…");

  /* Listování přejetím prstem (mimo tabulku skóre, která se posouvá do strany) */
  const mainEl = document.getElementById("main");
  let sx = 0, sy = 0, st = 0, track = false;
  mainEl.addEventListener("touchstart", e => {
    track = e.touches.length === 1 && !e.target.closest("input,.scorebox");
    if (track) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); }
  }, {passive:true});
  mainEl.addEventListener("touchend", e => {
    if (!track) return;
    track = false;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6 && Date.now() - st < 800) go(dx < 0 ? 1 : -1);
  }, {passive:true});

  /* Na dotykovém displeji místo kláves nápověda k tlačítkům */
  const keys = document.querySelector(".keys");
  if (keys && matchMedia("(hover:none)").matches) {
    keys.classList.add("touch");
    keys.innerHTML = [["přejetí prstem","další a zpět"],["Nápověda","tři možnosti"],["Odpověď","řešení"],
                      ["Přehrát","ukázka nebo start času"],["S klipem","hudba i s obrazem"]]
      .map(([k,t]) => `<span class="key"><b>${k}</b> ${t}</span>`).join("");
  }

  /* Uložená pozice: kvíz pokračuje tam, kde skončil; #od-zacatku z menu začne znovu */
  const save = () => { try { localStorage.setItem(PKEY, JSON.stringify({i: idx, n: slides.length})); } catch(e){} };
  const origRender = render;
  render = function(){ origRender(); mainEl.scrollTop = 0; refreshCurrent(); save(); };
  if (location.hash === "#od-zacatku") { history.replaceState(null, "", location.pathname); idx = 0; }
  else {
    try { const p = JSON.parse(localStorage.getItem(PKEY) || "null"); if (p && p.i > 0 && p.i < slides.length) idx = p.i; } catch(e){}
  }
  render();
})();
