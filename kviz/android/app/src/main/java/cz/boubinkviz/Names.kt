package cz.boubinkviz

import java.text.Normalizer

/**
 * Párování souborů s ukázkami podle názvu – stejné pravidlo jako v kvízu (norm + fromPicked),
 * takže aplikace najde tytéž soubory jako kvíz v prohlížeči.
 */
object Names {
    private val marks = Regex("[\\u0300-\\u036f]")
    private val extension = Regex("\\.[a-z0-9]+$")
    private val nonAlnum = Regex("[^a-z0-9]")
    val MEDIA_EXT = Regex("\\.(mp4|m4v|webm|mov|mkv|mp3|m4a|ogg|wav)$", RegexOption.IGNORE_CASE)

    /** „TERMINÁTOR_2.mp4“ → „terminator2“ – bez diakritiky, přípony a všeho kromě písmen a číslic. */
    fun norm(s: String): String =
        Normalizer.normalize(s, Normalizer.Form.NFD).replace(marks, "").lowercase()
            .replace(extension, "").replace(nonAlnum, "")

    /** Podobnost jako ve fromPicked(): jeden název obsahuje druhý, nebo mají shodný začátek aspoň 10 znaků. */
    fun score(key: String, k: String): Int {
        if (key.contains(k) || k.contains(key)) return minOf(key.length, k.length)
        var i = 0
        while (i < key.length && i < k.length && key[i] == k[i]) i++
        return if (i >= 10) i else 0
    }

    class Match<T>(val item: T, val exact: Boolean)

    /**
     * Pro každý hledaný klip (klíč → varianty názvu) vybere nejlepší z nabízených souborů (název → položka).
     * Přesné shody mají přednost a jeden soubor se použije nejvýš jednou.
     */
    fun <T> assign(wanted: List<Pair<String, List<String>>>, offered: List<Pair<String, T>>): Map<String, Match<T>> {
        val byKey = LinkedHashMap<String, T>()
        offered.forEach { (name, item) -> byKey.putIfAbsent(norm(name), item) }
        val used = HashSet<String>()
        val out = LinkedHashMap<String, Match<T>>()
        for ((clip, names) in wanted) {
            val hit = names.map(::norm).firstOrNull { it in byKey && it !in used } ?: continue
            used += hit
            out[clip] = Match(byKey.getValue(hit), true)
        }
        for ((clip, names) in wanted) {
            if (clip in out) continue
            var best: String? = null
            var bestScore = 0
            for (k in names.map(::norm)) for (key in byKey.keys) {
                if (key in used) continue
                val s = score(key, k)
                if (s > bestScore) { bestScore = s; best = key }
            }
            if (best != null) {
                used += best
                out[clip] = Match(byKey.getValue(best), false)
            }
        }
        return out
    }
}

/** Hlavička Range pro přehrávání videa (přetáčení). */
object Ranges {
    private val bytes = Regex("^\\s*bytes\\s*=\\s*(\\d*)\\s*-\\s*(\\d*)")

    /** null = poslat celý soubor; prázdný rozsah = nesplnitelný požadavek (416). */
    fun parse(header: String?, len: Long): LongRange? {
        val m = bytes.find(header ?: return null) ?: return null
        val a = m.groupValues[1]
        val b = m.groupValues[2]
        if (a.isEmpty() && b.isEmpty()) return null
        if (a.isEmpty()) {
            val n = b.toLongOrNull() ?: return null
            return if (n <= 0 || len == 0L) LongRange.EMPTY else maxOf(0, len - n)..(len - 1)
        }
        val start = a.toLongOrNull() ?: return null
        if (start >= len) return LongRange.EMPTY
        val end = if (b.isEmpty()) len - 1 else minOf(b.toLongOrNull() ?: (len - 1), len - 1)
        return if (end < start) LongRange.EMPTY else start..end
    }
}
