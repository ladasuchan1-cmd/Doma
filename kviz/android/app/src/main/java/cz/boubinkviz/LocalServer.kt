package cz.boubinkviz

import android.content.res.AssetManager
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileNotFoundException
import java.io.FilterInputStream
import java.io.InputStream
import java.io.RandomAccessFile
import java.nio.channels.Channels

/**
 * Obsluha adres https://appassets.androidplatform.net/… uvnitř WebView:
 *  /app/…   – menu a mobilní vrstva (assets/app)
 *  /kviz/…  – původní HTML kvízů (assets/kviz), do kterých se vloží mobile.css a bridge.js,
 *             pozadí (pozadi/x.png → x.jpg) a ukázky nahrané do aplikace (podle názvu souboru).
 */
class LocalServer(private val assets: AssetManager, private val library: Library) {

    fun handle(request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if (url.host != HOST) return null
        val path = url.path.orEmpty().trimStart('/')
        return when {
            Names.MEDIA_EXT.containsMatchIn(path) -> media(url, request.requestHeaders)
            path.startsWith("kviz/") && path.endsWith(".html") -> quizPage(path)
            path.startsWith("app/") || path.startsWith("kviz/") -> asset(path)
            else -> notFound()
        }
    }

    private fun quizPage(path: String): WebResourceResponse {
        val html = try { assets.open(path).bufferedReader().use { it.readText() } } catch (e: FileNotFoundException) { return notFound() }
        val out = html
            .replaceFirst("</head>", "<link rel=\"stylesheet\" href=\"/app/mobile.css\">\n</head>")
            .let { s -> s.lastIndexOf("</body>").let { i -> if (i < 0) s + BRIDGE else s.substring(0, i) + BRIDGE + s.substring(i) } }
        return WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(out.toByteArray()))
    }

    private fun asset(path: String): WebResourceResponse {
        // Pozadí jsou v aplikaci zmenšená do JPEG, kvíz je ale volá jako .png.
        for (p in listOf(path, path.replace(Regex("\\.png$"), ".jpg"))) {
            try { return WebResourceResponse(mime(p), null, assets.open(p)) } catch (_: FileNotFoundException) {}
        }
        return notFound()
    }

    private fun media(url: Uri, headers: Map<String, String>): WebResourceResponse {
        val file = library.mediaFor(url.lastPathSegment.orEmpty()) ?: return notFound()
        return serveFile(file, headers.entries.firstOrNull { it.key.equals("Range", true) }?.value)
    }

    private fun serveFile(file: File, rangeHeader: String?): WebResourceResponse {
        val len = file.length()
        val type = mime(file.name)
        val range = Ranges.parse(rangeHeader, len)
        val base = mutableMapOf("Accept-Ranges" to "bytes", "Cache-Control" to "no-cache")
        if (range == null) {
            return WebResourceResponse(type, null, 200, "OK", base + ("Content-Length" to "$len"), file.inputStream())
        }
        if (range.isEmpty()) {
            return WebResourceResponse(type, null, 416, "Range Not Satisfiable", base + ("Content-Range" to "bytes */$len"), ByteArrayInputStream(ByteArray(0)))
        }
        val count = range.last - range.first + 1
        val raf = RandomAccessFile(file, "r").apply { seek(range.first) }
        val body = Limited(Channels.newInputStream(raf.channel), count)
        return WebResourceResponse(type, null, 206, "Partial Content",
            base + mapOf("Content-Length" to "$count", "Content-Range" to "bytes ${range.first}-${range.last}/$len"), body)
    }

    /** Přečte z proudu nejvýš [left] bajtů. */
    private class Limited(input: InputStream, private var left: Long) : FilterInputStream(input) {
        override fun read(): Int = if (left <= 0) -1 else super.read().also { if (it >= 0) left-- }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (left <= 0) return -1
            val n = super.read(b, off, minOf(len.toLong(), left).toInt())
            if (n > 0) left -= n
            return n
        }
        override fun available(): Int = minOf(super.available().toLong(), left).toInt()
    }

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$HOST"
        private const val BRIDGE = "<script src=\"/app/bridge.js\"></script>\n"

        fun mime(name: String): String = when (name.substringAfterLast('.').lowercase()) {
            "html" -> "text/html"
            "css" -> "text/css"
            "js" -> "text/javascript"
            "json" -> "application/json"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "webp" -> "image/webp"
            "mp4", "m4v" -> "video/mp4"
            "webm" -> "video/webm"
            "mov" -> "video/quicktime"
            "mkv" -> "video/x-matroska"
            "mp3" -> "audio/mpeg"
            "m4a" -> "audio/mp4"
            "ogg" -> "audio/ogg"
            "wav" -> "audio/wav"
            else -> "application/octet-stream"
        }
    }
}
