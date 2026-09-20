import cz.doma.recepty.data.Ingredient
import cz.doma.recepty.data.Recipe
import cz.doma.recepty.data.SearchQuery
import cz.doma.recepty.engine.IngredientDictionary
import cz.doma.recepty.engine.LocalExtractor
import cz.doma.recepty.engine.TextUtil
import cz.doma.recepty.engine.VideoSource
import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class VideoSourceTest {
    @Test fun youtubeVariants() {
        for (u in listOf("https://youtu.be/dQw4w9WgXcQ?si=abc", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s", "https://youtube.com/shorts/dQw4w9WgXcQ?feature=share", "https://m.youtube.com/watch?feature=x&v=dQw4w9WgXcQ")) {
            val i = VideoSource.detect(u)
            assertEquals(VideoSource.Platform.YOUTUBE, i.platform, u)
            assertEquals("dQw4w9WgXcQ", i.videoId, u)
            assertEquals("https://www.youtube.com/watch?v=dQw4w9WgXcQ", i.canonicalUrl)
        }
    }
    @Test fun instagram() {
        val i = VideoSource.detect("https://www.instagram.com/reel/C8abcDEfGh1/?igsh=xyz")
        assertEquals(VideoSource.Platform.INSTAGRAM, i.platform); assertEquals("C8abcDEfGh1", i.videoId)
        assertEquals("https://www.instagram.com/reel/C8abcDEfGh1/", i.canonicalUrl)
        assertEquals("https://www.instagram.com/p/C8abcDEfGh1/", VideoSource.detect("https://instagram.com/p/C8abcDEfGh1").canonicalUrl)
        assertEquals("C8abcDEfGh1", VideoSource.detect("https://www.instagram.com/kuchar/reel/C8abcDEfGh1/").videoId)
    }
    @Test fun tiktokAndWeb() {
        assertEquals("7300000000000000000", VideoSource.detect("https://www.tiktok.com/@user/video/7300000000000000000?is_from_webapp=1").videoId)
        assertEquals(VideoSource.Platform.TIKTOK, VideoSource.detect("https://vm.tiktok.com/ZGeAbCdEf/").platform)
        assertEquals(VideoSource.Platform.WEB, VideoSource.detect("https://www.kucharkaprodceru.cz/recept").platform)
    }
    @Test fun extractUrlFromSharedText() {
        assertEquals("https://youtu.be/dQw4w9WgXcQ", VideoSource.extractUrl("Podívej na to! https://youtu.be/dQw4w9WgXcQ."))
        assertNull(VideoSource.extractUrl("žádný odkaz"))
    }
}

class IngredientTest {
    @Test fun parseLines() {
        assertEquals(Ingredient("hladká mouka", "200", "g"), Ingredient.parseLine("- 200 g hladká mouka"))
        assertEquals(Ingredient("vejce", "2", "ks"), Ingredient.parseLine("2ks vejce"))
        assertEquals(Ingredient("česneku", "3", "stroužky", "nasekaného"), Ingredient.parseLine("3 stroužky česneku (nasekaného)"))
        assertEquals(Ingredient("cukr", "1/2", "hrnku"), Ingredient.parseLine("• 1/2 hrnku cukr"))
        assertEquals(Ingredient("mléka", "1 1/2", "cup"), Ingredient.parseLine("1 1/2 cup mléka"))
        assertEquals(Ingredient("sůl"), Ingredient.parseLine("sůl"))
        assertEquals(Ingredient("mouka", "200", "g"), Ingredient.parseLine("mouka – 200 g"))
        assertEquals(Ingredient("olivový olej", "2", "polévkové lžíce"), Ingredient.parseLine("2 polévkové lžíce olivový olej"))
        assertNull(Ingredient.parseLine("   "))
    }
    @Test fun displayAndJsonRoundTrip() {
        val i = Ingredient("kuřecí prsa", "400", "g", "na kostky")
        assertEquals("400 g kuřecí prsa (na kostky)", i.display())
        assertEquals(i, Ingredient.fromJson(i.toJson()))
        val r = Recipe(url = "https://x", title = "T", ingredients = mutableListOf(i), steps = mutableListOf("a"), keywords = mutableListOf("k"), timeMinutes = 20)
        val back = Recipe.fromJson(r.toJson())
        assertEquals("T", back.title); assertEquals(i, back.ingredients[0]); assertEquals(20, back.timeMinutes); assertNull(back.servings)
    }
}

class SearchQueryTest {
    @Test fun prefixesAndNegation() {
        val p = SearchQuery.parse("Kuře rýže, -smetana")
        assertEquals("kure* ryze*", p.match)
        assertEquals("smetana*", p.excludeMatch)
        assertEquals(listOf("kure", "ryze"), p.terms)
        assertNull(SearchQuery.parse("   ").match)
        assertNull(SearchQuery.parse("-smetana").match)
        assertEquals("smetana* OR mleko*", SearchQuery.parse("-smetana !mléko").excludeMatch)
        assertEquals(listOf("smetana"), SearchQuery.parse("-smetana").excluded)
    }
}

class TextUtilTest {
    @Test fun fold() { assertEquals("kureci prsa se smetanou", TextUtil.fold("Kuřecí Prsa se Smetanou")) }
    @Test fun jsonString() {
        val html = """{"videoDetails":{"videoId":"x","title":"Kuře na paprice","shortDescription":"Ingredience:\n200 g \"rýže\"č"}}"""
        assertEquals("Ingredience:\n200 g \"rýže\"č", TextUtil.readJsonString(html, "shortDescription"))
        assertEquals("[1,{\"a\":\"]\"}]", TextUtil.readJsonValue("x=[1,{\"a\":\"]\"}];", 2))
    }
    @Test fun htmlAndMeta() {
        val html = """<html><head><title>Test &amp; recept</title><meta content="Obrázek" property="og:image"><meta property="og:description" content="Popis &quot;x&quot;"/></head><body><script>var a=1;</script><p>Řádek 1</p><br>Řádek 2</body></html>"""
        assertEquals("Popis \"x\"", TextUtil.meta(html, "og:description"))
        assertEquals("Obrázek", TextUtil.meta(html, "og:image"))
        assertEquals("Test & recept", TextUtil.title(html))
        assertTrue(Regex("Řádek 1\\n+Řádek 2").containsMatchIn(TextUtil.htmlToText(html)))
    }
    @Test fun jsonLd() {
        val html = """<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":["Recipe","Thing"],"name":"Svíčková","recipeIngredient":["1 kg hovězí zadní","2 mrkve"]}]}</script>"""
        val r = TextUtil.jsonLdRecipe(html)
        assertNotNull(r); assertEquals("Svíčková", r.optString("name"))
    }
}

class LocalExtractorTest {
    @Test fun sectionedDescription() {
        val desc = """
            Nejlepší kuřecí curry 🍛 #recept #kure
            
            Ingredience:
            - 500 g kuřecích prsou
            - 400 ml kokosového mléka
            - 2 stroužky česneku
            - 1 lžíce kari
            - sůl
            
            Postup:
            1. Kuře nakrájíme na kostky a opečeme.
            2. Přidáme česnek, kari a kokosové mléko, dusíme 15 minut.
            
            Sledujte mě na Instagramu: https://instagram.com/x
        """.trimIndent()
        val r = LocalExtractor.extract("Kuřecí curry za 20 minut | Kuchař Pepa", desc)
        assertEquals("Kuřecí curry za 20 minut", r.title)
        assertEquals(listOf("kuřecích prsou", "kokosového mléka", "česneku", "kari", "sůl"), r.ingredients.take(5).map { it.name })
        assertEquals("500", r.ingredients[0].amount); assertEquals("g", r.ingredients[0].unit)
        assertEquals(2, r.steps.size)
        assertTrue(r.steps[0].startsWith("Kuře nakrájíme"))
        assertTrue("kuře" in r.keywords, r.keywords.toString())
        assertTrue("kokosové mléko" in r.keywords, r.keywords.toString())
        assertTrue("recept" in r.keywords)
        assertEquals("medium", r.confidence)
    }
    @Test fun noListFallsBackToDictionary() {
        val r = LocalExtractor.extract("Easy salmon pasta", "Creamy salmon pasta with spinach and garlic. So good!")
        val names = r.ingredients.map { it.name }
        assertTrue("losos" in names, names.toString()); assertTrue("těstoviny" in names); assertTrue("špenát" in names); assertTrue("česnek" in names)
        assertEquals("low", r.confidence)
    }
    @Test fun dictionaryCanonical() {
        assertEquals("kuře", IngredientDictionary.canonical("kuřecí prsa"))
        assertEquals("smetana", IngredientDictionary.canonical("zakysanou smetanou").let { if (it == "zakysaná smetana") "smetana" else it })
        assertEquals("česnek", IngredientDictionary.canonical("garlic cloves"))
        assertNull(IngredientDictionary.canonical("xyzzy"))
    }
}

class ClaudeRequestTest {
    @Test fun applyResult() {
        val r = Recipe(url = "u", description = "d")
        val out = JSONObject("""{"is_food":true,"title":"Kuřecí curry","summary":"s","ingredients":[{"name":"kuře","amount":"500","unit":"g","note":""},{"name":"kari","amount":"","unit":"","note":"odhad"}],"steps":["a","b"],"keywords":["Kuře","kari","Kuře"],"cuisine":"indická","category":"hlavní jídlo","time_minutes":null,"servings":4,"source_language":"cs","confidence":"high","_model":"claude-opus-5"}""")
        cz.doma.recepty.engine.ClaudeExtractor.apply(r, out)
        assertEquals("Kuřecí curry", r.title); assertEquals(2, r.ingredients.size); assertEquals(listOf("kuře", "kari"), r.keywords)
        assertNull(r.timeMinutes); assertEquals(4, r.servings); assertEquals("claude:claude-opus-5", r.engine); assertEquals(false, r.needsReview)
        assertEquals("d", r.description)
    }
}
