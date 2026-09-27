'use strict';
// Sdílená pravidla životního cyklu návrhů cen mimo samotný běh přecenění.
//
// Návrh ceny je spočítaný z konkrétních vstupů (aktuální cena, nákupní cena, DPH, ruční min./max. cena, zámek, aktivita).
// Když se některý z nich změní (import katalogu, úprava v detailu produktu), otevřený návrh (pending / approved) je
// zastaralý: exportoval by cenu spočítanou ze staré báze a navíc by ji vydával se zavádějící „starou cenou“ a změnou v %.
// Takové návrhy proto zneplatníme (superseded) – další přecenění spočítá nový návrh z aktuálních údajů.

const CENT = 0.005;

/** Příznaky, které do návrhu přidává ruční cena (PATCH /proposals/:id) – při zrušení ruční ceny se zase odeberou. */
const MANUAL_FLAGS = Object.freeze(['manual', 'manual_below_cost', 'below_min', 'above_max', 'big_manual_change']);

/**
 * České popisky příznaků, které nepřidává výpočet ceny (engine/pricing.js FLAG_LABELS), ale lidská rozhodnutí:
 * ruční cena (API návrhů) a paměť běhu přecenění (engine/run.js).
 */
const HUMAN_FLAG_LABELS = Object.freeze({
  manual: 'ruční cena',
  manual_below_cost: 'ruční cena pod nákupní cenou',
  below_min: 'ruční cena pod minimální cenou produktu',
  above_max: 'ruční cena nad maximální cenou produktu',
  big_manual_change: 'ruční cena mění cenu o víc než 50 %',
  manual_carried: 'převzata ruční cena z předchozího návrhu',
  previously_rejected: 'stejnou cenu někdo nedávno zamítl',
});

/**
 * Otevřené (pending / approved) návrhy daných produktů → superseded.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Iterable<number>} productIds
 * @param {{keepPrice?: Map<number, number|null>}} [opts] keepPrice = product_id → nová aktuální cena produktu. Návrh, jehož
 *   cena k exportu (manual_price ?? new_price) se nové ceně rovná, zůstane: admin tu cenu už převzal a zpětný import
 *   katalogu (typicky z POHODY) ji jen potvrzuje – zneplatněním bychom ztratili možnost potvrdit převzetí (ack).
 * @returns {number} počet zneplatněných návrhů
 */
function supersedeOpen(db, productIds, opts = {}) {
  const ids = [...new Set([...(productIds || [])].map(Number).filter(Number.isInteger))];
  if (!ids.length) return 0;
  const keep = opts.keepPrice instanceof Map ? opts.keepPrice : null;
  let changes = 0;
  // po dávkách – json_each s desítkami tisíc id je v pořádku, ale nechceme obří parametry
  for (let i = 0; i < ids.length; i += 5000) {
    const chunk = ids.slice(i, i + 5000);
    if (!keep) {
      changes += Number(
        db
          .prepare("UPDATE proposals SET status = 'superseded' WHERE status IN ('pending', 'approved') AND product_id IN (SELECT value FROM json_each(?))")
          .run(JSON.stringify(chunk)).changes
      );
      continue;
    }
    const obj = {};
    for (const id of chunk) obj[id] = keep.has(id) ? keep.get(id) : null;
    changes += Number(
      db
        .prepare(
          `UPDATE proposals SET status = 'superseded'
           WHERE status IN ('pending', 'approved') AND EXISTS (
             SELECT 1 FROM json_each(?) j WHERE CAST(j.key AS INTEGER) = proposals.product_id
               AND (j.value IS NULL OR ABS(COALESCE(proposals.manual_price, proposals.new_price) - j.value) >= ${CENT}))`
        )
        .run(JSON.stringify(obj)).changes
    );
  }
  return changes;
}

module.exports = { supersedeOpen, MANUAL_FLAGS, HUMAN_FLAG_LABELS, CENT };
