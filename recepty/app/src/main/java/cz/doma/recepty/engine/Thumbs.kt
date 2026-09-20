package cz.doma.recepty.engine

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import android.widget.ImageView
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors

/** Stažení a uložení náhledového obrázku do filesDir/thumbs + asynchronní zobrazení v ImageView. */
object Thumbs {
    private val executor = Executors.newFixedThreadPool(2)
    private val cache = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }

    class Downloaded(val bytes: ByteArray, val mediaType: String)

    fun download(url: String): Downloaded? {
        if (url.isEmpty()) return null
        return try {
            val r = Http.get(url, headers = mapOf("Accept" to "image/*"))
            if (!r.ok || r.bytes.isEmpty() || r.bytes.size > 6 * 1024 * 1024) return null
            val type = sniff(r.bytes) ?: r.contentType.substringBefore(';').trim().takeIf { it.startsWith("image/") } ?: return null
            Downloaded(r.bytes, type)
        } catch (e: Exception) { null }
    }

    fun save(context: Context, url: String, bytes: ByteArray): String {
        val dir = File(context.filesDir, "thumbs").apply { mkdirs() }
        val f = File(dir, sha1(url) + ".img")
        f.writeBytes(bytes)
        return f.absolutePath
    }

    fun deleteFile(path: String) { if (path.isNotEmpty()) try { File(path).delete() } catch (e: Exception) {} }

    /** Načte bitmapu z cesty (zmenšenou) na pozadí a nastaví ji do ImageView, pokud se mezitím nezměnil cíl. */
    fun into(view: ImageView, path: String, targetPx: Int, placeholder: Int) {
        view.tag = path
        if (path.isEmpty()) { view.setImageResource(placeholder); return }
        cache.get(path)?.let { view.setImageBitmap(it); return }
        view.setImageResource(placeholder)
        executor.execute {
            val bmp = decode(path, targetPx) ?: return@execute
            cache.put(path, bmp)
            view.post { if (view.tag == path) view.setImageBitmap(bmp) }
        }
    }

    fun decode(path: String, targetPx: Int): Bitmap? {
        return try {
            val f = File(path); if (!f.exists()) return null
            val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(path, opts)
            var sample = 1
            while (opts.outWidth / (sample * 2) >= targetPx && opts.outHeight / (sample * 2) >= targetPx) sample *= 2
            BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
        } catch (e: Exception) { null }
    }

    private fun sniff(b: ByteArray): String? = when {
        b.size > 3 && b[0] == 0xFF.toByte() && b[1] == 0xD8.toByte() -> "image/jpeg"
        b.size > 8 && b[0] == 0x89.toByte() && b[1] == 'P'.code.toByte() && b[2] == 'N'.code.toByte() -> "image/png"
        b.size > 12 && b[8] == 'W'.code.toByte() && b[9] == 'E'.code.toByte() && b[10] == 'B'.code.toByte() && b[11] == 'P'.code.toByte() -> "image/webp"
        b.size > 3 && b[0] == 'G'.code.toByte() && b[1] == 'I'.code.toByte() && b[2] == 'F'.code.toByte() -> "image/gif"
        else -> null
    }

    private fun sha1(s: String): String = MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
}
