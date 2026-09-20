package cz.doma.recepty.engine

import android.content.Context
import cz.doma.recepty.data.Prefs
import cz.doma.recepty.data.Recipe
import cz.doma.recepty.data.RecipeDb
import org.json.JSONObject

/**
 * Celý průchod: odkaz → stažení metadat → (Claude | offline) extrakce → uložení.
 * Volat na pozadí; [onStatus] hlásí průběh pro UI.
 */
class RecipeImporter(private val context: Context) {
    private val prefs = Prefs(context)
    private val db = RecipeDb.get(context)

    class Outcome(val recipe: Recipe, val existed: Boolean)

    fun import(rawUrl: String, onStatus: (String) -> Unit): Outcome {
        val info = VideoSource.detect(rawUrl)
        db.findByUrl(info.canonicalUrl)?.let { return Outcome(it, true) }

        onStatus("Stahuji informace o videu (${info.platform.label})…")
        val v = VideoFetcher.fetch(rawUrl)
        db.findByUrl(v.info.canonicalUrl)?.let { return Outcome(it, true) }

        val r = Recipe(
            url = v.info.canonicalUrl, platform = v.info.platform.name.lowercase(), videoId = v.info.videoId,
            title = LocalExtractor.cleanTitle(v.title), author = v.author, thumbnailUrl = v.thumbnailUrl,
            description = v.description, transcript = v.transcript,
        )
        if (v.problems.isNotEmpty()) r.error = v.problems.joinToString("; ")

        onStatus("Stahuji náhled…")
        val img = Thumbs.download(v.thumbnailUrl)
        if (img != null) r.thumbPath = Thumbs.save(context, v.info.canonicalUrl, img.bytes)

        analyze(r, v, img, "", onStatus)
        if (r.title.isBlank()) r.title = "Recept z ${v.info.platform.label}"
        db.insert(r)
        return Outcome(r, false)
    }

    /** Znovu analyzuje uložený recept (např. po ručním doplnění popisku), přepíše ingredience/postup/klíčová slova. */
    fun reanalyze(r: Recipe, onStatus: (String) -> Unit): Recipe {
        val info = VideoSource.detect(r.url)
        val v = FetchedVideo(info)
        v.title = r.title; v.author = r.author; v.description = r.description; v.transcript = r.transcript; v.thumbnailUrl = r.thumbnailUrl
        var img: Thumbs.Downloaded? = null
        if (r.thumbPath.isNotEmpty()) {
            try { val f = java.io.File(r.thumbPath); if (f.exists()) img = Thumbs.Downloaded(f.readBytes(), sniffType(f.readBytes())) } catch (e: Exception) {}
        }
        analyze(r, v, img, r.notes, onStatus)
        db.update(r)
        return r
    }

    private fun sniffType(b: ByteArray): String = when {
        b.size > 3 && b[0] == 0xFF.toByte() && b[1] == 0xD8.toByte() -> "image/jpeg"
        b.size > 8 && b[0] == 0x89.toByte() -> "image/png"
        b.size > 12 && b[8] == 'W'.code.toByte() -> "image/webp"
        else -> "image/jpeg"
    }

    private fun analyze(r: Recipe, v: FetchedVideo, img: Thumbs.Downloaded?, extraText: String, onStatus: (String) -> Unit) {
        // schema.org/Recipe z webu – nejspolehlivější zdroj, použije se přímo (model může doplnit klíčová slova)
        v.jsonLd?.let { applyJsonLd(r, it) }

        val key = prefs.apiKey
        if (key.isNotEmpty() && (v.hasContent() || extraText.isNotBlank() || img != null)) {
            onStatus("Zapisuji recept pomocí Claude…")
            try {
                val out = ClaudeExtractor.extract(
                    v, extraText,
                    if (prefs.useThumbnail) img?.bytes else null, img?.mediaType.orEmpty(),
                    ClaudeExtractor.Settings(key, prefs.model, prefs.effort), prefs.useTranscript,
                )
                ClaudeExtractor.apply(r, out)
                if (!v.hasContent() && extraText.isBlank()) r.needsReview = true
                return
            } catch (e: Exception) {
                r.error = listOf(r.error, "Claude: " + (e.message ?: e.toString())).filter { it.isNotBlank() }.joinToString("; ")
                if (!prefs.useLocalFallback) { r.needsReview = true; return }
            }
        }
        if (r.ingredients.isNotEmpty() && v.jsonLd != null) { r.engine = "schema.org"; r.confidence = "high"; return }

        onStatus("Hledám ingredience v popisku…")
        val local = LocalExtractor.extract(v.title, v.description + "\n" + extraText, v.transcript + "\n" + v.pageText)
        if (r.title.isBlank()) r.title = local.title
        r.ingredients = local.ingredients
        r.steps = local.steps
        r.keywords = local.keywords
        r.summary = local.summary
        r.engine = "offline"
        r.confidence = local.confidence
        r.needsReview = local.confidence != "medium" || !v.hasContent()
        if (!v.hasContent()) r.error = listOf(r.error, "Popisek videa se nepodařilo stáhnout – doplňte ho ručně a spusťte analýzu znovu.").filter { it.isNotBlank() }.joinToString("; ")
    }

    private fun applyJsonLd(r: Recipe, ld: JSONObject) {
        val name = ld.optString("name").trim(); if (name.isNotEmpty()) r.title = name
        r.ingredients = Recipe.parseIngredients(ld.optJSONArray("recipeIngredient"))
        val instr = ld.opt("recipeInstructions")
        r.steps = when (instr) {
            is org.json.JSONArray -> TextUtil.strings(instr).flatMap { it.split('\n') }.map { it.trim() }.filter { it.isNotEmpty() }.toMutableList()
            is String -> instr.split(Regex("\\n|(?<=\\.)\\s+(?=\\p{Lu})")).map { it.trim() }.filter { it.isNotEmpty() }.toMutableList()
            else -> mutableListOf()
        }
        r.summary = TextUtil.decodeEntities(ld.optString("description"))
        val kw = ld.opt("keywords")
        r.keywords = (when (kw) { is String -> kw.split(','); is org.json.JSONArray -> TextUtil.strings(kw); else -> emptyList() } +
            TextUtil.strings(ld.optJSONArray("recipeCategory")) + TextUtil.strings(ld.optJSONArray("recipeCuisine")) +
            listOfNotNull(ld.optString("recipeCategory").takeIf { it.isNotEmpty() }, ld.optString("recipeCuisine").takeIf { it.isNotEmpty() }))
            .map { it.trim().lowercase() }.filter { it.isNotEmpty() }.distinct().toMutableList()
        r.cuisine = ld.optString("recipeCuisine").let { if (it.startsWith("[")) "" else it }
        r.servings = Regex("\\d+").find(ld.opt("recipeYield")?.toString().orEmpty())?.value?.toIntOrNull()
        r.timeMinutes = parseIsoMinutes(ld.optString("totalTime")) ?: ((parseIsoMinutes(ld.optString("prepTime")) ?: 0) + (parseIsoMinutes(ld.optString("cookTime")) ?: 0)).takeIf { it > 0 }
    }

    private fun parseIsoMinutes(s: String): Int? {
        if (s.isEmpty()) return null
        val m = Regex("P(?:(\\d+)D)?T?(?:(\\d+)H)?(?:(\\d+)M)?").find(s) ?: return null
        val d = m.groupValues[1].toIntOrNull() ?: 0; val h = m.groupValues[2].toIntOrNull() ?: 0; val min = m.groupValues[3].toIntOrNull() ?: 0
        return (d * 1440 + h * 60 + min).takeIf { it > 0 }
    }
}
