package cz.doma.recepty.engine

import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder

/** Vše, co se o videu podařilo zjistit bez přihlášení: název, autor, popis (caption), titulky, náhled. */
class FetchedVideo(val info: VideoSource.Info) {
    var title = ""
    var author = ""
    var thumbnailUrl = ""
    var description = ""
    var transcript = ""
    /** Delší text stránky (recepty na webu) – pro model. */
    var pageText = ""
    /** schema.org/Recipe, pokud ho stránka nese. */
    var jsonLd: JSONObject? = null
    val problems = mutableListOf<String>()

    fun hasContent(): Boolean = description.length > 30 || transcript.length > 100 || pageText.length > 200 || jsonLd != null
    fun textLength(): Int = description.length + transcript.length + pageText.length
}

/**
 * Stažení metadat videa přes veřejné koncové body (oEmbed, HTML stránky). Bez API klíčů a přihlášení,
 * proto jde o „nejlepší snahu“ – hlavně Instagram někdy vrátí jen přihlašovací stránku; aplikace pak
 * nabídne doplnit popis ručně.
 */
object VideoFetcher {
    private const val MAX_TRANSCRIPT = 40_000
    private const val MAX_PAGE_TEXT = 60_000

    fun fetch(url: String): FetchedVideo {
        var info = VideoSource.detect(url)
        // krátké odkazy (vm.tiktok.com, fb.watch, youtu.be s parametry…) – nejdřív rozbalit
        if (info.videoId.isEmpty() && info.platform != VideoSource.Platform.WEB) {
            try {
                val r = Http.get(url)
                val resolved = VideoSource.detect(r.finalUrl)
                if (resolved.videoId.isNotEmpty() || resolved.platform != info.platform) info = resolved
            } catch (e: Exception) { /* zkusíme dál s původním odkazem */ }
        }
        val v = FetchedVideo(info)
        try {
            when (info.platform) {
                VideoSource.Platform.YOUTUBE -> youtube(v)
                VideoSource.Platform.INSTAGRAM -> instagram(v)
                VideoSource.Platform.TIKTOK -> tiktok(v)
                VideoSource.Platform.FACEBOOK, VideoSource.Platform.WEB -> web(v)
            }
        } catch (e: Exception) {
            v.problems.add("Stažení selhalo: " + (e.message ?: e.toString()))
        }
        v.title = v.title.trim()
        v.description = v.description.trim()
        return v
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private fun oembed(endpoint: String, v: FetchedVideo): JSONObject? {
        return try {
            val r = Http.get("$endpoint?url=${enc(v.info.canonicalUrl)}&format=json")
            if (!r.ok) { v.problems.add("oEmbed ${r.code}"); null } else JSONObject(r.body)
        } catch (e: Exception) { v.problems.add("oEmbed: " + e.message); null }
    }

    // ---------- YouTube ----------
    private fun youtube(v: FetchedVideo) {
        val id = v.info.videoId
        oembed("https://www.youtube.com/oembed", v)?.let {
            v.title = it.optString("title"); v.author = it.optString("author_name"); v.thumbnailUrl = it.optString("thumbnail_url")
        }
        if (v.thumbnailUrl.isEmpty()) v.thumbnailUrl = "https://i.ytimg.com/vi/$id/hqdefault.jpg"

        val page = try {
            Http.get("https://www.youtube.com/watch?v=$id&hl=cs&bpctr=9999999999&has_verified=1",
                headers = mapOf("Cookie" to "CONSENT=YES+cb.20240101-00-p0.cs+FX+000; SOCS=CAI; PREF=hl=cs"), desktop = true)
        } catch (e: Exception) { v.problems.add("Stránka videa: " + e.message); null }
        if (page != null && page.ok) {
            val html = page.body
            val vd = html.indexOf("\"videoDetails\":{")
            if (vd >= 0) {
                TextUtil.readJsonString(html, "shortDescription", vd)?.let { v.description = it }
                if (v.title.isEmpty()) TextUtil.readJsonString(html, "title", vd)?.let { v.title = it }
                if (v.author.isEmpty()) TextUtil.readJsonString(html, "author", vd)?.let { v.author = it }
            }
            if (v.description.isEmpty()) TextUtil.meta(html, "og:description")?.let { v.description = it }
            if (v.title.isEmpty()) TextUtil.meta(html, "og:title")?.let { v.title = it }
            v.transcript = youtubeCaptions(html, v)
        }
    }

    private fun youtubeCaptions(html: String, v: FetchedVideo): String {
        val at = html.indexOf("\"captionTracks\":[")
        if (at < 0) return ""
        val arr = try { JSONArray(TextUtil.readJsonValue(html, at + "\"captionTracks\":".length) ?: return "") } catch (e: Exception) { return "" }
        if (arr.length() == 0) return ""
        val tracks = (0 until arr.length()).map { arr.getJSONObject(it) }
        val prefLang = listOf("cs", "sk", "en")
        fun score(t: JSONObject): Int {
            val lang = t.optString("languageCode").substringBefore('-')
            val asr = t.optString("kind") == "asr"
            val li = prefLang.indexOf(lang).let { if (it < 0) 5 else it }
            return li * 2 + (if (asr) 1 else 0)
        }
        val best = tracks.minByOrNull { score(it) } ?: return ""
        val base = best.optString("baseUrl").replace("\\u0026", "&")
        if (base.isEmpty()) return ""
        return try {
            val r = Http.get("$base&fmt=json3")
            if (!r.ok) return ""
            val text = if (r.body.trimStart().startsWith("{")) parseJson3(r.body) else TextUtil.htmlToText(r.body)
            TextUtil.truncate(text, MAX_TRANSCRIPT)
        } catch (e: Exception) { v.problems.add("Titulky: " + e.message); "" }
    }

    private fun parseJson3(body: String): String {
        val events = JSONObject(body).optJSONArray("events") ?: return ""
        val sb = StringBuilder()
        for (i in 0 until events.length()) {
            val segs = events.getJSONObject(i).optJSONArray("segs") ?: continue
            for (j in 0 until segs.length()) sb.append(segs.getJSONObject(j).optString("utf8"))
            sb.append(' ')
        }
        return Regex("\\s+").replace(sb.toString(), " ").trim()
    }

    // ---------- Instagram ----------
    private fun instagram(v: FetchedVideo) {
        val code = v.info.videoId
        if (code.isNotEmpty()) {
            // Vložená (embed) stránka s popiskem je dostupná bez přihlášení častěji než hlavní stránka příspěvku
            try {
                val r = Http.get("https://www.instagram.com/p/$code/embed/captioned/", desktop = true)
                if (r.ok) parseInstagramEmbed(r.body, v)
                else v.problems.add("Instagram embed ${r.code}")
            } catch (e: Exception) { v.problems.add("Instagram embed: " + e.message) }
        }
        if (v.description.isEmpty() || v.thumbnailUrl.isEmpty()) {
            try {
                val r = Http.get(v.info.canonicalUrl, desktop = true)
                if (r.ok && !r.finalUrl.contains("/accounts/login")) {
                    val html = r.body
                    if (v.description.isEmpty()) {
                        TextUtil.readJsonString(html, "text", html.indexOf("edge_media_to_caption").coerceAtLeast(0)).takeIf { html.contains("edge_media_to_caption") }?.let { v.description = it }
                    }
                    if (v.description.isEmpty()) TextUtil.meta(html, "og:description")?.let { v.description = it }
                    if (v.thumbnailUrl.isEmpty()) TextUtil.meta(html, "og:image")?.let { v.thumbnailUrl = it }
                    if (v.title.isEmpty()) TextUtil.meta(html, "og:title")?.let { v.title = it }
                } else v.problems.add("Instagram vyžaduje přihlášení – popisek se nepodařilo stáhnout.")
            } catch (e: Exception) { v.problems.add("Instagram: " + e.message) }
        }
        // og:title bývá „Autor on Instagram: "popisek…"“
        val m = Regex("^(.+?) on Instagram: [\"“](.*)[\"”]$", RegexOption.DOT_MATCHES_ALL).find(v.title)
        if (m != null) {
            if (v.author.isEmpty()) v.author = m.groupValues[1].trim()
            if (v.description.isEmpty()) v.description = m.groupValues[2].trim()
            v.title = ""
        }
        if (v.title.isEmpty()) v.title = firstLine(v.description)
    }

    private fun parseInstagramEmbed(html: String, v: FetchedVideo) {
        val capStart = html.indexOf("class=\"Caption\"")
        if (capStart >= 0) {
            val end = html.indexOf("class=\"CaptionComments\"", capStart).let { if (it < 0) html.indexOf("</div>", capStart) else it }
            val chunk = if (end > capStart) html.substring(capStart, end) else html.substring(capStart)
            val userM = Regex("class=\"CaptionUsername\"[^>]*>([\\s\\S]*?)</a>").find(chunk)
            if (userM != null) v.author = TextUtil.htmlToText(userM.groupValues[1]).trim()
            var text = TextUtil.htmlToText(chunk.replace(Regex("<a class=\"CaptionUsername\"[\\s\\S]*?</a>"), ""))
            text = text.lines().dropWhile { it.isBlank() }.joinToString("\n").trim()
            if (text.isNotEmpty()) v.description = text
        }
        if (v.author.isEmpty()) Regex("class=\"UsernameText\"[^>]*>([^<]+)<").find(html)?.let { v.author = TextUtil.decodeEntities(it.groupValues[1]).trim() }
        Regex("class=\"EmbeddedMediaImage\"[^>]*src=\"([^\"]+)\"").find(html)?.let { v.thumbnailUrl = TextUtil.decodeEntities(it.groupValues[1]) }
        if (v.thumbnailUrl.isEmpty()) Regex("<img[^>]+src=\"(https://[^\"]*(?:cdninstagram|fbcdn)[^\"]+)\"").find(html)?.let { v.thumbnailUrl = TextUtil.decodeEntities(it.groupValues[1]) }
        if (v.description.isEmpty() && html.contains("\"caption\":\"")) TextUtil.readJsonString(html, "caption")?.let { v.description = it }
    }

    // ---------- TikTok ----------
    private fun tiktok(v: FetchedVideo) {
        oembed("https://www.tiktok.com/oembed", v)?.let {
            v.description = it.optString("title"); v.author = it.optString("author_name"); v.thumbnailUrl = it.optString("thumbnail_url")
        }
        if (v.description.isEmpty()) web(v)
        if (v.title.isEmpty()) v.title = firstLine(v.description)
    }

    // ---------- Facebook / web ----------
    private fun web(v: FetchedVideo) {
        val r = Http.get(v.info.canonicalUrl, desktop = true)
        if (!r.ok) { v.problems.add("Stránka vrátila ${r.code}"); return }
        val html = r.body
        if (v.title.isEmpty()) v.title = TextUtil.meta(html, "og:title") ?: TextUtil.title(html).orEmpty()
        if (v.description.isEmpty()) v.description = TextUtil.meta(html, "og:description") ?: TextUtil.meta(html, "description").orEmpty()
        if (v.thumbnailUrl.isEmpty()) v.thumbnailUrl = TextUtil.meta(html, "og:image").orEmpty()
        if (v.author.isEmpty()) v.author = TextUtil.meta(html, "author") ?: TextUtil.meta(html, "og:site_name").orEmpty()
        v.jsonLd = TextUtil.jsonLdRecipe(html)
        if (v.info.platform == VideoSource.Platform.WEB) {
            v.pageText = TextUtil.truncate(TextUtil.htmlToText(html), MAX_PAGE_TEXT)
        }
    }

    private fun firstLine(s: String): String {
        val line = s.lines().map { it.trim() }.firstOrNull { it.isNotEmpty() } ?: return ""
        return TextUtil.truncate(line.substringBefore(". ").ifBlank { line }, 80)
    }
}
