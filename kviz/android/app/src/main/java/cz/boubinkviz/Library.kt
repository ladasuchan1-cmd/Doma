package cz.boubinkviz

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File

/** Kvízy z assets/kviz a ukázky (filmy, hudba), které si uživatel nahrál do aplikace. */
class Library(private val context: Context) {
    class Clip(val key: String, val names: List<String>, val label: String)
    class Quiz(val file: String, val title: String, val rounds: List<String>, val clips: List<Clip>)
    class Source(val name: String, val uri: Uri, val size: Long)

    val quizzes: List<Quiz> by lazy {
        (context.assets.list("kviz") ?: emptyArray()).filter { it.endsWith(".html") }.sorted().mapNotNull { f ->
            runCatching { parse(f, context.assets.open("kviz/$f").bufferedReader().use { it.readText() }) }.getOrNull()
        }
    }
    private val clips: List<Clip> get() = quizzes.flatMap { it.clips }.distinctBy { it.key }

    private val mediaDir = File(context.filesDir, "media").apply {
        mkdirs()
        listFiles()?.filter { it.name.endsWith(".part") }?.forEach { it.delete() }
    }

    private fun stored(): Map<String, File> =
        (mediaDir.listFiles() ?: emptyArray()).filter { it.isFile && !it.name.endsWith(".part") }
            .associateBy { it.name.substringBeforeLast('.') }

    /** Soubor pro požadavek kvízu, např. „videos/TITANIC.mp4“ – složka nehraje roli, páruje se podle názvu. */
    fun mediaFor(name: String): File? = stored()[Names.norm(name)]

    fun state(busy: Boolean): JSONObject {
        val have = stored()
        val qs = JSONArray()
        for (q in quizzes) {
            val list = JSONArray()
            q.clips.forEach { list.put(JSONObject().put("label", it.label).put("have", it.key in have)) }
            qs.put(JSONObject().put("file", q.file).put("title", q.title).put("rounds", JSONArray(q.rounds))
                .put("clips", list).put("have", q.clips.count { it.key in have }).put("total", q.clips.size))
        }
        val all = clips
        return JSONObject().put("quizzes", qs).put("busy", busy).put("media", JSONObject()
            .put("have", all.count { it.key in have }).put("total", all.size)
            .put("bytes", have.values.sumOf { it.length() }))
    }

    fun deleteMedia() { mediaDir.listFiles()?.forEach { it.delete() } }

    /** Vybrané soubory (výběr z Disku Google, Stažených…). */
    fun sourcesFromUris(uris: List<Uri>): List<Source> = uris.map { uri ->
        var name = uri.lastPathSegment ?: "soubor"
        var size = -1L
        runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getString(0)?.let { name = it }
                    if (!c.isNull(1)) size = c.getLong(1)
                }
            }
        }
        Source(name, uri, size)
    }

    /** Všechny mediální soubory ve vybrané složce včetně podsložek. */
    fun sourcesFromTree(tree: Uri): List<Source> {
        val out = ArrayList<Source>()
        val cols = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE)
        fun walk(docId: String, depth: Int) {
            if (depth > 6) return
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
            context.contentResolver.query(children, cols, null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getString(0) ?: continue
                    val name = c.getString(1) ?: continue
                    if (c.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) walk(id, depth + 1)
                    else if (Names.MEDIA_EXT.containsMatchIn(name))
                        out += Source(name, DocumentsContract.buildDocumentUriUsingTree(tree, id), if (c.isNull(3)) -1 else c.getLong(3))
                }
            }
        }
        walk(DocumentsContract.getTreeDocumentId(tree), 0)
        return out
    }

    /**
     * Spáruje vybrané soubory s ukázkami kvízů a chybějící zkopíruje do aplikace.
     * Soubory, které kvízy nepotřebují, přeskočí; už nahrané ukázky nepřepisuje.
     */
    fun import(sources: List<Source>, progress: (JSONObject) -> Unit): JSONObject {
        val all = clips
        val matches = Names.assign(all.map { it.key to it.names }, sources.map { it.name to it })
        val have = stored().keys
        val todo = all.filter { it.key in matches && it.key !in have }
        val copied = JSONArray()
        val failed = JSONArray()
        todo.forEachIndexed { i, clip ->
            val m = matches.getValue(clip.key)
            try {
                copy(m.item, clip.key) { done -> progress(JSONObject().put("index", i + 1).put("count", todo.size)
                    .put("name", m.item.name).put("done", done).put("size", m.item.size)) }
                copied.put(JSONObject().put("label", clip.label).put("from", m.item.name).put("exact", m.exact))
            } catch (e: Exception) {
                failed.put(JSONObject().put("label", clip.label).put("error", e.message ?: e.toString()))
            }
        }
        val usedNames = matches.values.map { it.item }.toSet()
        val now = stored().keys
        return JSONObject().put("copied", copied).put("failed", failed)
            .put("kept", matches.keys.count { it in have })
            .put("unused", sources.count { it !in usedNames })
            .put("selected", sources.size)
            .put("missing", JSONArray(all.filter { it.key !in now }.map { it.label }))
    }

    /** Ruční přiřazení jednoho souboru ke konkrétní ukázce (tlačítko „Vybrat tento soubor“ v kvízu). */
    fun importOne(source: Source, clipName: String, progress: (JSONObject) -> Unit): JSONObject {
        val key = Names.norm(clipName)
        val label = clips.firstOrNull { it.key == key }?.label ?: clipName
        copy(source, key) { done -> progress(JSONObject().put("index", 1).put("count", 1).put("name", source.name)
            .put("done", done).put("size", source.size)) }
        return JSONObject().put("copied", JSONArray().put(JSONObject().put("label", label).put("from", source.name).put("exact", true)))
            .put("failed", JSONArray()).put("kept", 0).put("unused", 0).put("selected", 1)
            .put("missing", JSONArray(clips.filter { it.key !in stored().keys }.map { it.label }))
    }

    private fun copy(src: Source, key: String, progress: (Long) -> Unit) {
        val ext = src.name.substringAfterLast('.', "").lowercase().takeIf { it.matches(Regex("[a-z0-9]{2,4}")) } ?: "mp4"
        val part = File(mediaDir, "$key.$ext.part")
        val input = context.contentResolver.openInputStream(src.uri) ?: throw IllegalStateException("Soubor nejde otevřít")
        input.use { inp ->
            part.outputStream().use { out ->
                val buf = ByteArray(256 * 1024)
                var done = 0L
                var last = 0L
                while (true) {
                    val n = inp.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    done += n
                    val t = System.currentTimeMillis()
                    if (t - last > 250) { last = t; progress(done) }
                }
                progress(done)
            }
        }
        stored()[key]?.delete()
        if (!part.renameTo(File(mediaDir, "$key.$ext"))) { part.delete(); throw IllegalStateException("Soubor nejde uložit") }
    }

    companion object {
        /** Názvy okruhů a ukázky (položky typu „m“) z pole BLOCKS uvnitř HTML kvízu. */
        fun parse(file: String, html: String): Quiz {
            val title = Regex("<title>(.*?)</title>", RegexOption.DOT_MATCHES_ALL).find(html)?.groupValues?.get(1)?.trim() ?: file
            val at = html.indexOf("const BLOCKS")
            require(at >= 0) { "V $file chybí BLOCKS" }
            val blocks = JSONTokener(html.substring(html.indexOf('[', at))).nextValue() as JSONArray
            val rounds = ArrayList<String>()
            val clips = ArrayList<Clip>()
            for (b in 0 until blocks.length()) {
                val block = blocks.getJSONArray(b)
                for (r in 0 until block.length()) {
                    val round = block.getJSONObject(r)
                    val name = round.optString("name")
                    rounds += name
                    val items = round.getJSONArray("items")
                    for (i in 0 until items.length()) {
                        val it = items.getJSONObject(i)
                        val f = it.optJSONArray("f")
                        if (it.optString("t") != "m" || f == null || f.length() == 0) continue
                        val names = (0 until f.length()).map { f.getString(it) }
                        clips += Clip(Names.norm(names[0]), names, "$name ${i + 1} · ${names[0]}")
                    }
                }
            }
            return Quiz(file, title, rounds, clips)
        }
    }
}
