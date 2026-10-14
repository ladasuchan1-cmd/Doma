'use strict';
// Falešné „ssh“ pro test tools/qlever-pres-ssh.js: poslední argument je vzdálený příkaz. Na statistiky vrátí
// JSON s popisem indexu, na dotaz CSV s délkou těla, které přišlo stdinem. FALESNE_SSH_CHYBA=1 → po kousku
// výstupu skončí chybou (jako přerušené spojení nebo HTTP chyba curl -f).
let body = '';
process.stdin.on('data', (d) => (body += d));
process.stdin.on('end', () => {
  const prikaz = process.argv[process.argv.length - 1];
  if (process.env.FALESNE_SSH_CHYBA === '1') {
    process.stdout.write('neuplny,vystup\n');
    process.exit(22);
  }
  if (prikaz.includes('cmd=stats')) process.stdout.write('{"name-index":"OpenStreetMap, PBF from https://planet.openstreetmap.org/pbf/planet-260921.osm.pbf"}');
  else process.stdout.write(`delka\n${body.length}\n`);
});
