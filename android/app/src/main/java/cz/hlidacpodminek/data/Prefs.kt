package cz.hlidacpodminek.data

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/** Nastavení aplikace. Stejné klíče jako v rozšíření prohlížeče (settings v chrome.storage). */
class Prefs(context: Context) {
    private val sp: SharedPreferences = context.applicationContext.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var apiKey: String
        get() = sp.getString("apiKey", "") ?: ""
        set(v) = sp.edit().putString("apiKey", v.trim()).apply()

    var model: String
        get() = sp.getString("model", DEFAULT_MODEL) ?: DEFAULT_MODEL
        set(v) = sp.edit().putString("model", v).apply()

    var effort: String
        get() = sp.getString("effort", "medium") ?: "medium"
        set(v) = sp.edit().putString("effort", v).apply()

    var autoMode: Boolean
        get() = sp.getBoolean("autoMode", true)
        set(v) = sp.edit().putBoolean("autoMode", v).apply()

    var autoOnDocuments: Boolean
        get() = sp.getBoolean("autoOnDocuments", true)
        set(v) = sp.edit().putBoolean("autoOnDocuments", v).apply()

    var notify: Boolean
        get() = sp.getBoolean("notify", true)
        set(v) = sp.edit().putBoolean("notify", v).apply()

    var useLocalFallback: Boolean
        get() = sp.getBoolean("useLocalFallback", true)
        set(v) = sp.edit().putBoolean("useLocalFallback", v).apply()

    var minTextLength: Int
        get() = sp.getInt("minTextLength", 800)
        set(v) = sp.edit().putInt("minTextLength", v).apply()

    /** Balíčky aplikací nebo domény, kde se služba nemá sama spouštět. */
    var ignored: List<String>
        get() = (sp.getString("ignored", "") ?: "").split('\n').map { it.trim().lowercase() }.filter { it.isNotEmpty() }
        set(v) = sp.edit().putString("ignored", v.joinToString("\n")).apply()

    fun isIgnored(id: String?): Boolean {
        if (id.isNullOrEmpty()) return false
        val idL = id.lowercase()
        return ignored.any { idL == it || idL.endsWith(".$it") }
    }

    /** Nastavení ve tvaru, který očekává lib/claude.js (buildRequest). */
    fun toJson(): JSONObject = JSONObject()
        .put("apiKey", apiKey)
        .put("model", model)
        .put("effort", effort)
        .put("useLocalFallback", useLocalFallback)

    companion object {
        const val DEFAULT_MODEL = "claude-opus-5"
    }
}
