package cz.doma.recepty.data

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray

/**
 * Úložiště receptů: tabulka `recipes` + fulltextový index `recipes_fts` (FTS4, unicode61 bez diakritiky),
 * takže „kure“ najde „Kuřecí“. Index se udržuje ručně při každém zápisu.
 */
class RecipeDb(context: Context) : SQLiteOpenHelper(context.applicationContext, "recepty.db", null, 1) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("""
            CREATE TABLE recipes (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              created_at INTEGER NOT NULL,
              url TEXT NOT NULL,
              platform TEXT NOT NULL DEFAULT '',
              video_id TEXT NOT NULL DEFAULT '',
              title TEXT NOT NULL DEFAULT '',
              author TEXT NOT NULL DEFAULT '',
              thumbnail_url TEXT NOT NULL DEFAULT '',
              thumb_path TEXT NOT NULL DEFAULT '',
              description TEXT NOT NULL DEFAULT '',
              transcript TEXT NOT NULL DEFAULT '',
              summary TEXT NOT NULL DEFAULT '',
              ingredients TEXT NOT NULL DEFAULT '[]',
              steps TEXT NOT NULL DEFAULT '[]',
              keywords TEXT NOT NULL DEFAULT '[]',
              cuisine TEXT NOT NULL DEFAULT '',
              category TEXT NOT NULL DEFAULT '',
              time_minutes INTEGER,
              servings INTEGER,
              engine TEXT NOT NULL DEFAULT '',
              confidence TEXT NOT NULL DEFAULT '',
              notes TEXT NOT NULL DEFAULT '',
              needs_review INTEGER NOT NULL DEFAULT 0,
              error TEXT NOT NULL DEFAULT ''
            )
        """.trimIndent())
        db.execSQL("CREATE UNIQUE INDEX idx_recipes_url ON recipes(url)")
        db.execSQL("CREATE VIRTUAL TABLE recipes_fts USING fts4(title, ingredients, body, tokenize=unicode61 \"remove_diacritics=1\")")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

    fun insert(r: Recipe): Long {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val id = db.insertOrThrow("recipes", null, values(r))
            r.id = id
            indexRecipe(db, r)
            db.setTransactionSuccessful()
            return id
        } finally { db.endTransaction() }
    }

    fun update(r: Recipe) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.update("recipes", values(r), "id=?", arrayOf(r.id.toString()))
            db.delete("recipes_fts", "docid=?", arrayOf(r.id.toString()))
            indexRecipe(db, r)
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    fun delete(id: Long) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.delete("recipes", "id=?", arrayOf(id.toString()))
            db.delete("recipes_fts", "docid=?", arrayOf(id.toString()))
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    private fun indexRecipe(db: SQLiteDatabase, r: Recipe) {
        val cv = ContentValues()
        cv.put("docid", r.id)
        cv.put("title", r.title)
        cv.put("ingredients", r.ingredientText())
        cv.put("body", r.bodyText())
        db.insertOrThrow("recipes_fts", null, cv)
    }

    fun get(id: Long): Recipe? = readableDatabase.query("recipes", null, "id=?", arrayOf(id.toString()), null, null, null).use { c ->
        if (c.moveToFirst()) read(c) else null
    }

    fun findByUrl(url: String): Recipe? = readableDatabase.query("recipes", null, "url=?", arrayOf(url), null, null, null).use { c ->
        if (c.moveToFirst()) read(c) else null
    }

    fun count(): Int = readableDatabase.rawQuery("SELECT COUNT(*) FROM recipes", null).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }

    /**
     * Vyhledávání: prázdný dotaz = vše (nejnovější první). Jinak fulltext podle předpon slov;
     * recepty se shodou v názvu nebo ingrediencích jsou řazeny výš.
     */
    fun search(query: String?, limit: Int = 500): List<Recipe> {
        val parsed = SearchQuery.parse(query)
        val db = readableDatabase
        val exclude = if (parsed.excludeMatch == null) "" else " AND r.id NOT IN (SELECT docid FROM recipes_fts WHERE recipes_fts MATCH ?)"
        if (parsed.match == null) {
            val sql = "SELECT r.* FROM recipes r WHERE 1=1$exclude ORDER BY r.created_at DESC LIMIT $limit"
            val args = if (parsed.excludeMatch == null) null else arrayOf(parsed.excludeMatch)
            return db.rawQuery(sql, args).use { readAll(it) }
        }
        val sql = """
            SELECT r.*, (CASE WHEN f.docid IN (SELECT docid FROM recipes_fts WHERE title MATCH ?) THEN 2 ELSE 0 END)
                      + (CASE WHEN f.docid IN (SELECT docid FROM recipes_fts WHERE ingredients MATCH ?) THEN 1 ELSE 0 END) AS rank
            FROM recipes_fts f JOIN recipes r ON r.id = f.docid
            WHERE f MATCH ?$exclude
            ORDER BY rank DESC, r.created_at DESC LIMIT $limit
        """.trimIndent()
        val args = mutableListOf(parsed.match, parsed.match, parsed.match)
        parsed.excludeMatch?.let { args.add(it) }
        return try {
            db.rawQuery(sql, args.toTypedArray()).use { readAll(it) }
        } catch (e: Exception) {
            // neplatný MATCH výraz – záloha přes LIKE na názvu
            db.rawQuery("SELECT * FROM recipes WHERE title LIKE ? ORDER BY created_at DESC LIMIT $limit", arrayOf("%${query!!.trim()}%")).use { readAll(it) }
        }
    }

    /** Nejčastější klíčová slova / ingredience napříč recepty (pro rychlé filtry). */
    fun topKeywords(limit: Int = 30): List<Pair<String, Int>> {
        val counts = HashMap<String, Int>()
        readableDatabase.rawQuery("SELECT ingredients, keywords FROM recipes", null).use { c ->
            while (c.moveToNext()) {
                val seen = HashSet<String>()
                for (ing in Recipe.parseIngredients(safeArray(c.getString(0)))) seen.add(ing.name.lowercase().trim())
                for (k in cz.doma.recepty.engine.TextUtil.strings(safeArray(c.getString(1)))) seen.add(k.lowercase().trim())
                for (s in seen) if (s.length in 3..30) counts[s] = (counts[s] ?: 0) + 1
            }
        }
        return counts.entries.filter { it.value >= 2 || counts.size < 12 }.sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key }).take(limit).map { it.key to it.value }
    }

    fun exportAll(): JSONArray {
        val arr = JSONArray()
        readableDatabase.rawQuery("SELECT * FROM recipes ORDER BY created_at", null).use { c -> while (c.moveToNext()) arr.put(read(c).toJson()) }
        return arr
    }

    /** Import zálohy; recepty se stejným URL se přeskočí. Vrací počet přidaných. */
    fun importAll(arr: JSONArray): Int {
        var n = 0
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val r = Recipe.fromJson(o)
            r.id = 0
            if (r.url.isEmpty() || findByUrl(r.url) != null) continue
            insert(r); n++
        }
        return n
    }

    private fun values(r: Recipe): ContentValues = ContentValues().apply {
        put("created_at", r.createdAt); put("url", r.url); put("platform", r.platform); put("video_id", r.videoId)
        put("title", r.title); put("author", r.author); put("thumbnail_url", r.thumbnailUrl); put("thumb_path", r.thumbPath)
        put("description", r.description); put("transcript", r.transcript); put("summary", r.summary)
        put("ingredients", JSONArray().also { a -> r.ingredients.forEach { a.put(it.toJson()) } }.toString())
        put("steps", JSONArray(r.steps).toString()); put("keywords", JSONArray(r.keywords).toString())
        put("cuisine", r.cuisine); put("category", r.category)
        if (r.timeMinutes == null) putNull("time_minutes") else put("time_minutes", r.timeMinutes)
        if (r.servings == null) putNull("servings") else put("servings", r.servings)
        put("engine", r.engine); put("confidence", r.confidence); put("notes", r.notes)
        put("needs_review", if (r.needsReview) 1 else 0); put("error", r.error)
    }

    private fun readAll(c: Cursor): List<Recipe> { val out = ArrayList<Recipe>(); while (c.moveToNext()) out.add(read(c)); return out }

    private fun safeArray(s: String?): JSONArray? = try { if (s.isNullOrEmpty()) null else JSONArray(s) } catch (e: Exception) { null }

    private fun read(c: Cursor): Recipe {
        fun s(col: String) = c.getString(c.getColumnIndexOrThrow(col)) ?: ""
        fun i(col: String): Int? { val ix = c.getColumnIndexOrThrow(col); return if (c.isNull(ix)) null else c.getInt(ix) }
        return Recipe(
            id = c.getLong(c.getColumnIndexOrThrow("id")), createdAt = c.getLong(c.getColumnIndexOrThrow("created_at")),
            url = s("url"), platform = s("platform"), videoId = s("video_id"), title = s("title"), author = s("author"),
            thumbnailUrl = s("thumbnail_url"), thumbPath = s("thumb_path"), description = s("description"), transcript = s("transcript"),
            summary = s("summary"), ingredients = Recipe.parseIngredients(safeArray(s("ingredients"))),
            steps = cz.doma.recepty.engine.TextUtil.strings(safeArray(s("steps"))), keywords = cz.doma.recepty.engine.TextUtil.strings(safeArray(s("keywords"))),
            cuisine = s("cuisine"), category = s("category"), timeMinutes = i("time_minutes"), servings = i("servings"),
            engine = s("engine"), confidence = s("confidence"), notes = s("notes"),
            needsReview = c.getInt(c.getColumnIndexOrThrow("needs_review")) == 1, error = s("error"),
        )
    }

    companion object {
        @Volatile private var instance: RecipeDb? = null
        fun get(context: Context): RecipeDb = instance ?: synchronized(this) { instance ?: RecipeDb(context).also { instance = it } }
    }
}
