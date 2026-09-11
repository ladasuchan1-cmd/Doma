package cz.hlidacpodminek.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import cz.hlidacpodminek.R
import cz.hlidacpodminek.data.Store
import org.json.JSONObject

/** Zobrazí uložený výsledek – vykreslení dělá sdílený lib/render.js ve WebView. */
class ResultActivity : Activity() {
    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_result)
        val id = intent.getStringExtra(EXTRA_ID)
        val result = if (id != null) Store(this).load(id) else null
        if (result == null) {
            Toast.makeText(this, "Výsledek nebyl nalezen.", Toast.LENGTH_SHORT).show()
            finish(); return
        }
        val meta = result.optJSONObject("_meta") ?: JSONObject()
        val title = meta.optString("title").ifEmpty { meta.optString("url") }
        web = view(R.id.web)
        web.settings.javaScriptEnabled = true
        web.settings.allowFileAccess = true
        web.addJavascriptInterface(Bridge(result.toString(), title), "Android")
        web.loadUrl("file:///android_asset/result.html")
    }

    class Bridge(private val json: String, private val title: String) {
        @JavascriptInterface fun getResult(): String = json
        @JavascriptInterface fun getTitle(): String = title
    }

    companion object {
        const val EXTRA_ID = "result_id"
    }
}
