package cz.doma.recepty.engine

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.Charset

/** Minimální HTTP klient nad HttpURLConnection (bez závislostí). */
object Http {
    private const val UA_MOBILE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36"
    private const val UA_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    private const val MAX_BYTES = 8 * 1024 * 1024

    class Response(val code: Int, val bytes: ByteArray, val contentType: String, val finalUrl: String) {
        val body: String by lazy { String(bytes, charsetOf(contentType)) }
        val ok: Boolean get() = code in 200..299
    }

    fun get(url: String, headers: Map<String, String> = emptyMap(), desktop: Boolean = false, timeoutMs: Int = 20000): Response {
        var current = url
        repeat(8) {
            val c = (URL(current).openConnection() as HttpURLConnection)
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
            c.instanceFollowRedirects = false
            c.setRequestProperty("User-Agent", if (desktop) UA_DESKTOP else UA_MOBILE)
            c.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,image/*;q=0.8,*/*;q=0.5")
            c.setRequestProperty("Accept-Language", "cs,sk;q=0.9,en;q=0.8")
            for ((k, v) in headers) c.setRequestProperty(k, v)
            try {
                val code = c.responseCode
                if (code in 300..399) {
                    val loc = c.getHeaderField("Location") ?: return Response(code, ByteArray(0), "", current)
                    current = URL(URL(current), loc).toString()
                    return@repeat
                }
                val ct = c.contentType ?: ""
                val stream = if (code >= 400) (c.errorStream ?: c.inputStream) else c.inputStream
                return Response(code, readLimited(stream), ct, current)
            } finally {
                c.disconnect()
            }
        }
        throw IllegalStateException("Příliš mnoho přesměrování: $url")
    }

    fun postJson(url: String, headers: Map<String, String>, body: String, timeoutMs: Int = 180000): Response {
        val c = (URL(url).openConnection() as HttpURLConnection)
        c.connectTimeout = 20000
        c.readTimeout = timeoutMs
        c.requestMethod = "POST"
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json")
        c.setRequestProperty("User-Agent", "Recepty/1.0 (Android)")
        for ((k, v) in headers) c.setRequestProperty(k, v)
        try {
            c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = c.responseCode
            val stream = if (code >= 400) (c.errorStream ?: c.inputStream) else c.inputStream
            return Response(code, readLimited(stream), c.contentType ?: "", url)
        } finally {
            c.disconnect()
        }
    }

    private fun readLimited(stream: java.io.InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        stream.use {
            while (true) {
                val n = it.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                if (out.size() > MAX_BYTES) break
            }
        }
        return out.toByteArray()
    }

    private fun charsetOf(contentType: String): Charset {
        val m = Regex("charset=([A-Za-z0-9_-]+)", RegexOption.IGNORE_CASE).find(contentType)
        return try { if (m != null) Charset.forName(m.groupValues[1]) else Charsets.UTF_8 } catch (e: Exception) { Charsets.UTF_8 }
    }
}
