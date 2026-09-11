package cz.hlidacpodminek.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.TextView
import cz.hlidacpodminek.R
import cz.hlidacpodminek.engine.Analyzer
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Cíl pro „Sdílet → Hlídač podmínek“ (text nebo odkaz) a pro „Analyzovat podmínky“ v menu označeného textu.
 * Také ji otevírá notifikace „Analyzovat obrazovku“.
 */
class ShareActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_share)
        val status = view<TextView>(R.id.status)
        val text = when (intent.action) {
            Intent.ACTION_PROCESS_TEXT -> intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()
            else -> intent.getStringExtra(Intent.EXTRA_TEXT)
        }?.trim().orEmpty()
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT).orEmpty()
        if (text.isEmpty()) { finish(); return }

        executor.execute {
            try {
                val analyzer = Analyzer(this)
                val url = URL_RE.find(text)?.value
                val outcome = if (url != null && text.length < url.length + 40) {
                    runOnUiThread { status.text = "Stahuji a analyzuji $url…" }
                    analyzer.analyzeUrl(url)
                } else {
                    analyzer.analyzeText(text, JSONObject().put("url", "sdílený text").put("title", subject.ifEmpty { "Sdílený text" }).put("context", "Uživatel sdílel text ručně."), minLength = 100)
                }
                startActivity(Intent(this, ResultActivity::class.java).putExtra(ResultActivity.EXTRA_ID, outcome.id))
                finish()
            } catch (e: Exception) {
                runOnUiThread {
                    view<android.widget.ProgressBar>(R.id.progress).visibility = android.view.View.GONE
                    status.text = if (e.message == "NO_API_KEY") "Zadejte API klíč v nastavení, nebo povolte offline analýzu." else "Chyba: " + (e.message ?: e.toString())
                    status.setOnClickListener { finish() }
                }
            }
        }
    }

    companion object {
        private val URL_RE = Regex("https?://[^\\s]+", RegexOption.IGNORE_CASE)
    }
}
