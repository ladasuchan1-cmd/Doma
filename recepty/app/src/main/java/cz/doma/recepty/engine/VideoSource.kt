package cz.doma.recepty.engine

import java.net.URLDecoder

/** Rozpoznání platformy a ID videa z odkazu (YouTube, Instagram, TikTok, Facebook, web). Čistý Kotlin, bez Androidu. */
object VideoSource {
    enum class Platform(val label: String) {
        YOUTUBE("YouTube"), INSTAGRAM("Instagram"), TIKTOK("TikTok"), FACEBOOK("Facebook"), WEB("Web")
    }

    data class Info(val platform: Platform, val videoId: String, val canonicalUrl: String, val originalUrl: String)

    private val URL_RE = Regex("https?://[^\\s<>\"']+", RegexOption.IGNORE_CASE)
    private val YT_ID = "[A-Za-z0-9_-]{11}"

    /** První URL ve sdíleném textu (Instagram a YouTube posílají jen odkaz, TikTok i text). */
    fun extractUrl(text: String?): String? {
        if (text.isNullOrBlank()) return null
        val m = URL_RE.find(text) ?: return null
        return m.value.trimEnd('.', ',', ')', ']', '!', '?')
    }

    fun detect(rawUrl: String): Info {
        val url = rawUrl.trim()
        val host = hostOf(url).removePrefix("www.").removePrefix("m.")
        val path = pathOf(url)

        // YouTube
        if (host == "youtu.be") {
            val id = path.trim('/').substringBefore('/')
            if (Regex(YT_ID).matches(id)) return Info(Platform.YOUTUBE, id, "https://www.youtube.com/watch?v=$id", url)
        }
        if (host.endsWith("youtube.com") || host == "youtube-nocookie.com") {
            val v = queryParam(url, "v")
            val id = when {
                v != null && Regex(YT_ID).matches(v) -> v
                else -> Regex("^/(?:shorts|embed|live|v)/($YT_ID)").find(path)?.groupValues?.get(1)
            }
            if (id != null) return Info(Platform.YOUTUBE, id, "https://www.youtube.com/watch?v=$id", url)
        }

        // Instagram
        if (host.endsWith("instagram.com")) {
            val m = Regex("/(?:[A-Za-z0-9_.]+/)?(reels?|p|tv)/([A-Za-z0-9_-]+)").find(path)
            if (m != null) {
                val kind = if (m.groupValues[1] == "p") "p" else "reel"
                val code = m.groupValues[2]
                return Info(Platform.INSTAGRAM, code, "https://www.instagram.com/$kind/$code/", url)
            }
            return Info(Platform.INSTAGRAM, "", url, url)
        }

        // TikTok
        if (host.endsWith("tiktok.com")) {
            val m = Regex("/video/(\\d+)").find(path)
            if (m != null) return Info(Platform.TIKTOK, m.groupValues[1], url.substringBefore('?'), url)
            return Info(Platform.TIKTOK, "", url, url) // vm.tiktok.com / tiktok.com/t/… – rozbalí se přesměrováním
        }

        // Facebook
        if (host.endsWith("facebook.com") || host == "fb.watch" || host == "fb.com") {
            val m = Regex("/(?:reel|videos|watch)/?(\\d+)?").find(path)
            val id = m?.groupValues?.getOrNull(1).orEmpty().ifEmpty { queryParam(url, "v").orEmpty() }
            return Info(Platform.FACEBOOK, id, url, url)
        }

        return Info(Platform.WEB, "", url, url)
    }

    fun hostOf(url: String): String {
        val m = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+)").find(url) ?: return ""
        return m.groupValues[1].substringAfter('@').substringBefore(':').lowercase()
    }

    fun pathOf(url: String): String {
        val afterScheme = url.substringAfter("://", "")
        val slash = afterScheme.indexOf('/')
        if (slash < 0) return "/"
        return afterScheme.substring(slash).substringBefore('?').substringBefore('#')
    }

    fun queryParam(url: String, name: String): String? {
        val q = url.substringAfter('?', "").substringBefore('#')
        if (q.isEmpty()) return null
        for (pair in q.split('&')) {
            val k = pair.substringBefore('=')
            if (k == name) return try { URLDecoder.decode(pair.substringAfter('=', ""), "UTF-8") } catch (e: Exception) { pair.substringAfter('=', "") }
        }
        return null
    }
}
