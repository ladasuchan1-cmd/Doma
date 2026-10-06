#!/bin/sh
# Vstupní bod kontejneru Půjčovny kol. Vstupy: proměnné prostředí PK_* (SPEC kap. 3), navíc:
#   PK_SEED_DEMO   1 (výchozí) = v demo režimu před startem naplnit demo data (tools/demo-data.js je idempotentní:
#                  typy kol a ceník upsertuje, rezervace přidá jen do prázdné tabulky); 0 = nenaplňovat
#   PK_SEED_RESET  1 = při startu demo data smazat a naplnit znovu (--reset); výchozí 0
# Výstup: běžící server (node server.js) jako PID 1 (exec), aby mu Docker doručil SIGTERM při zastavení.
set -eu

cd /app

if [ "${PK_DEMO:-1}" = "1" ] && [ "${PK_SEED_DEMO:-1}" = "1" ]; then
  echo "Demo režim: naplňuji demo data (idempotentně${PK_SEED_RESET:+, s resetem})…"
  if [ "${PK_SEED_RESET:-0}" = "1" ]; then
    node --disable-warning=ExperimentalWarning tools/demo-data.js --reset || echo "VAROVÁNÍ: demo data se nepodařilo naplnit – server startuje bez nich." >&2
  else
    node --disable-warning=ExperimentalWarning tools/demo-data.js || echo "VAROVÁNÍ: demo data se nepodařilo naplnit – server startuje bez nich." >&2
  fi
fi

exec node --disable-warning=ExperimentalWarning server.js "$@"
