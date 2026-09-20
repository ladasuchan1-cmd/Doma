package cz.doma.recepty.engine

import android.util.Base64
import cz.doma.recepty.data.Recipe
import org.json.JSONArray
import org.json.JSONObject

/**
 * Extrakce receptu modelem Claude (Anthropic Messages API, strukturovaný JSON výstup).
 * Vstup: název, autor, popisek, titulky a náhledový obrázek videa. Výstup: ingredience v základním tvaru,
 * postup, klíčová slova pro vyhledávání.
 */
object ClaudeExtractor {
    private const val API_URL = "https://api.anthropic.com/v1/messages"
    private const val MAX_INPUT_CHARS = 200_000

    class ApiException(message: String) : Exception(message)

    class Settings(val apiKey: String, val model: String, val effort: String)

    private val SYSTEM_PROMPT = """
Jsi kuchařský asistent. Uživatel ti posílá metadata krátkého videa s jídlem (YouTube, Instagram Reels, TikTok) nebo text receptu z webu: název, autora, popisek (caption), automatické titulky (mohou být zašuměné, bez interpunkce, v jiném jazyce) a případně náhledový obrázek. Tvým úkolem je zapsat recept tak, aby ho uživatel později našel podle ingrediencí a klíčových slov.

Pravidla:
- Odpovídej česky (názvy jídel, ingrediencí i postup), i když je zdroj anglicky nebo v jiném jazyce. Zachovej zavedené cizí názvy jídel (např. „Tiramisu“, „Pad Thai“) a přidej český popis.
- Ingredience: každou zvlášť, název v 1. pádě jednotného čísla, bez přívlastků množství („kuřecí prsa“, „česnek“, „hladká mouka“). Množství a jednotku odděl do vlastních polí, pokud jsou známy; jinak nech prázdné. Do „note“ patří upřesnění („nasekaný“, „pokojové teploty“, „volitelně“). Nevymýšlej množství, která ve zdroji nejsou.
- Pokud text neobsahuje seznam ingrediencí, odvoď je z popisu jídla, titulků a obrázku – ale takové odvozené ingredience označ v poli note slovem „odhad“ a nastav confidence „low“.
- Postup: stručné kroky v pořadí. Pokud zdroj postup neuvádí, nech pole prázdné (nevymýšlej ho).
- Klíčová slova (keywords): 8–20 slov nebo krátkých frází pro vyhledávání – základní názvy všech surovin, typ jídla (polévka, salát, dezert, snídaně…), kuchyně (italská, asijská…), diety (vegan, bez lepku, low carb, vysoký obsah bílkovin), příležitost (rychlá večeře, meal prep, do práce), hlavní technika (pečené, smažené, v jednom hrnci), a běžná synonyma (např. „kuře“ i „kuřecí“, „brambory“ i „bramborový“). Vše malými písmeny, česky.
- Název (title): krátký český název jídla (max. 60 znaků), bez hashtagů a emoji.
- summary: 1–2 věty, co to je a čím je zajímavé.
- time_minutes a servings jen pokud jsou ve zdroji uvedené, jinak null.
- Pokud zdroj vůbec není o jídle, nastav is_food false a ostatní pole vyplň minimálně.
""".trimIndent()

    private val SCHEMA: JSONObject = JSONObject("""
{
  "type": "object",
  "properties": {
    "is_food": {"type": "boolean", "description": "Zda jde o jídlo / recept."},
    "title": {"type": "string"},
    "summary": {"type": "string"},
    "ingredients": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": {"type": "string", "description": "Název suroviny česky, 1. pád, jednotné číslo."},
          "amount": {"type": "string", "description": "Množství tak, jak je uvedeno (např. „200“, „1/2“, „2-3“), nebo prázdný řetězec."},
          "unit": {"type": "string", "description": "Jednotka (g, ml, lžíce, ks, stroužek…) nebo prázdný řetězec."},
          "note": {"type": "string", "description": "Upřesnění nebo prázdný řetězec."}
        },
        "required": ["name", "amount", "unit", "note"],
        "additionalProperties": false
      }
    },
    "steps": {"type": "array", "items": {"type": "string"}},
    "keywords": {"type": "array", "items": {"type": "string"}},
    "cuisine": {"type": "string", "description": "Kuchyně (česká, italská, asijská…) nebo prázdný řetězec."},
    "category": {"type": "string", "enum": ["snídaně", "hlavní jídlo", "polévka", "salát", "příloha", "dezert", "pečivo", "svačina", "nápoj", "omáčka", "jiné"]},
    "time_minutes": {"type": ["integer", "null"]},
    "servings": {"type": ["integer", "null"]},
    "source_language": {"type": "string"},
    "confidence": {"type": "string", "enum": ["high", "medium", "low"]}
  },
  "required": ["is_food", "title", "summary", "ingredients", "steps", "keywords", "cuisine", "category", "time_minutes", "servings", "source_language", "confidence"],
  "additionalProperties": false
}
""")

    /** Sestaví tělo požadavku (veřejné kvůli testům). */
    fun buildRequest(v: FetchedVideo, extraText: String, image: ByteArray?, imageType: String, settings: Settings, useTranscript: Boolean): JSONObject {
        val sb = StringBuilder()
        sb.append("Platforma: ").append(v.info.platform.label).append('\n')
        sb.append("URL: ").append(v.info.canonicalUrl).append('\n')
        if (v.title.isNotBlank()) sb.append("Název videa: ").append(v.title).append('\n')
        if (v.author.isNotBlank()) sb.append("Autor: ").append(v.author).append('\n')
        if (v.description.isNotBlank()) sb.append("\n<popisek>\n").append(v.description).append("\n</popisek>\n")
        if (extraText.isNotBlank()) sb.append("\n<doplneno_uzivatelem>\n").append(extraText).append("\n</doplneno_uzivatelem>\n")
        v.jsonLd?.let { sb.append("\n<schema_org_recipe>\n").append(it.toString()).append("\n</schema_org_recipe>\n") }
        if (useTranscript && v.transcript.isNotBlank()) sb.append("\n<titulky>\n").append(v.transcript).append("\n</titulky>\n")
        if (v.pageText.isNotBlank()) sb.append("\n<text_stranky>\n").append(v.pageText).append("\n</text_stranky>\n")
        var text = sb.toString()
        if (text.length > MAX_INPUT_CHARS) text = text.substring(0, MAX_INPUT_CHARS) + "\n[zkráceno]"
        text += "\nZapiš recept podle instrukcí."

        val content = JSONArray()
        if (image != null && imageType.isNotEmpty()) {
            content.put(JSONObject().put("type", "image").put("source", JSONObject()
                .put("type", "base64").put("media_type", imageType).put("data", Base64.encodeToString(image, Base64.NO_WRAP))))
        }
        content.put(JSONObject().put("type", "text").put("text", text))

        return JSONObject()
            .put("model", settings.model)
            .put("max_tokens", 8000)
            .put("system", SYSTEM_PROMPT)
            .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", content)))
            .put("output_config", JSONObject().put("effort", settings.effort).put("format", JSONObject().put("type", "json_schema").put("schema", SCHEMA)))
            // Bezpečnostní klasifikátory mohou požadavek odmítnout – server-side fallback ho zopakuje na jiném modelu.
            .put("fallbacks", "default")
    }

    fun extract(v: FetchedVideo, extraText: String, image: ByteArray?, imageType: String, settings: Settings, useTranscript: Boolean): JSONObject {
        if (settings.apiKey.isEmpty()) throw ApiException("NO_API_KEY")
        val body = buildRequest(v, extraText, image, imageType, settings, useTranscript)
        val headers = mapOf(
            "x-api-key" to settings.apiKey,
            "anthropic-version" to "2023-06-01",
            "anthropic-beta" to "server-side-fallback-2026-07-01",
        )
        val res = Http.postJson(API_URL, headers, body.toString())
        if (!res.ok) {
            val detail = try { JSONObject(res.body).optJSONObject("error")?.optString("message") ?: res.body } catch (e: Exception) { res.body }
            throw when (res.code) {
                401 -> ApiException("API klíč byl odmítnut (401). Zkontrolujte ho v nastavení.")
                429 -> ApiException("Překročen limit požadavků (429). Zkuste to za chvíli.")
                else -> ApiException("Chyba API ${res.code}: ${detail.take(300)}")
            }
        }
        val msg = JSONObject(res.body)
        when (msg.optString("stop_reason")) {
            "refusal" -> throw ApiException("Model požadavek odmítl (" + (msg.optJSONObject("stop_details")?.optString("category") ?: "bez kategorie") + ").")
            "max_tokens" -> throw ApiException("Odpověď byla useknuta (max_tokens).")
        }
        val content = msg.optJSONArray("content") ?: throw ApiException("Odpověď neobsahuje obsah.")
        var textBlock: String? = null
        for (i in 0 until content.length()) {
            val b = content.getJSONObject(i)
            if (b.optString("type") == "text") { textBlock = b.optString("text"); break }
        }
        if (textBlock == null) throw ApiException("Odpověď neobsahuje text.")
        val parsed = try { JSONObject(textBlock) } catch (e: Exception) { throw ApiException("Odpověď není platný JSON.") }
        parsed.put("_model", msg.optString("model", settings.model))
        parsed.put("_usage", msg.optJSONObject("usage"))
        return parsed
    }

    /** Přepíše výsledek modelu do receptu (ponechá zdrojová pole – url, popis, titulky). */
    fun apply(r: Recipe, out: JSONObject) {
        val title = out.optString("title").trim()
        if (title.isNotEmpty()) r.title = title
        r.summary = out.optString("summary")
        r.ingredients = Recipe.parseIngredients(out.optJSONArray("ingredients"))
        r.steps = TextUtil.strings(out.optJSONArray("steps"))
        r.keywords = TextUtil.strings(out.optJSONArray("keywords")).map { it.lowercase() }.distinct().toMutableList()
        r.cuisine = out.optString("cuisine")
        r.category = out.optString("category")
        r.timeMinutes = if (out.isNull("time_minutes")) null else out.optInt("time_minutes").takeIf { it > 0 }
        r.servings = if (out.isNull("servings")) null else out.optInt("servings").takeIf { it > 0 }
        r.engine = "claude:" + out.optString("_model")
        r.confidence = out.optString("confidence")
        r.needsReview = r.confidence == "low" || !out.optBoolean("is_food", true) || r.ingredients.isEmpty()
        r.error = if (!out.optBoolean("is_food", true)) "Model si není jistý, že jde o jídlo." else ""
    }
}
