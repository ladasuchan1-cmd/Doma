package cz.hlidacpodminek.engine

import android.content.Context
import cz.hlidacpodminek.data.Prefs
import cz.hlidacpodminek.data.Store
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Orchestrace analýzy – obdoba background.js z rozšíření:
 * cache → Claude API (nebo offline analýza) → uložení výsledku a historie.
 * Všechny metody jsou blokující a musí běžet mimo hlavní vlákno.
 */
class Analyzer(context: Context) {
    private val ctx = context.applicationContext
    private val js = JsEngine.get(ctx)
    private val prefs = Prefs(ctx)
    private val store = Store(ctx)

    class AnalysisException(message: String) : Exception(message)

    /** Výsledek + id uloženého záznamu. */
    class Outcome(val id: String, val result: JSONObject, val cached: Boolean)

    fun analyzeText(rawText: String, meta: JSONObject, force: Boolean = false, minLength: Int = 200): Outcome {
        val text = rawText.replace('\u00a0', ' ').replace(Regex("[ \\t]+"), " ").replace(Regex(" *\\n *"), "\n").replace(Regex("\\n{3,}"), "\n\n").trim()
        if (text.length < minLength) throw AnalysisException("Text je příliš krátký na analýzu (${text.length} znaků).")
        val hasKey = prefs.apiKey.isNotEmpty()
        val engine = if (hasKey) "claude" else if (prefs.useLocalFallback) "local" else throw AnalysisException("NO_API_KEY")
        val key = engine + ":" + (if (hasKey) prefs.model else "local") + ":" + js.hash(text)

        if (!force) {
            store.cacheGet(key)?.let { return Outcome(it.optString("_id"), it, true) }
        }
        val lock = locks.getOrPut(key) { Any() }
        synchronized(lock) {
            if (!force) store.cacheGet(key)?.let { return Outcome(it.optString("_id"), it, true) }
            var result: JSONObject
            if (engine == "claude") {
                try {
                    result = ClaudeClient.analyze(js, text, meta, prefs.toJson())
                } catch (e: Exception) {
                    if (!prefs.useLocalFallback) throw AnalysisException(e.message ?: e.toString())
                    result = js.analyzeLocal(text, meta)
                    result.put("_fallbackError", e.message ?: e.toString())
                    result.put("summary", "Claude API selhalo (" + (e.message ?: "chyba") + "). " + result.optString("summary"))
                }
            } else {
                result = js.analyzeLocal(text, meta)
            }
            result.put("_analyzedAt", System.currentTimeMillis())
            result.put("_textLength", text.length)
            val id = store.save(result, meta)
            store.cachePut(key, id)
            return Outcome(id, result, false)
        }
    }

    /** Stáhne odkazované dokumenty s podmínkami, spojí je a zanalyzuje (kontext pokladny / registrace / instalace). */
    fun analyzeLinks(links: List<String>, meta: JSONObject, contextDescription: String): Outcome {
        val docs = links.take(4).mapNotNull<String, Triple<String, String, String>> { url ->
            try {
                val res = Http.get(url)
                if (res.code !in 200..299) return@mapNotNull null
                if (res.contentType.contains("pdf", true) || url.contains(".pdf", true)) return@mapNotNull null
                val ex = js.fromHtml(res.body)
                val text = ex.optString("text")
                if (text.length < 500) null else Triple(url, ex.optString("title").ifEmpty { url }, text)
            } catch (e: Exception) { null }
        }
        if (docs.isEmpty()) throw AnalysisException("Nepodařilo se stáhnout odkazované podmínky (${links.take(4).joinToString(", ")}).")
        val combined = docs.joinToString("\n\n") { "===== ${it.second} (${it.first}) =====\n${it.third}" }
        val sources = JSONArray()
        for (d in docs) sources.put(JSONObject().put("url", d.first).put("title", d.second).put("length", d.third.length))
        val fullMeta = JSONObject(meta.toString())
            .put("context", contextDescription + ". Stránka odkazuje na tyto dokumenty: " + docs.joinToString(", ") { it.second })
            .put("sources", sources)
        val out = analyzeText(combined, fullMeta)
        out.result.put("_sources", sources)
        return out
    }

    /**
     * Analýza webové adresy: stáhne stránku, rozpozná, zda jde o dokument s podmínkami (→ analyzuje text)
     * nebo o stránku, která na podmínky odkazuje (→ stáhne a zanalyzuje odkazované dokumenty).
     */
    fun analyzeUrl(url: String, extraSignals: JSONObject? = null, contextDescription: String? = null): Outcome {
        val res = Http.get(url)
        if (res.code !in 200..299) throw AnalysisException("Stránku se nepodařilo stáhnout (HTTP ${res.code}).")
        val page = PageSignals.fromHtml(js, url, res.body, extraSignals)
        val det = js.detect(page.signals)
        val kind = det.optString("kind")
        val meta = JSONObject().put("url", url).put("title", page.title)
        return when {
            kind == "document" -> analyzeText(page.text, meta.put("context", contextDescription ?: "Uživatel si otevřel přímo tento dokument."), minLength = 200)
            kind == "consent" -> {
                val links = det.optJSONArray("termsLinks") ?: JSONArray()
                analyzeLinks((0 until links.length()).map { links.getJSONObject(it).optString("url") }, meta, contextDescription ?: describeContext(det.optJSONArray("context")))
            }
            page.text.length >= 200 -> analyzeText(page.text, meta.put("context", contextDescription ?: "Uživatel požádal o analýzu této stránky."), minLength = 200)
            else -> throw AnalysisException("Stránka neobsahuje dost textu k analýze.")
        }
    }

    fun store(): Store = store
    fun prefs(): Prefs = prefs
    fun engine(): JsEngine = js

    companion object {
        private val locks = ConcurrentHashMap<String, Any>()

        fun describeContext(ctx: JSONArray?): String {
            val names = mapOf("checkout" to "dokončuje nákup / objednávku", "signup" to "zakládá účet / registruje se", "install" to "instaluje aplikaci")
            val parts = ArrayList<String>()
            if (ctx != null) for (i in 0 until ctx.length()) names[ctx.optString(i)]?.let { parts.add(it) }
            return if (parts.isEmpty()) "Uživatel má před sebou souhlas s podmínkami" else "Uživatel právě " + parts.joinToString(" a ")
        }
    }
}

/** Signály stránky pro detektor (stejná struktura jako collectSignals() v content.js). */
class PageSignals(val signals: JSONObject, val title: String, val text: String) {
    companion object {
        private val LINK_RE = Regex("<a\\b[^>]*?href\\s*=\\s*[\"']([^\"'#][^\"']*)[\"'][^>]*>(.*?)</a>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
        private val HEADING_RE = Regex("<h[12]\\b[^>]*>(.*?)</h[12]>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
        private val BUTTON_RE = Regex("<(?:button|input)\\b[^>]*(?:value\\s*=\\s*[\"']([^\"']*)[\"'])?[^>]*>(.*?)(?:</button>|/?>)", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
        private val LABEL_RE = Regex("<label\\b[^>]*>(.*?)</label>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
        private val TAG_RE = Regex("<[^>]+>")

        private fun strip(s: String): String = TAG_RE.replace(s, " ").replace(Regex("\\s+"), " ").trim()

        fun fromHtml(js: JsEngine, url: String, html: String, extra: JSONObject?): PageSignals {
            val ex = js.fromHtml(html)
            val title = ex.optString("title")
            val text = ex.optString("text")
            val links = JSONArray()
            var n = 0
            for (m in LINK_RE.findAll(html)) {
                links.put(JSONObject().put("href", m.groupValues[1]).put("text", strip(m.groupValues[2]).take(200)))
                if (++n >= 800) break
            }
            val headings = JSONArray(); for (m in HEADING_RE.findAll(html).take(30)) headings.put(strip(m.groupValues[1]))
            val buttons = JSONArray(); for (m in BUTTON_RE.findAll(html).take(150)) { val t = strip(m.groupValues[2]).ifEmpty { m.groupValues[1] }; if (t.isNotEmpty()) buttons.put(t) }
            val labels = JSONArray(); for (m in LABEL_RE.findAll(html).take(150)) labels.put(strip(m.groupValues[1]))
            if (extra != null) {
                extra.optJSONArray("buttons")?.let { for (i in 0 until it.length()) buttons.put(it.optString(i)) }
                extra.optJSONArray("labels")?.let { for (i in 0 until it.length()) labels.put(it.optString(i)) }
            }
            val signals = JSONObject()
                .put("url", url)
                .put("title", title)
                .put("headings", headings)
                .put("buttons", buttons)
                .put("labels", labels)
                .put("links", links)
                .put("text", text)
                .put("hasPasswordField", html.contains("type=\"password\"", true) || html.contains("type='password'", true))
                .put("hasPaymentField", Regex("autocomplete=[\"']cc-|name=[\"'][^\"']*(card|karta)|stripe\\.com|adyen|gopay|comgate|paypal|braintree", RegexOption.IGNORE_CASE).containsMatchIn(html))
            return PageSignals(signals, title, text)
        }
    }
}
