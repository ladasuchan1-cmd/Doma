package cz.doma.recepty.data

import cz.doma.recepty.engine.TextUtil

/**
 * Převod uživatelského dotazu na výrazy pro SQLite FTS4 (tokenizer unicode61 s odstraněnou diakritikou).
 * „kuře rýže -smetana“ → match `kure* ryze*` (každé slovo musí být jako předpona v receptu)
 * a excludeMatch `smetana*` (recepty s tímto slovem se vyřadí). Používá se jen syntaxe společná
 * standardnímu i rozšířenému dotazovacímu jazyku FTS (implicitní AND, OR, předpona *).
 */
object SearchQuery {
    data class Parsed(val match: String?, val excludeMatch: String?, val terms: List<String>, val excluded: List<String>)

    fun parse(query: String?): Parsed {
        if (query.isNullOrBlank()) return Parsed(null, null, emptyList(), emptyList())
        val terms = mutableListOf<String>()
        val excluded = mutableListOf<String>()
        for (rawTok in query.split(Regex("[\\s,;]+"))) {
            if (rawTok.isEmpty()) continue
            val negative = rawTok.startsWith("-") || rawTok.startsWith("!")
            val cleaned = TextUtil.fold(rawTok).replace(Regex("[^a-z0-9]"), "")
            if (cleaned.length < 2) continue
            if (negative) excluded.add(cleaned) else terms.add(cleaned)
        }
        val match = if (terms.isEmpty()) null else terms.joinToString(" ") { "$it*" }
        val excludeMatch = if (excluded.isEmpty()) null else excluded.joinToString(" OR ") { "$it*" }
        return Parsed(match, excludeMatch, terms, excluded)
    }
}
