package cz.hlidacpodminek.engine

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.Charset

/** Minimální HTTP klient nad HttpURLConnection (bez závislostí). */
object Http {
    private const val UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36 HlidacPodminek/1.0"
    private const val MAX_BYTES = 6 * 1024 * 1024

    class Response(val code: Int, val body: String, val contentType: String)

    fun get(url: String, timeoutMs: Int = 20000): Response {
        var current = url
        repeat(6) {
            val c = (URL(current).openConnection() as HttpURLConnection)
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
            c.instanceFollowRedirects = false
            c.setRequestProperty("User-Agent", UA)
            c.setRequestProperty("Accept", "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5")
            c.setRequestProperty("Accept-Language", "cs,sk;q=0.9,en;q=0.8,de;q=0.7")
            try {
                val code = c.responseCode
                if (code in 300..399) {
                    val loc = c.getHeaderField("Location") ?: return Response(code, "", "")
                    current = URL(URL(current), loc).toString()
                    return@repeat
                }
                val ct = c.contentType ?: ""
                val stream = if (code >= 400) (c.errorStream ?: c.inputStream) else c.inputStream
                val bytes = readLimited(stream)
                return Response(code, String(bytes, charsetOf(ct)), ct)
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
        c.setRequestProperty("User-Agent", UA)
        for ((k, v) in headers) c.setRequestProperty(k, v)
        try {
            c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = c.responseCode
            val stream = if (code >= 400) (c.errorStream ?: c.inputStream) else c.inputStream
            val bytes = readLimited(stream)
            return Response(code, String(bytes, Charsets.UTF_8), c.contentType ?: "")
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
