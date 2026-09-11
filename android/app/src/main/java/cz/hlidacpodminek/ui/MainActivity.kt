package cz.hlidacpodminek.ui

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import cz.hlidacpodminek.R
import cz.hlidacpodminek.data.Prefs
import cz.hlidacpodminek.data.Store
import cz.hlidacpodminek.engine.Analyzer
import cz.hlidacpodminek.service.TermsAccessibilityService
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var prefs: Prefs

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)

        view<Button>(R.id.btn_enable_service).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        view<Button>(R.id.btn_settings).setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
        view<Button>(R.id.btn_analyze_text).setOnClickListener { analyzePasted() }

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    override fun onResume() {
        super.onResume()
        val enabled = isServiceEnabled()
        val status = view<TextView>(R.id.service_status)
        status.text = getString(if (enabled) R.string.service_on else R.string.service_off)
        status.setBackgroundColor(if (enabled) 0xFFE8F5E9.toInt() else 0xFFFFF8E6.toInt())
        view<Button>(R.id.btn_enable_service).visibility = if (enabled) View.GONE else View.VISIBLE
        view<TextView>(R.id.no_key_notice).visibility = if (prefs.apiKey.isEmpty()) View.VISIBLE else View.GONE
        renderHistory()
    }

    private fun isServiceEnabled(): Boolean {
        val enabled = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        val me = packageName + "/" + TermsAccessibilityService::class.java.name
        val meShort = packageName + "/" + TermsAccessibilityService::class.java.name.removePrefix(packageName)
        return enabled.split(':').any { it.equals(me, true) || it.equals(meShort, true) }
    }

    private fun analyzePasted() {
        val input = view<EditText>(R.id.paste_text).text.toString().trim()
        val progress = view<ProgressBar>(R.id.progress)
        val error = view<TextView>(R.id.error_text)
        val url = Regex("^https?://\\S+$", RegexOption.IGNORE_CASE).find(input)?.value
        if (url == null && input.length < 100) { error.text = getString(R.string.error_short_text); error.visibility = View.VISIBLE; return }
        error.visibility = View.GONE
        progress.visibility = View.VISIBLE
        executor.execute {
            try {
                val analyzer = Analyzer(this)
                val out = if (url != null) analyzer.analyzeUrl(url)
                else analyzer.analyzeText(input, JSONObject().put("url", "vložený text").put("title", "Ručně vložený text").put("context", "Uživatel vložil text ručně."), minLength = 100)
                runOnUiThread {
                    progress.visibility = View.GONE
                    startActivity(Intent(this, ResultActivity::class.java).putExtra(ResultActivity.EXTRA_ID, out.id))
                }
            } catch (e: Exception) {
                runOnUiThread {
                    progress.visibility = View.GONE
                    error.text = if (e.message == "NO_API_KEY") "Zadejte API klíč v nastavení, nebo povolte offline analýzu." else (e.message ?: e.toString())
                    error.visibility = View.VISIBLE
                }
            }
        }
    }

    private fun renderHistory() {
        val list = view<LinearLayout>(R.id.history_list)
        list.removeAllViews()
        val h = Store(this).history()
        if (h.length() == 0) {
            val tv = TextView(this); tv.text = getString(R.string.history_empty); list.addView(tv); return
        }
        val fmt = SimpleDateFormat("d. M. HH:mm", Locale("cs"))
        for (i in 0 until minOf(h.length(), 20)) {
            val e = h.getJSONObject(i)
            val row = layoutInflater.inflate(R.layout.item_history, list, false)
            val color = when (e.optString("verdict")) { "nebezpecne" -> 0xFFC62828.toInt(); "pozor" -> 0xFFEF8F00.toInt(); "standardni" -> 0xFF2E7D32.toInt(); else -> 0xFF9E9E9E.toInt() }
            row.view<View>(R.id.dot).background.setTint(color)
            row.view<TextView>(R.id.title).text = e.optString("title").ifEmpty { e.optString("url") }
            row.view<TextView>(R.id.subtitle).text = fmt.format(Date(e.optLong("ts"))) + " · " + e.optString("document_type") + " · riziko " + e.optInt("risk_score") + "/100"
            row.setOnClickListener { startActivity(Intent(this, ResultActivity::class.java).putExtra(ResultActivity.EXTRA_ID, e.optString("id"))) }
            list.addView(row)
        }
    }
}
