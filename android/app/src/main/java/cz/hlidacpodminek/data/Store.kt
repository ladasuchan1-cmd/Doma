package cz.hlidacpodminek.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Úložiště výsledků: každý výsledek je JSON soubor v filesDir/results/<id>.json,
 * historie (max. 100 položek) a cache (hash textu → id, platnost 7 dní) jsou v SharedPreferences.
 */
class Store(context: Context) {
    private val ctx = context.applicationContext
    private val sp = ctx.getSharedPreferences("store", Context.MODE_PRIVATE)
    private val dir = File(ctx.filesDir, "results").apply { mkdirs() }

    fun save(result: JSONObject, meta: JSONObject): String {
        val id = java.lang.Long.toHexString(System.currentTimeMillis()) + "-" + (Math.random() * 0xffff).toInt().toString(16)
        result.put("_id", id)
        File(dir, "$id.json").writeText(result.toString())
        val entry = JSONObject()
            .put("id", id)
            .put("ts", System.currentTimeMillis())
            .put("url", meta.optString("url"))
            .put("title", meta.optString("title"))
            .put("verdict", result.optString("verdict"))
            .put("risk_score", result.optInt("risk_score"))
            .put("engine", result.optString("_engine"))
            .put("document_type", result.optString("document_type"))
        val h = history()
        val out = JSONArray().put(entry)
        for (i in 0 until minOf(h.length(), 99)) out.put(h.getJSONObject(i))
        sp.edit().putString("history", out.toString()).apply()
        return id
    }

    fun load(id: String): JSONObject? {
        val f = File(dir, "$id.json")
        if (!f.exists()) return null
        return try { JSONObject(f.readText()) } catch (e: Exception) { null }
    }

    fun history(): JSONArray = try { JSONArray(sp.getString("history", "[]") ?: "[]") } catch (e: Exception) { JSONArray() }

    fun cacheGet(key: String): JSONObject? {
        val cache = cacheObj()
        val e = cache.optJSONObject(key) ?: return null
        if (System.currentTimeMillis() - e.optLong("ts") > CACHE_TTL_MS) return null
        return load(e.optString("id"))
    }

    fun cachePut(key: String, id: String) {
        val cache = cacheObj()
        cache.put(key, JSONObject().put("id", id).put("ts", System.currentTimeMillis()))
        // úklid prošlých záznamů
        val now = System.currentTimeMillis()
        val stale = ArrayList<String>()
        val it = cache.keys()
        while (it.hasNext()) { val k = it.next(); if (now - cache.getJSONObject(k).optLong("ts") > CACHE_TTL_MS) stale.add(k) }
        for (k in stale) { val id0 = cache.getJSONObject(k).optString("id"); cache.remove(k); File(dir, "$id0.json").delete() }
        sp.edit().putString("cache", cache.toString()).apply()
    }

    fun clearCache() {
        sp.edit().remove("cache").apply()
    }

    private fun cacheObj(): JSONObject = try { JSONObject(sp.getString("cache", "{}") ?: "{}") } catch (e: Exception) { JSONObject() }

    companion object {
        const val CACHE_TTL_MS = 7L * 24 * 3600 * 1000
    }
}
