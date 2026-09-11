/*
 * Sdílené seznamy klíčových slov (čeština, slovenština, angličtina, němčina).
 * Načítá se jako globál v content skriptu i ve service workeru (importScripts)
 * a jako CommonJS modul v testech.
 */
(function (root) {
  'use strict';

  // Názvy dokumentů, které chceme číst.
  const DOCUMENT_TITLES = [
    // čeština / slovenština
    'obchodní podmínky', 'obchodné podmienky', 'všeobecné podmínky', 'všeobecné obchodní podmínky',
    'všeobecné obchodné podmienky', 'smluvní podmínky', 'zmluvné podmienky', 'podmínky užití',
    'podmínky používání', 'podmienky používania', 'podmínky služby', 'podmínky členství',
    'licenční podmínky', 'licenční ujednání', 'licenčná zmluva', 'licenční smlouva',
    'zásady ochrany osobních údajů', 'ochrana osobních údajů', 'ochrana osobných údajov',
    'zásady zpracování osobních údajů', 'zpracování osobních údajů', 'informace o zpracování',
    'zásady používání cookies', 'zásady cookies', 'reklamační řád', 'reklamačný poriadok',
    'pravidla užívání', 'pravidla služby', 'podmínky předplatného', 'předplatné',
    // angličtina
    'terms of service', 'terms of use', 'terms and conditions', 'terms & conditions',
    'terms of sale', 'subscription terms', 'end user license agreement', 'end-user license agreement',
    'eula', 'license agreement', 'licence agreement', 'privacy policy', 'privacy notice',
    'privacy statement', 'data processing', 'cookie policy', 'user agreement', 'service agreement',
    'membership terms', 'acceptable use policy', 'legal terms', 'refund policy', 'return policy',
    // němčina
    'allgemeine geschäftsbedingungen', 'agb', 'nutzungsbedingungen', 'datenschutzerklärung',
    'datenschutz', 'lizenzvereinbarung', 'widerrufsbelehrung',
  ];

  // Krátké tokeny, které se objevují v URL dokumentů.
  const URL_TOKENS = [
    'obchodni-podminky', 'obchodni_podminky', 'obchodnipodminky', 'podminky', 'podmienky', 'vop',
    'smluvni-podminky', 'licencni', 'gdpr', 'ochrana-osobnich-udaju', 'osobni-udaje', 'osobnich-udaju',
    'soukromi', 'terms', 'tos', 'terms-of-service', 'terms-of-use', 'termsofservice', 'legal',
    'eula', 'license', 'licence', 'privacy', 'privacy-policy', 'privacypolicy', 'datenschutz',
    'agb', 'nutzungsbedingungen', 'conditions', 'cookies', 'cookie-policy', 'refund', 'reklamace',
    'reklamacni-rad', 'subscription-terms',
  ];

  // Slova typická pro právní text (měří „hustotu“ právního textu).
  const LEGAL_DENSITY_WORDS = [
    'smlouv', 'smluvn', 'zmluv', 'uživatel', 'užívateľ', 'poskytovatel', 'poskytovateľ', 'prodávající',
    'kupující', 'spotřebitel', 'spotrebiteľ', 'objednávk', 'odstoupen', 'odstúpen', 'výpověď',
    'výpoved', 'ustanoven', 'odpovědnost', 'zodpovednosť', 'osobní údaj', 'osobné údaj', 'zpracován',
    'spracúvan', 'souhlas', 'súhlas', 'práva a povinnosti', 'reklamac', 'licenc', 'předplatn',
    'the user', 'the customer', 'the company', 'we may', 'you agree', 'you acknowledge', 'liability',
    'warranty', 'terminate', 'termination', 'personal data', 'third part', 'governing law',
    'jurisdiction', 'arbitration', 'subscription', 'refund', 'indemnif', 'intellectual property',
    'der nutzer', 'haftung', 'kündigung', 'vertrag', 'personenbezogene daten',
  ];

  // Kontext, kdy se podmínky obvykle akceptují: nákup, registrace, instalace.
  const CONSENT_CONTEXT = {
    checkout: [
      'pokladna', 'objednávka', 'objednavka', 'dokončit objednávku', 'dokončení objednávky',
      'závazně objednat', 'objednat a zaplatit', 'zaplatit', 'platba', 'způsob platby', 'doprava a platba',
      'nákupní košík', 'checkout', 'place order', 'complete purchase', 'pay now',
      'payment', 'billing', 'buy now', 'kasse', 'warenkorb', 'zahlung', 'jetzt kaufen',
      'předplatit', 'předplatné', 'subscribe', 'start free trial', 'zkušební verze', 'zkušební období',
      'vyzkoušet zdarma', 'aktivovat předplatné', 'upgrade', 'zvolit tarif', 'choose plan',
    ],
    signup: [
      'registrace', 'registrovat', 'zaregistrovat', 'vytvořit účet', 'vytvorit ucet', 'založit účet',
      'nový účet', 'sign up', 'signup', 'create account', 'create an account', 'register', 'join now',
      'get started', 'registrieren', 'konto erstellen', 'vytvoriť účet', 'zaregistrovať',
    ],
    install: [
      'instalovat', 'nainstalovat', 'install', 'add to chrome', 'přidat do chromu', 'přidat do prohlížeče',
      'add extension', 'download', 'stáhnout', 'stiahnuť', 'get the app', 'získat aplikaci',
      'installieren', 'herunterladen',
    ],
    agree: [
      'souhlasím s', 'souhlasim s', 'souhlasíte s', 'seznámil jsem se', 'přečetl jsem', 'beru na vědomí',
      'akceptuji', 'accept', 'i agree', 'i have read', 'agree to', 'by continuing', 'by signing up',
      'by clicking', 'by creating an account', 'ich stimme', 'ich akzeptiere', 'súhlasím',
    ],
  };

  // Tokeny v URL, které samy o sobě značí pokladnu / registraci / instalaci.
  const URL_CONTEXT_TOKENS = {
    checkout: ['kosik', 'cart', 'basket', 'checkout', 'pokladna', 'objednavka', 'order', 'platba', 'payment', 'billing', 'subscribe', 'predplatne', 'pricing', 'cenik', 'plans', 'upgrade', 'kasse', 'warenkorb'],
    signup: ['registrace', 'register', 'signup', 'sign-up', 'join', 'create-account', 'ucet', 'account', 'registrieren'],
    install: ['install', 'download', 'stahnout', 'detail', 'apps', 'app', 'store', 'extension', 'addon'],
  };

  // Domény obchodů s aplikacemi / rozšířeními – vždy „instalační“ kontext.
  const STORE_HOSTS = [
    'chromewebstore.google.com', 'chrome.google.com', 'addons.mozilla.org', 'microsoftedge.microsoft.com',
    'play.google.com', 'apps.apple.com', 'apps.microsoft.com', 'www.microsoft.com', 'store.steampowered.com',
    'addons.opera.com', 'marketplace.visualstudio.com', 'snapcraft.io', 'flathub.org',
  ];

  // Skupiny klíčových slov pro offline (heuristickou) analýzu.
  const RISK_GROUPS = [
    {
      id: 'sdileni_treti_strany',
      category: 'treti_strany',
      severity: 'kriticke',
      title: 'Předávání údajů třetím stranám',
      patterns: [
        /(předá|poskyt|sdíl|zpřístupn|prod[áa])\w*\s+[^.]{0,80}?(třetí(m|ch)?\s+stran|partner|obchodní(m|ch)?\s+partner|zprostředkovatel)/i,
        /(share|disclose|transfer|sell|provide|rent|license)\w*\s+[^.]{0,80}?(third[- ]part|partners|affiliates|advertisers|data brokers)/i,
        /(weitergabe|weitergeben|übermitt)\w*\s+[^.]{0,80}?(dritte|partner)/i,
        /(third[- ]part(y|ies)|třetí(m|ch)?\s+stran\w*|tretí(m|ch)?\s+stran\w*)\s+[^.]{0,60}?(data|údaj|informa)/i,
      ],
    },
    {
      id: 'prodej_udaju',
      category: 'treti_strany',
      severity: 'kriticke',
      title: 'Prodej nebo zpeněžení osobních údajů',
      patterns: [
        /(prod[áa]\w*|zpeněž\w*|monetiz\w*)\s+[^.]{0,60}?(osobní\w*\s+údaj|údaj|data)/i,
        /(sell|selling|sale of|monetize|monetise)\s+[^.]{0,60}?(personal (data|information)|your (data|information)|user data)/i,
      ],
    },
    {
      id: 'prenos_mimo_eu',
      category: 'data',
      severity: 'varovne',
      title: 'Přenos údajů mimo EU/EHP',
      patterns: [
        /(mimo|za hranice)\s+(eu|evropsk\w+\s+uni\w*|ehp|evropsk\w+\s+hospodářsk\w+\s+prostor)/i,
        /(outside|out of)\s+the\s+(eu|eea|european (union|economic area))/i,
        /(united states|usa|spojen\w+\s+stát\w*|drittländer|drittstaaten)/i,
        /(standard(ní|ních)?\s+smluvní\w*\s+doložk|standard contractual clauses|scc)/i,
      ],
    },
    {
      id: 'marketing_profilovani',
      category: 'data',
      severity: 'varovne',
      title: 'Marketing, profilování nebo sledování',
      patterns: [
        /(profilov|profiling|behaviou?ral|cílen\w+\s+reklam|targeted advertis|personali[sz]ed ads|interest-based)/i,
        /(obchodní sdělení|newsletter|marketingov\w+\s+(sdělení|účel|komunikac)|marketing (purposes|communications|emails))/i,
        /(sledov\w+|tracking|trackers|pixel\w*|fingerprint\w*|analytick\w+\s+nástroj|analytics)/i,
      ],
    },
    {
      id: 'citlive_udaje',
      category: 'data',
      severity: 'varovne',
      title: 'Zpracování citlivých údajů nebo přístup k zařízení',
      patterns: [
        /(biometri|zdravotn\w+\s+(údaj|stav)|health (data|information)|genetic|náboženstv|sexuál|political)/i,
        /(poloh\w+|location data|geolocation|gps)/i,
        /(kontakt\w+\s+v\s+(telefonu|zařízení)|address book|contacts list|mikrofon|microphone|kamer\w+|camera|fotogaleri|photo library)/i,
        /(rodné číslo|číslo občansk\w+\s+průkaz|social security number|číslo platební karty|card number|cvv)/i,
      ],
    },
    {
      id: 'automaticke_prodlouzeni',
      category: 'platby',
      severity: 'kriticke',
      title: 'Automatické prodlužování / opakované platby',
      patterns: [
        /(automatick\w+\s+(se\s+)?(prodlu|prodlou|obnov)|prodlužuje\s+se\s+automaticky|obnovuje\s+se\s+automaticky)/i,
        /(auto[- ]?renew\w*|automatically\s+renew\w*|renews\s+automatically|recurring\s+(billing|payment|charge)|continuous subscription)/i,
        /(automatisch\w*\s+verlänger\w*|verlängert sich automatisch)/i,
        /(opakovan\w+\s+platb|pravideln\w+\s+strháv|strhávat\s+[^.]{0,40}?(karty|účtu)|charged\s+[^.]{0,40}?(each|every)\s+(month|year)|will be charged)/i,
      ],
    },
    {
      id: 'zkusebni_obdobi',
      category: 'platby',
      severity: 'varovne',
      title: 'Zkušební období, které přechází v placené',
      patterns: [
        /(zkušební\w*\s+(období|verz|doba|lhůt)|trial\s+(period|version)|free trial|probezeit|testphase)[^.]{0,120}?(po\s+(jeho\s+|jejím\s+|jejího\s+)?(skončení|uplynutí)|after|following|ends|expir|zpoplatn|charged|automatick|converts)/i,
        /(po\s+(jeho\s+|jejím\s+)?(skončení|uplynutí)[^.]{0,60}?(zkušební|trial)[^.]{0,80}?(zpoplatn|účtov|platb|charge|bill))/i,
      ],
    },
    {
      id: 'sankce_poplatky',
      category: 'platby',
      severity: 'varovne',
      title: 'Smluvní pokuty, storno nebo dodatečné poplatky',
      patterns: [
        /(smluvní\w*\s+pokut|storno\w*\s+poplat|stornopoplat|penál|úrok\w*\s+z\s+prodlení|poplatek za (předčasné|zrušení|ukončení))/i,
        /(cancellation fee|early termination fee|termination fee|late fee|penalt(y|ies)|restocking fee|chargeback fee|non-refundable|nevratn)/i,
        /(vertragsstrafe|stornogebühr|mahngebühr)/i,
      ],
    },
    {
      id: 'zmena_cen',
      category: 'platby',
      severity: 'varovne',
      title: 'Poskytovatel může jednostranně měnit ceny',
      patterns: [
        /(změn\w+\s+(cen|ceník|výš\w+\s+poplatk)|upravit\s+cen|cen\w+\s+(se\s+)?m[ůu]že\w*\s+(měnit|změnit))/i,
        /(change|modify|adjust|increase)\s+[^.]{0,40}?(price|prices|pricing|fees|subscription fee)/i,
        /(preisänderung|preise\s+ändern)/i,
      ],
    },
    {
      id: 'jednostranna_zmena',
      category: 'prava',
      severity: 'varovne',
      title: 'Jednostranná změna podmínek bez souhlasu',
      patterns: [
        /(jednostrann\w+|kdykoli\w*)\s+[^.]{0,60}?(změnit|měnit|upravit|doplnit)\s+[^.]{0,40}?(podmínk|smlouv|pravidl)/i,
        /(vyhrazuje\w*\s+si\s+právo\s+[^.]{0,40}?(změnit|měnit|upravit))/i,
        /(reserve\w*\s+the\s+right\s+to\s+(change|modify|amend|update|alter)|may\s+(change|modify|amend|update)\s+(these\s+)?terms|at\s+any\s+time\s+without\s+(prior\s+)?notice|without notice)/i,
        /(bez\s+(předchozího\s+)?(upozornění|oznámení|souhlasu))/i,
        /(jederzeit\s+ändern|ohne vorherige ankündigung)/i,
      ],
    },
    {
      id: 'licence_obsah',
      category: 'prava',
      severity: 'varovne',
      title: 'Široká licence k vašemu obsahu / vzdání se práv',
      patterns: [
        /(neodvolateln\w+|neomezen\w+|celosvětov\w+|bezplatn\w+|časově neomezen\w+)\s+[^.]{0,60}?(licenc|oprávnění|práv)/i,
        /(irrevocable|perpetual|worldwide|royalty[- ]free|sublicensable|transferable)\s+[^.]{0,60}?(licen[cs]e|right)/i,
        /(vzdáv\w+\s+se\s+(práv|nárok)|waive\w*\s+[^.]{0,30}?(right|claim)|class action waiver|hromadn\w+\s+žalob)/i,
      ],
    },
    {
      id: 'rozhodci_soud',
      category: 'prava',
      severity: 'varovne',
      title: 'Rozhodčí řízení nebo cizí právo / soud',
      patterns: [
        /(rozhodčí\w*\s+(řízení|doložk|soud)|rozhodc\w+)/i,
        /(binding\s+arbitration|arbitration|schiedsgericht)/i,
        /(řídí\s+se\s+(právem|zákony)\s+(státu\s+)?(delaware|kalifornie|california|irska|ireland|anglie|england|usa)|governed\s+by\s+the\s+laws\s+of\s+(the\s+state\s+of\s+)?(delaware|california|new york|england|ireland|singapore|texas|washington))/i,
        /(exclusive\s+jurisdiction|výlučn\w+\s+(příslušnost|pravomoc)\s+soud)/i,
      ],
    },
    {
      id: 'vylouceni_odpovednosti',
      category: 'odpovednost',
      severity: 'info',
      title: 'Omezení nebo vyloučení odpovědnosti poskytovatele',
      patterns: [
        /(neodpovídá|nenese\s+(žádnou\s+)?odpovědnost|vylučuje\w*\s+(svou\s+)?odpovědnost|odpovědnost\s+[^.]{0,30}?(je\s+)?(omezen|vyloučen))/i,
        /(not\s+(be\s+)?liable|no\s+liability|disclaim\w*\s+(all\s+)?(warranties|liability)|as[- ]is|without\s+warrant(y|ies)|limitation\s+of\s+liability)/i,
        /(haftung\w*\s+(ausgeschlossen|beschränkt)|keine haftung)/i,
        /(jak\s+stojí\s+a\s+leží)/i,
      ],
    },
    {
      id: 'ukonceni_uctu',
      category: 'prava',
      severity: 'varovne',
      title: 'Poskytovatel může kdykoli zrušit účet nebo smazat data',
      patterns: [
        /(zrušit|zablokovat|pozastavit|ukončit|smazat)\s+[^.]{0,40}?(účet|přístup|uživatelský\w*\s+účet)\s+[^.]{0,60}?(kdykoli|bez\s+(udání\s+důvodu|předchozího|náhrady|upozornění))/i,
        /(terminate|suspend|delete|disable)\s+[^.]{0,40}?(your\s+)?(account|access)\s+[^.]{0,60}?(at\s+any\s+time|without\s+(notice|cause|reason|refund)|for\s+any\s+reason|sole\s+discretion)/i,
      ],
    },
    {
      id: 'sledovani_deti',
      category: 'data',
      severity: 'info',
      title: 'Zmínka o nezletilých uživatelích',
      patterns: [
        /(nezletil|mladší\s+(13|15|16|18)\s+let|osob\w+\s+(mladší|do)\s+\d+\s+let)/i,
        /(under\s+(the\s+age\s+of\s+)?(13|16|18)|minors|children)/i,
      ],
    },
    {
      id: 'uchovavani_udaju',
      category: 'data',
      severity: 'info',
      title: 'Doba uchovávání údajů',
      patterns: [
        /(uchov\w+|ulož\w+|archivov\w+)\s+[^.]{0,60}?(po\s+dobu|do\s+doby|\d+\s+(let|roky|rok|měsíc))/i,
        /(retain\w*|retention|store\w*)\s+[^.]{0,60}?(for\s+(a\s+period\s+of\s+)?\d+|as\s+long\s+as|indefinitely)/i,
      ],
    },
  ];

  // Věty o zrušení smlouvy / předplatného.
  const CANCELLATION_PATTERNS = [
    /(zruš\w+|zrušen\w*|výpov[ěe]\w+|vypověd\w+|odstoup\w+|odstúp\w+|ukonč\w+\s+(smlouv|předplatn|služb|členstv)|storn\w+|vrácen\w+\s+(peněz|platby|zboží)|vrátit\s+(zboží|peníze)|lhůt\w+\s+(pro|k)\s+odstoupení|14\s*(dní|dnů|denní))/i,
    /(cancel\w*|cancellation|terminat\w+|withdraw\w*|withdrawal|unsubscrib\w*|refund\w*|money[- ]back|return\s+(the\s+)?(product|goods|item)|cooling[- ]off|notice\s+period)/i,
    /(kündig\w+|widerruf\w*|rücktritt|stornier\w+|erstattung)/i,
  ];

  const AUTO_RENEWAL_PATTERNS = [
    /(automatick\w+\s+(se\s+)?(prodlu|prodlou|obnov)|prodlužuje\s+se\s+automaticky|obnovuje\s+se\s+automaticky)/i,
    /(auto[- ]?renew\w*|automatically\s+renew\w*|renews\s+automatically|recurring\s+(billing|payment|charge))/i,
    /(automatisch\w*\s+verlänger\w*|verlängert sich automatisch)/i,
  ];

  const NOTICE_PERIOD_PATTERNS = [
    /(výpovědní\w*\s+(lhůt|dob)\w*\s+[^.]{0,40}?(\d+)\s*(dn|den|dní|týd|měs|rok))/i,
    /((\d+)\s*(dn[íůiy]|den|týdn\w*|měsíc\w*|rok\w*)\s+(před|přede\s+dnem|do\s+konce)\s+[^.]{0,40}?(obnov|prodlou|zúčtovac|fakturač|období))/i,
    /(notice\s+(period\s+)?of\s+(at\s+least\s+)?(\d+)\s*(day|week|month)|(\d+)\s*(days?|weeks?|months?)['’]?\s*(prior\s+)?notice|at\s+least\s+(\d+)\s*(days?|hours?)\s+before)/i,
    /(kündigungsfrist\s+[^.]{0,30}?(\d+)\s*(tag|woche|monat))/i,
  ];

  const CANCEL_HOW_PATTERNS = [
    /(v\s+nastavení\s+(účtu|profilu|předplatného)|v\s+(uživatelském\s+)?účtu|v\s+aplikaci|v\s+sekci\s+[^.]{0,30}|přes\s+(zákaznick\w+\s+)?(podporu|linku)|e-?mailem\s+na\s+[^\s.,;]+@[^\s.,;]+\.\w+|na\s+(adres[eu]|e-?mail)\s+[^\s.,;]+@[^\s.,;]+\.\w+|písemně|doporučen\w+\s+dopis|telefonicky\s+na\s+[^.]{0,30}|formulář\w*\s+(pro|k)\s+odstoupení)/i,
    /(in\s+(your\s+)?account\s+settings|from\s+your\s+account|in\s+the\s+app|through\s+(the\s+)?(app store|google play|customer (support|service))|by\s+contacting\s+[^.]{0,60}|by\s+emailing\s+[^\s.,;]+@[^\s.,;]+\.\w+|email\s+(us\s+)?at\s+[^\s.,;]+@[^\s.,;]+\.\w+|in\s+writing|manage\s+(your\s+)?subscription|subscription\s+(page|settings))/i,
  ];

  // Ceny.
  const CURRENCY_RE = /(?:(?:kč|czk|€|eur|\$|usd|£|gbp|zł|pln|chf|huf|ft)\s?\d{1,3}(?:[ . ]?\d{3})*(?:[.,]\d{1,2})?|\d{1,3}(?:[ . ]?\d{3})*(?:[.,]\d{1,2})?\s?(?:,-|kč|czk|€|eur|\$|usd|£|gbp|zł|pln|chf|korun\w*|eur\w*|dolar\w*))/gi;
  const PERIOD_PATTERNS = [
    { re: /(měsíčn|za\s+měsíc|\/\s*měs|\/\s*mo\b|per\s+month|monthly|a\s+month|\/\s*month|pro\s+monat|monatlich)/i, period: 'měsíčně' },
    { re: /(ročn|za\s+rok|\/\s*rok|per\s+year|yearly|annual|\/\s*yr|\/\s*year|jährlich|pro\s+jahr)/i, period: 'ročně' },
    { re: /(týdn|weekly|per\s+week|\/\s*week|wöchentlich)/i, period: 'týdně' },
    { re: /(denn|daily|per\s+day|\/\s*day|täglich)/i, period: 'denně' },
    { re: /(jednorázov|one[- ]time|one[- ]off|einmalig)/i, period: 'jednorázově' },
  ];

  const PRICE_KIND_PATTERNS = [
    { re: /(doprav|doručen|poštovn|shipping|delivery|versand)/i, kind: 'doprava' },
    { re: /(poplat|fee|gebühr)/i, kind: 'poplatek' },
    { re: /(pokut|penalt|storno|vertragsstrafe)/i, kind: 'pokuta / storno' },
    { re: /(předplatn|subscription|tarif|plan|abonnement|abo\b)/i, kind: 'předplatné' },
    { re: /(zkušebn|trial)/i, kind: 'zkušební období' },
    { re: /(minimáln\w+\s+(hodnot|objedn)|minimum\s+(order|purchase))/i, kind: 'minimální objednávka' },
    { re: /(cena|price|preis|zaplat|platb|payment|charge)/i, kind: 'cena' },
  ];

  const API = {
    DOCUMENT_TITLES, URL_TOKENS, LEGAL_DENSITY_WORDS, CONSENT_CONTEXT, URL_CONTEXT_TOKENS, STORE_HOSTS,
    RISK_GROUPS, CANCELLATION_PATTERNS, AUTO_RENEWAL_PATTERNS, NOTICE_PERIOD_PATTERNS,
    CANCEL_HOW_PATTERNS, CURRENCY_RE, PERIOD_PATTERNS, PRICE_KIND_PATTERNS,
  };

  root.TermsKeywords = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : this);
