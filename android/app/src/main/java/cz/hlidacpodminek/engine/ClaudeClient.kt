package cz.hlidacpodminek.engine

import org.json.JSONObject

/**
 * Volání Anthropic Messages API. Tělo požadavku (systémový prompt, JSON schéma výstupu,
 * server-side fallback) sestavuje sdílená knihovna lib/claude.js, Kotlin jen posílá HTTP.
 */
object ClaudeClient {
    private const val API_URL = "https://api.anthropic.com/v1/messages"

    class ApiException(message: String) : Exception(message)

    fun analyze(js: JsEngine, text: String, meta: JSONObject, settings: JSONObject): JSONObject {
        val apiKey = settings.optString("apiKey")
        if (apiKey.isEmpty()) throw ApiException("NO_API_KEY")
        val req = js.buildRequest(text, meta, settings)
        val body = req.getJSONObject("body")
        val betas = req.getJSONArray("betas")
        val betaHeader = (0 until betas.length()).joinToString(",") { betas.getString(it) }

        val headers = mapOf(
            "x-api-key" to apiKey,
            "anthropic-version" to "2023-06-01",
            "anthropic-beta" to betaHeader,
        )
        val res = Http.postJson(API_URL, headers, body.toString())
        if (res.code !in 200..299) {
            val detail = try { JSONObject(res.body).optJSONObject("error")?.optString("message") ?: res.body } catch (e: Exception) { res.body }
            throw when (res.code) {
                401 -> ApiException("API klíč byl odmítnut (401). Zkontrolujte ho v nastavení.")
                429 -> ApiException("Překročen limit požadavků (429). Zkuste to za chvíli.")
                else -> ApiException("Chyba API ${res.code}: ${detail.take(300)}")
            }
        }
        val msg = JSONObject(res.body)
        when (msg.optString("stop_reason")) {
            "refusal" -> throw ApiException("Model analýzu odmítl (" + (msg.optJSONObject("stop_details")?.optString("category") ?: "bez kategorie") + ").")
            "max_tokens" -> throw ApiException("Odpověď byla useknuta (max_tokens). Zkuste kratší dokument.")
        }
        val content = msg.optJSONArray("content") ?: throw ApiException("Odpověď neobsahuje obsah.")
        var textBlock: String? = null
        for (i in 0 until content.length()) {
            val b = content.getJSONObject(i)
            if (b.optString("type") == "text") { textBlock = b.optString("text"); break }
        }
        if (textBlock == null) throw ApiException("Odpověď neobsahuje text.")
        val parsed = try { JSONObject(textBlock) } catch (e: Exception) { throw ApiException("Odpověď není platný JSON.") }
        parsed.put("_engine", "claude")
        parsed.put("_model", msg.optString("model", body.optString("model")))
        parsed.put("_usage", msg.optJSONObject("usage"))
        parsed.put("_truncated", req.optBoolean("truncated"))
        parsed.put("_meta", meta)
        return parsed
    }
}
