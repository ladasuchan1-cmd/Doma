package cz.doma.recepty.data

import cz.doma.recepty.engine.TextUtil
import org.json.JSONArray
import org.json.JSONObject

/** Jedna ingredience: „200 g hladká mouka (prosátá)“. */
data class Ingredient(val name: String, val amount: String = "", val unit: String = "", val note: String = "") {
    fun display(): String {
        val sb = StringBuilder()
        if (amount.isNotBlank()) sb.append(amount.trim()).append(' ')
        if (unit.isNotBlank()) sb.append(unit.trim()).append(' ')
        sb.append(name.trim())
        if (note.isNotBlank()) sb.append(" (").append(note.trim()).append(')')
        return sb.toString().trim()
    }

    fun toJson(): JSONObject = JSONObject().put("name", name).put("amount", amount).put("unit", unit).put("note", note)

    companion object {
        val UNITS: Set<String> = setOf(
            "g", "gr", "gram", "gramu", "gramy", "gramů", "kg", "dkg", "dag", "mg", "ml", "l", "dl", "cl", "litr", "litru", "litry",
            "lzice", "lzic", "lzicka", "lzicky", "lzicek", "pl", "cl", "kl", "polevkova", "kavova", "cajova",
            "hrnek", "hrnky", "hrnku", "hrnků", "salek", "salku", "salky", "spetka", "spetku", "spetky", "ks", "kus", "kusy", "kusu",
            "strouzek", "strouzky", "strouzku", "platek", "platky", "platku", "baleni", "balicek", "svazek", "snitka", "snitky", "hrst", "hrsti",
            "kostka", "kostky", "plechovka", "plechovky", "sklenice", "sklenicka", "krajic", "krajice", "vetev", "stonek", "stonky", "kapka", "kapky", "spetk",
            "cup", "cups", "tbsp", "tsp", "oz", "lb", "lbs", "pcs", "pc", "clove", "cloves", "pinch", "can", "cans", "stick", "sticks", "slice", "slices",
            "tablespoon", "tablespoons", "teaspoon", "teaspoons", "handful", "bunch", "package", "pack", "piece", "pieces", "dash", "quart", "pint",
        )
        private val AMOUNT_RE = Regex("^(\\d+[.,]?\\d*(?:\\s*[-–/]\\s*\\d+[.,]?\\d*)?|\\d+\\s+\\d/\\d|[½¼¾⅓⅔⅛]|\\d+[½¼¾])$")

        fun fromJson(o: JSONObject?): Ingredient? {
            if (o == null) return null
            val name = o.optString("name").trim()
            if (name.isEmpty()) return null
            return Ingredient(name, o.optString("amount").trim(), o.optString("unit").trim(), o.optString("note").trim())
        }

        /** „- 200 g hladké mouky (prosáté)“ → Ingredient(„hladké mouky“, „200“, „g“, „prosáté“). */
        fun parseLine(raw: String): Ingredient? {
            var line = raw.trim().trimStart('-', '•', '*', '·', '–', '—', '✓', '☐', '□', '▪', '◦', ' ', '\t')
            line = line.replace(Regex("^\\d{1,2}[.)]\\s+(?=\\p{L})"), "") // „1. mouka“ (očíslovaný seznam)
            if (line.isBlank() || line.length > 200) return null
            var note = ""
            val paren = Regex("\\(([^)]*)\\)").find(line)
            if (paren != null) { note = paren.groupValues[1].trim(); line = line.replace(paren.value, " ").trim() }
            // „mouka – 200 g“ / „mouka: 200 g“
            val tail = Regex("^(.+?)\\s*[:–—-]\\s*(\\d+[.,]?\\d*\\s*[\\p{L}]*)$").find(line)
            if (tail != null && !Regex("^\\d").containsMatchIn(line)) {
                val q = tail.groupValues[2].trim()
                val qm = Regex("^(\\d+[.,]?\\d*)\\s*(\\p{L}*)$").find(q)
                if (qm != null) return Ingredient(tail.groupValues[1].trim(), qm.groupValues[1], qm.groupValues[2], note)
            }
            val tokens = line.split(Regex("\\s+")).filter { it.isNotEmpty() }.toMutableList()
            var amount = ""
            var unit = ""
            // množství může být „2“, „1/2“, „1 1/2“, „2-3“, „200“, „½“, „1,5“
            if (tokens.isNotEmpty()) {
                var cand = tokens[0]
                if (tokens.size > 1 && Regex("^\\d+$").matches(cand) && Regex("^\\d/\\d$").matches(tokens[1])) { cand = cand + " " + tokens[1]; tokens.removeAt(1) }
                val m = Regex("^(\\d+[.,]?\\d*)(\\p{L}+)$").find(cand) // „200g“, „2ks“
                if (m != null && TextUtil.fold(m.groupValues[2]) in UNITS) { amount = m.groupValues[1]; unit = m.groupValues[2]; tokens.removeAt(0) }
                else if (AMOUNT_RE.matches(cand)) { amount = cand; tokens.removeAt(0) }
            }
            if (amount.isNotEmpty() && tokens.isNotEmpty() && unit.isEmpty()) {
                val u = TextUtil.fold(tokens[0].trimEnd('.'))
                if (u in UNITS) { unit = tokens.removeAt(0); }
                else if (tokens.size > 1 && (u == "polevkove" || u == "polevkova" || u == "kavove" || u == "kavova" || u == "cajove" || u == "cajova") && TextUtil.fold(tokens[1]) in UNITS) {
                    unit = tokens.removeAt(0) + " " + tokens.removeAt(0)
                }
            }
            val name = tokens.joinToString(" ").trim().trimStart(':', '-', '–').trim()
            if (name.isEmpty()) return null
            return Ingredient(name, amount, unit, note)
        }
    }
}

/** Uložený recept – vše, co se z videa zjistilo, plus ruční úpravy. */
class Recipe(
    var id: Long = 0,
    var createdAt: Long = System.currentTimeMillis(),
    var url: String = "",
    var platform: String = "",
    var videoId: String = "",
    var title: String = "",
    var author: String = "",
    var thumbnailUrl: String = "",
    var thumbPath: String = "",
    var description: String = "",
    var transcript: String = "",
    var summary: String = "",
    var ingredients: MutableList<Ingredient> = mutableListOf(),
    var steps: MutableList<String> = mutableListOf(),
    var keywords: MutableList<String> = mutableListOf(),
    var cuisine: String = "",
    var category: String = "",
    var timeMinutes: Int? = null,
    var servings: Int? = null,
    var engine: String = "",
    var confidence: String = "",
    var notes: String = "",
    var needsReview: Boolean = false,
    var error: String = "",
) {
    /** Text pro fulltext: názvy ingrediencí + klíčová slova. */
    fun ingredientText(): String = (ingredients.map { it.name } + keywords).joinToString("\n")

    fun bodyText(): String = listOf(author, summary, cuisine, category, description, steps.joinToString("\n"), notes).filter { it.isNotBlank() }.joinToString("\n")

    fun ingredientsAsLines(): String = ingredients.joinToString("\n") { it.display() }

    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("createdAt", createdAt).put("url", url).put("platform", platform).put("videoId", videoId)
        .put("title", title).put("author", author).put("thumbnailUrl", thumbnailUrl).put("description", description)
        .put("transcript", transcript).put("summary", summary)
        .put("ingredients", JSONArray().also { a -> ingredients.forEach { a.put(it.toJson()) } })
        .put("steps", JSONArray(steps)).put("keywords", JSONArray(keywords))
        .put("cuisine", cuisine).put("category", category).put("timeMinutes", timeMinutes ?: JSONObject.NULL).put("servings", servings ?: JSONObject.NULL)
        .put("engine", engine).put("confidence", confidence).put("notes", notes).put("needsReview", needsReview)

    companion object {
        fun fromJson(o: JSONObject): Recipe {
            val r = Recipe()
            r.id = o.optLong("id"); r.createdAt = o.optLong("createdAt", System.currentTimeMillis())
            r.url = o.optString("url"); r.platform = o.optString("platform"); r.videoId = o.optString("videoId")
            r.title = o.optString("title"); r.author = o.optString("author"); r.thumbnailUrl = o.optString("thumbnailUrl")
            r.description = o.optString("description"); r.transcript = o.optString("transcript"); r.summary = o.optString("summary")
            r.ingredients = parseIngredients(o.optJSONArray("ingredients"))
            r.steps = TextUtil.strings(o.optJSONArray("steps")); r.keywords = TextUtil.strings(o.optJSONArray("keywords"))
            r.cuisine = o.optString("cuisine"); r.category = o.optString("category")
            r.timeMinutes = if (o.isNull("timeMinutes")) null else o.optInt("timeMinutes").takeIf { it > 0 }
            r.servings = if (o.isNull("servings")) null else o.optInt("servings").takeIf { it > 0 }
            r.engine = o.optString("engine"); r.confidence = o.optString("confidence"); r.notes = o.optString("notes")
            r.needsReview = o.optBoolean("needsReview")
            return r
        }

        fun parseIngredients(arr: JSONArray?): MutableList<Ingredient> {
            val out = mutableListOf<Ingredient>()
            if (arr == null) return out
            for (i in 0 until arr.length()) {
                val v = arr.opt(i)
                val ing = when (v) { is JSONObject -> Ingredient.fromJson(v); is String -> Ingredient.parseLine(v); else -> null }
                if (ing != null) out.add(ing)
            }
            return out
        }

        fun ingredientsFromLines(text: String): MutableList<Ingredient> =
            text.split('\n').mapNotNull { Ingredient.parseLine(it) }.toMutableList()
    }
}
