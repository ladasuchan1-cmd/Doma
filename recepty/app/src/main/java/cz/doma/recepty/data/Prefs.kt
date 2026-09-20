package cz.doma.recepty.data

import android.content.Context
import android.content.SharedPreferences

/** Nastavení aplikace (API klíč jen lokálně v SharedPreferences). */
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

    /** Posílat modelu i automatické titulky videa (delší vstup, přesnější ingredience). */
    var useTranscript: Boolean
        get() = sp.getBoolean("useTranscript", true)
        set(v) = sp.edit().putBoolean("useTranscript", v).apply()

    /** Posílat modelu náhledový obrázek (pomůže poznat jídlo, když popisek chybí). */
    var useThumbnail: Boolean
        get() = sp.getBoolean("useThumbnail", true)
        set(v) = sp.edit().putBoolean("useThumbnail", v).apply()

    /** Bez klíče nebo při chybě API použít offline heuristiku. */
    var useLocalFallback: Boolean
        get() = sp.getBoolean("useLocalFallback", true)
        set(v) = sp.edit().putBoolean("useLocalFallback", v).apply()

    companion object {
        const val DEFAULT_MODEL = "claude-opus-5"
    }
}
