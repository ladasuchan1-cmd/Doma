package cz.doma.recepty.engine

import org.json.JSONArray
import org.json.JSONObject
import java.text.Normalizer

/** Pomocné funkce pro text a HTML (bez závislostí na Androidu, aby šly testovat na JVM). */
object TextUtil {
    private val COMBINING = Regex("\\p{M}+")

    /** Malá písmena bez diakritiky: „Kuřecí Prsa“ → „kureci prsa“. */
    fun fold(s: String): String = COMBINING.replace(Normalizer.normalize(s, Normalizer.Form.NFD), "").lowercase()

    /** Slova (písmena a číslice) v textu, již složená bez diakritiky. */
    fun words(s: String): List<String> = Regex("[\\p{L}\\p{N}]+").findAll(fold(s)).map { it.value }.toList()

    /** Přečte hodnotu JSON řetězce `"key":"…"` z HTML/JS (např. shortDescription v YouTube stránce). */
    fun readJsonString(text: String, key: String, from: Int = 0): String? {
        val needle = "\"$key\":\""
        val at = text.indexOf(needle, from)
        if (at < 0) return null
        return readJsonStringLiteral(text, at + needle.length - 1)
    }

    /** Přečte JSON řetězcový literál začínající uvozovkou na pozici [start]. */
    fun readJsonStringLiteral(text: String, start: Int): String? {
        if (start >= text.length || text[start] != '"') return null
        val sb = StringBuilder()
        var i = start + 1
        while (i < text.length) {
            val c = text[i]
            when (c) {
                '"' -> return sb.toString()
                '\\' -> {
                    if (i + 1 >= text.length) return null
                    when (val e = text[i + 1]) {
                        'n' -> sb.append('\n'); 't' -> sb.append('\t'); 'r' -> sb.append('\r')
                        'b' -> sb.append('\b'); 'f' -> sb.append('\u000C')
                        'u' -> {
                            if (i + 5 < text.length) {
                                text.substring(i + 2, i + 6).toIntOrNull(16)?.let { sb.append(it.toChar()) }
                                i += 4
                            }
                        }
                        else -> sb.append(e)
                    }
                    i += 2
                }
                else -> { sb.append(c); i++ }
            }
        }
        return null
    }

    /** Najde JSON pole/objekt začínající na [start] (znak [ nebo {) a vrátí jeho text včetně závorek. */
    fun readJsonValue(text: String, start: Int): String? {
        if (start < 0 || start >= text.length) return null
        val open = text[start]
        val close = when (open) { '[' -> ']'; '{' -> '}'; else -> return null }
        var depth = 0
        var i = start
        var inStr = false
        while (i < text.length) {
            val c = text[i]
            if (inStr) {
                if (c == '\\') i++ else if (c == '"') inStr = false
            } else {
                when (c) {
                    '"' -> inStr = true
                    open -> depth++
                    close -> { depth--; if (depth == 0) return text.substring(start, i + 1) }
                }
            }
            i++
        }
        return null
    }

    fun decodeEntities(s: String): String {
        if (!s.contains('&')) return s
        return Regex("&(#x[0-9a-fA-F]+|#\\d+|[a-zA-Z]+);").replace(s) { m ->
            val e = m.groupValues[1]
            when {
                e.startsWith("#x") -> e.substring(2).toIntOrNull(16)?.let { String(Character.toChars(it)) } ?: m.value
                e.startsWith("#") -> e.substring(1).toIntOrNull()?.let { String(Character.toChars(it)) } ?: m.value
                else -> when (e.lowercase()) {
                    "amp" -> "&"; "lt" -> "<"; "gt" -> ">"; "quot" -> "\""; "apos" -> "'"; "nbsp" -> " "
                    "ndash" -> "–"; "mdash" -> "—"; "hellip" -> "…"; "deg" -> "°"; "frac12" -> "½"; "frac14" -> "¼"; "frac34" -> "¾"
                    else -> m.value
                }
            }
        }
    }

    /** HTML → prostý text s odřádkováním u blokových prvků. */
    fun htmlToText(html: String): String {
        var s = Regex("<(script|style|noscript|svg|template)[^>]*>[\\s\\S]*?</\\1>", RegexOption.IGNORE_CASE).replace(html, " ")
        s = Regex("<!--[\\s\\S]*?-->").replace(s, " ")
        s = Regex("<br\\s*/?>", RegexOption.IGNORE_CASE).replace(s, "\n")
        s = Regex("</?(p|div|li|ul|ol|h[1-6]|tr|td|th|section|article|header|footer|blockquote|pre|table)[^>]*>", RegexOption.IGNORE_CASE).replace(s, "\n")
        s = Regex("<[^>]+>").replace(s, " ")
        s = decodeEntities(s)
        s = s.replace(' ', ' ')
        s = Regex("[ \\t\\r\\f]+").replace(s, " ")
        s = Regex(" *\\n *").replace(s, "\n")
        s = Regex("\\n{3,}").replace(s, "\n\n")
        return s.trim()
    }

    /** `<meta property="og:title" content="…">` (libovolné pořadí atributů; property i name). */
    fun meta(html: String, prop: String): String? {
        val p = Regex.escape(prop)
        val patterns = listOf(
            Regex("<meta[^>]+(?:property|name)=[\"']$p[\"'][^>]*content=[\"']([^\"']*)[\"']", RegexOption.IGNORE_CASE),
            Regex("<meta[^>]+content=[\"']([^\"']*)[\"'][^>]*(?:property|name)=[\"']$p[\"']", RegexOption.IGNORE_CASE),
        )
        for (re in patterns) {
            val m = re.find(html) ?: continue
            val v = decodeEntities(m.groupValues[1]).trim()
            if (v.isNotEmpty()) return v
        }
        return null
    }

    fun title(html: String): String? {
        val m = Regex("<title[^>]*>([\\s\\S]*?)</title>", RegexOption.IGNORE_CASE).find(html) ?: return null
        return decodeEntities(m.groupValues[1]).trim().ifEmpty { null }
    }

    /** Najde v HTML strukturovaná data schema.org/Recipe (JSON-LD). */
    fun jsonLdRecipe(html: String): JSONObject? {
        val re = Regex("<script[^>]+type=[\"']application/ld\\+json[\"'][^>]*>([\\s\\S]*?)</script>", RegexOption.IGNORE_CASE)
        for (m in re.findAll(html)) {
            val raw = m.groupValues[1].trim()
            val parsed: Any = try { if (raw.startsWith("[")) JSONArray(raw) else JSONObject(raw) } catch (e: Exception) { continue }
            findRecipe(parsed)?.let { return it }
        }
        return null
    }

    private fun findRecipe(node: Any?, depth: Int = 0): JSONObject? {
        if (depth > 6) return null
        when (node) {
            is JSONObject -> {
                val t = node.opt("@type")
                val types = when (t) { is JSONArray -> (0 until t.length()).map { t.optString(it) }; is String -> listOf(t); else -> emptyList() }
                if (types.any { it.equals("Recipe", true) }) return node
                for (k in listOf("@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "hasPart")) {
                    findRecipe(node.opt(k), depth + 1)?.let { return it }
                }
            }
            is JSONArray -> for (i in 0 until node.length()) findRecipe(node.opt(i), depth + 1)?.let { return it }
        }
        return null
    }

    fun truncate(s: String, max: Int): String = if (s.length <= max) s else s.substring(0, max) + "…"

    /** Bezpečné čtení pole řetězců z JSONArray (přeskočí ne-řetězce). */
    fun strings(arr: JSONArray?): MutableList<String> {
        val out = mutableListOf<String>()
        if (arr == null) return out
        for (i in 0 until arr.length()) {
            val v = arr.opt(i)
            val s = when (v) { is String -> v; is JSONObject -> v.optString("text").ifEmpty { v.optString("name") }; else -> v?.toString().orEmpty() }
            if (s.isNotBlank()) out.add(s.trim())
        }
        return out
    }
}
