package cz.doma.recepty.engine

import cz.doma.recepty.data.Ingredient

/**
 * Offline (heuristická) extrakce receptu z popisu videa / titulků – používá se bez API klíče
 * nebo jako záloha, když volání Claude selže. Hledá sekci ingrediencí, řádky s množstvím a suroviny ze slovníku.
 */
object LocalExtractor {
    class Result(
        val title: String,
        val ingredients: MutableList<Ingredient>,
        val steps: MutableList<String>,
        val keywords: MutableList<String>,
        val summary: String,
        val confidence: String,
    )

    private val ING_HEADER = Regex("^\\W*(ingredience|ingrediencie|suroviny|budete potrebovat|budes potrebovat|co budete potrebovat|potrebujeme|potrebujete|na (\\d+ )?porc[a-z]*|ingredients?|you will need|what you need|shopping list|na testo|na naplni|na omacku|na krem|na polevu|for the [a-z ]+)\\W*:?\\W*$", RegexOption.IGNORE_CASE)
    private val STEP_HEADER = Regex("^\\W*(postup|priprava|postup pripravy|instrukce|navod|jak na to|instructions?|directions?|method|steps|preparation|how to make it)\\W*:?\\W*$", RegexOption.IGNORE_CASE)
    private val END_SECTION = Regex("^\\W*(tip|tipy|poznamk|sledujte|follow|subscribe|odebir|instagram|facebook|tiktok|http|#|@|music|hudba|spoluprac|sponsor|kod|code|slev|discount|kontakt|email)", RegexOption.IGNORE_CASE)
    private val QTY_LINE = Regex("^\\W*(\\d+[.,]?\\d*|[½¼¾⅓⅔]|\\d+\\s*[-–]\\s*\\d+)\\s*(\\p{L}{1,3}\\.?\\s|\\p{L}{4,}\\s|$)")
    private val BULLET_LINE = Regex("^\\s*[-•*·–—✓▪◦]\\s*\\S")
    private val NUMBERED = Regex("^\\s*(\\d{1,2})[.)]\\s+(.+)$")
    private val STOP = setOf("recept", "recipe", "video", "jidlo", "jidla", "food", "easy", "quick", "rychly", "rychle", "jednoduch", "nejlepsi", "best", "homemade", "domaci", "tasty", "delicious", "dobrota", "with", "and", "the", "for", "from", "this", "that", "jak", "udelat", "make", "how", "shorts", "reel", "reels", "viral", "fyp", "foodie", "cooking", "vareni", "kuchyne", "kitchen", "youtube", "instagram", "tiktok")

    fun extract(title: String, description: String, transcript: String = ""): Result {
        val lines = description.replace("\r", "").split('\n').map { it.trim() }
        val ingredients = mutableListOf<Ingredient>()
        val steps = mutableListOf<String>()

        // 1) sekce „Ingredience:“ … „Postup:“
        var mode = 0 // 0 nic, 1 ingredience, 2 postup
        var blank = 0
        for (line in lines) {
            val folded = TextUtil.fold(line)
            if (line.isEmpty()) { blank++; if (blank >= 2) mode = 0; continue }
            blank = 0
            when {
                ING_HEADER.matches(folded) -> { mode = 1; continue }
                STEP_HEADER.matches(folded) -> { mode = 2; continue }
                mode != 0 && END_SECTION.containsMatchIn(folded) && !QTY_LINE.containsMatchIn(folded) -> { mode = 0; continue }
            }
            when (mode) {
                1 -> Ingredient.parseLine(line)?.let { if (it.name.length <= 80) ingredients.add(it) }
                2 -> { val m = NUMBERED.find(line); steps.add((m?.groupValues?.get(2) ?: line).trimStart('-', '•', '*', ' ')) }
            }
        }

        // 2) bez sekce: řádky začínající množstvím nebo odrážkou, které zmiňují surovinu
        if (ingredients.isEmpty()) {
            for (line in lines) {
                if (line.isEmpty() || line.length > 120) continue
                val folded = TextUtil.fold(line)
                val looksLikeIngredient = QTY_LINE.containsMatchIn(folded) || (BULLET_LINE.containsMatchIn(line) && IngredientDictionary.canonical(line) != null)
                if (looksLikeIngredient && !END_SECTION.containsMatchIn(folded)) Ingredient.parseLine(line)?.let { ingredients.add(it) }
            }
        }
        if (steps.isEmpty()) {
            for (line in lines) { val m = NUMBERED.find(line) ?: continue; if (m.groupValues[2].length > 12 && !ING_HEADER.matches(TextUtil.fold(line))) steps.add(m.groupValues[2]) }
        }

        // 3) suroviny zmíněné kdekoli v textu (popis, titulky, název) – doplní se bez množství
        val known = ingredients.map { TextUtil.fold(it.name) }
        val mentioned = IngredientDictionary.findAll(title + "\n" + description + "\n" + transcript)
        for (name in mentioned) {
            val f = TextUtil.fold(name)
            val stem = f.take(4)
            if (known.none { it.contains(stem) } && ingredients.none { IngredientDictionary.canonical(it.name) == name }) ingredients.add(Ingredient(name))
        }

        // klíčová slova: základní názvy surovin, hashtagy, slova z názvu
        val keywords = LinkedHashSet<String>()
        ingredients.forEach { ing -> keywords.add(IngredientDictionary.canonical(ing.name) ?: ing.name.lowercase()) }
        Regex("#([\\p{L}\\p{N}_]{3,})").findAll(description).forEach { keywords.add(it.groupValues[1].lowercase()) }
        Regex("[\\p{L}]{4,}").findAll(title).map { it.value.lowercase() }.filter { TextUtil.fold(it) !in STOP }.forEach { keywords.add(it) }

        val confidence = when {
            ingredients.count { it.amount.isNotEmpty() } >= 3 -> "medium"
            ingredients.isNotEmpty() -> "low"
            else -> "none"
        }
        val summary = lines.firstOrNull { it.length in 20..300 && !ING_HEADER.matches(TextUtil.fold(it)) && !QTY_LINE.containsMatchIn(it) && !it.startsWith("#") && !it.startsWith("http") }.orEmpty()
        return Result(cleanTitle(title), ingredients, steps, keywords.toMutableList(), summary, confidence)
    }

    /** Odstraní z názvu videa hashtagy, emoji, „| Kanál“ a podobný balast. */
    fun cleanTitle(title: String): String {
        var t = title
        t = Regex("#[\\p{L}\\p{N}_]+").replace(t, " ")
        t = Regex("[\\p{So}\\p{Cn}\\uFE0F]").replace(t, " ")
        t = t.substringBefore(" | ").substringBefore(" – YouTube").substringBefore(" - YouTube")
        t = Regex("\\s{2,}").replace(t, " ").trim().trim('-', '–', '|', ':', ' ')
        return t
    }
}
