# Podklad: subdomény půjčoven, hlavní doména musteru, TLS a limity

Stav ověřen 5. 10. 2026 (registr CZ.NIC přes RDAP a doménový prohlížeč, dokumentace Caddy, Let's Encrypt, Public Suffix List, hstspreload.org, Google Search Central, RFC 7489). Podklad pro [PLAN.md](../../PLAN.md), kap. 12 a 15. Zadání: každá půjčovna poběží na subdoméně musteru odvozené z názvu jejího stávajícího webu (Hotel U Tří dubů s webem `utridubu.cz` → `utridubu.<domena-musteru>`).

## 1. Hlavní doména: `pujcovna.cz` není k dispozici

`pujcovna.cz` je **registrovaná** (registr CZ.NIC, 5. 10. 2026): status active, držitel Jan Daniel, registrátor Web4U s.r.o. (od 4/2024), registrována 18. 5. 1998, expirace 10/2027, DNSSEC zapnuto, transfer lock. Na https://pujcovna.cz běží prázdná šablona katalogového portálu „Půjčovna.cz“ (menu Přihlášení/Katalog, prázdné sekce firem, © 2026), `www` vrací HTTP 503. Doména je držena 28 let a aktivně, byť nedokončeně, používána. Odkup nelze předpokládat → **s doménou nepočítat.**

Alternativy ve tvaru `<slug>.<domena>.cz`, dostupnost ověřena v registru CZ.NIC (RDAP 404 = neregistrovaná; kontrolní dotaz na obsazenou doménu vrátil 200 s daty):

| Stav | Domény |
|---|---|
| **Volné (10)** | **rezervacekol.cz**, kolapujcovna.cz, rezervujkolo.cz, rezervacekola.cz, rezervujkola.cz, rezervace-kol.cz, kolarezervace.cz, kolanapujceni.cz, pujcovnykola.cz, bikepujcovna.cz |
| Obsazené | pujcovnakol.cz (exp. 4/2028), pujcovna-kol.cz (5/2027), pujcovnykol.cz a pujcovny-kol.cz (3/2027, 1/2029), pujcovnakola.cz (8/2027), mojepujcovna.cz (5/2027), pujcsikolo.cz (reg. 12/2025), bikerent.cz (10/2027) |

**Doporučení:** zaregistrovat **`rezervacekol.cz`** jako primární (krátká, popisuje funkci, čte se dobře jako `utridubu.rezervacekol.cz`) a `kolapujcovna.cz` + `rezervujkolo.cz` jen jako přesměrování. Registrovat ihned (volné názvy mizí) a **na 3 a více let** – případný zápis na Public Suffix List vyžaduje expiraci více než 2 roky od podání. Konečný výběr názvu je na zadavateli; vše níže platí pro libovolnou z volných domén.

**Slug půjčovny:** z domény stávajícího webu (`utridubu.cz` → `utridubu`), povolené znaky `[a-z0-9-]`, 3–40 znaků, **jediná úroveň** (wildcard certifikát kryje jen první label). Rezervované slugy: `www`, `platform`, `stage`, `mail`, `bounce`, `demo-*`.

## 2. TLS: hybrid wildcard + on-demand

**1) Wildcard `*.rezervacekol.cz` + apex přes DNS-01** pro všechny půjčovny:
- Jeden certifikát → založení půjčovny bez čekání na vydání při prvním handshaku; limity Let's Encrypt nehrají roli (2 identifikátory; obnovy přes ARI jsou z limitů vyňaté, Caddy ≥ 2.8 ARI umí); subdomény nepotřebují `ask`; port 80 není pro challenge nutný.
- **Názvy půjčoven se nezveřejní v CT lozích** – Let's Encrypt posílá každý certifikát do Certificate Transparency, takže per-host certifikáty = veřejný seznam našich klientů na crt.sh.
- Cena: vlastní build Caddy (`caddy:2-builder` + `xcaddy build --with github.com/caddy-dns/<poskytovatel>`, připnuté verze, Dependabot) a DNS API klíč na serveru.
- Minimalizace rizika klíče: **Cloudflare jen jako DNS (šedý mrak), token omezený na zónu `Zone:Read` + `DNS:Edit`**; alternativně Hetzner DNS (plugin `hetzner/v2`, zóna v samostatném projektu); nejlépe **delegovat `_acme-challenge` CNAME do oddělené zóny** (`dns_challenge_override_domain`, pluginy `acmedns` / `desec` / `rfc2136`), aby klíč na serveru nemohl měnit ostré DNS. WEDOS plugin chce jméno a heslo celého účtu – nepoužít; Active24/Forpsi plugin nemají – řešit delegací.
- Caddy ≥ 2.10 použije wildcard automaticky i pro bloky `foo.rezervacekol.cz`.

**2) On-demand TLS jen pro vlastní domény půjčoven** (po pilotu, volitelně): `on_demand_tls { ask http://app:3000/api/tls-ask }` – Caddy pošle GET `?domain=`, odpověď 2xx = povolit (z `platform.db`, v milisekundách), jinak handshake selže; `interval/burst` jsou zastaralé. Hlídat limity LE: 5 duplicitních certifikátů / 7 dní (Caddy storage na trvalém volume), 5 neúspěšných validací / identifikátor / hodinu (doménu zapnout až po ověření DNS), 300 objednávek / účet / 3 h.

**Proč ne čistě on-demand:** 50 certifikátů na registrovanou doménu za 7 dní (počítáno podle PSL) = max ~45 nových půjčoven týdně, pomalejší první načtení a veřejný seznam klientů v CT. Proto hybrid.

## 3. Izolace subdomén a bezpečnostní hlavičky

- Všechny cookies **`__Host-`** (Secure, bez `Domain`, `Path=/`) → platí jen pro daný host, žádné přetékání mezi půjčovnami; admin `SameSite=Strict`, veřejná část `Lax`; `/platform` na vlastním hostu `platform.rezervacekol.cz`.
- **Public Suffix List teď nezapisovat:** pravidla odmítají malé/nové projekty i žádosti motivované limity LE, vyžadují expiraci domény > 2 roky a `_psl` TXT záznam, bez SLA, propagace do prohlížečů trvá měsíce (rollback také). Hlavní přínos PSL (ochrana před cizím kódem na sousední subdoméně) u nás odpadá – vše servíruje náš kód. Přesto apex bez cookies a marketing na `www`, aby šel zápis doplnit později.
- **HSTS:** `max-age` 300 → týden → měsíc → `31536000; includeSubDomains`; `preload` až po pilotu a vědomě (hstspreload.org preload nedoporučuje, odstranění trvá měsíce, vyžaduje HTTPS na všech subdoménách včetně `www`).
- CAA záznam `letsencrypt.org`, DNSSEC u registrátora.

## 4. SEO a provoz

- Každá půjčovna = vlastní host: absolutní self-referencing `rel=canonical`, `robots.txt` a `sitemap.xml` generované per host (sitemapa platí jen pro svůj host); jedna **Domain property** v Google Search Console (DNS TXT) pokryje všechny subdomény, půjčovně lze dát URL-prefix property; demo/stage `noindex`.
- DNS: `A/AAAA` apex + `*.rezervacekol.cz` → VPS (konkrétní záznamy `mail`, `platform` mají přednost), nízké TTL při startu.
- Vlastní doména půjčovny později: `www` → CNAME `<slug>.rezervacekol.cz`, apex → A/AAAA (CNAME na apexu nelze), 301 ze subdomény.
- **E-mail** z musteru: From `<slug>@mail.rezervacekol.cz` se jménem půjčovny, `Reply-To` půjčovna; DKIM `d=rezervacekol.cz`; SPF se nedědí → TXT na každém odesílacím hostu (volitelně `*.rezervacekol.cz TXT "v=spf1 -all"`); DMARC na apexu `p=reject; sp=reject; adkim=r; aspf=r; rua=…` (relaxed zarovnání = organizační doména, `sp` pokryje subdomény); vlastní odesílací doménu půjčovny až po ověření u poskytovatele e-mailů (Gmail u hromadných odesílatelů vyžaduje DMARC a zarovnání).

## 5. Dopad na plán

- Fáze 0: zadavatel vybere a zaregistruje hlavní doménu (doporučení `rezervacekol.cz`, 3+ roky), založí DNS u poskytovatele s API vhodným pro DNS-01 (Cloudflare DNS-only nebo Hetzner DNS, nebo delegace `_acme-challenge`).
- Fáze 1: vlastní image Caddy s DNS pluginem, wildcard certifikát, `__Host-` cookies, HSTS postupně.
- Po pilotu: on-demand TLS pro vlastní domény půjčoven, zvážit HSTS preload a PSL.

## Zdroje

- Registr: https://www.nic.cz/whois/domain/pujcovna.cz/ · https://rdap.nic.cz/domain/pujcovna.cz · https://rdap.nic.cz/domain/rezervacekol.cz · https://rdap.nic.cz/domain/kolapujcovna.cz · https://rdap.nic.cz/domain/rezervujkolo.cz · https://pujcovna.cz
- Caddy: https://caddyserver.com/docs/automatic-https · https://caddyserver.com/docs/caddyfile/options · https://caddyserver.com/docs/caddyfile/directives/tls · https://caddyserver.com/docs/caddyfile/patterns · https://github.com/caddyserver/caddy/releases/tag/v2.8.0 · https://github.com/orgs/caddy-dns/repositories · https://github.com/caddy-dns/cloudflare · https://github.com/caddy-dns/hetzner · https://github.com/caddy-dns/wedos · https://github.com/caddy-dns/acmedns · https://github.com/caddy-dns/rfc2136 · https://github.com/caddy-dns/desec · https://caddy.community/t/mixing-wildcard-certificate-with-on-demand-feature/12280
- Let's Encrypt: https://letsencrypt.org/docs/rate-limits/ · https://letsencrypt.org/docs/challenge-types/ · https://letsencrypt.org/docs/ct-logs/
- PSL a HSTS: https://publicsuffix.org/submit/ · https://github.com/publicsuffix/list/wiki/Guidelines · https://hstspreload.org/ · https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie
- DNS a e-mail: https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/ · https://community.hetzner.com/tutorials/letsencrypt-dns/ · https://support.google.com/a/answer/81126 · https://www.rfc-editor.org/rfc/rfc7489.html
- SEO: https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap · https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls · https://support.google.com/webmasters/answer/34592
