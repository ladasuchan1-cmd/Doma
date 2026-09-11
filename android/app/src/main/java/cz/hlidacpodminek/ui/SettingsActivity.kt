package cz.hlidacpodminek.ui

import android.app.Activity
import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import cz.hlidacpodminek.R
import cz.hlidacpodminek.data.Prefs
import cz.hlidacpodminek.engine.ClaudeClient
import cz.hlidacpodminek.engine.JsEngine
import org.json.JSONObject
import java.util.concurrent.Executors

class SettingsActivity : Activity() {
    private lateinit var prefs: Prefs
    private val executor = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        prefs = Prefs(this)

        val apiKey = view<EditText>(R.id.api_key)
        val model = view<Spinner>(R.id.model)
        val effort = view<Spinner>(R.id.effort)
        val autoMode = view<Switch>(R.id.auto_mode)
        val autoDocs = view<Switch>(R.id.auto_docs)
        val notify = view<Switch>(R.id.notify)
        val local = view<Switch>(R.id.local_fallback)
        val ignored = view<EditText>(R.id.ignored)
        val testResult = view<TextView>(R.id.test_result)
        val saveMsg = view<TextView>(R.id.save_msg)

        val modelValues = resources.getStringArray(R.array.model_values)
        val effortValues = resources.getStringArray(R.array.effort_values)
        model.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, resources.getStringArray(R.array.model_labels)).also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        effort.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, resources.getStringArray(R.array.effort_labels)).also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }

        apiKey.setText(prefs.apiKey)
        model.setSelection(modelValues.indexOf(prefs.model).coerceAtLeast(0))
        effort.setSelection(effortValues.indexOf(prefs.effort).coerceAtLeast(0))
        autoMode.isChecked = prefs.autoMode
        autoDocs.isChecked = prefs.autoOnDocuments
        notify.isChecked = prefs.notify
        local.isChecked = prefs.useLocalFallback
        ignored.setText(prefs.ignored.joinToString("\n"))

        fun save() {
            prefs.apiKey = apiKey.text.toString()
            prefs.model = modelValues[model.selectedItemPosition]
            prefs.effort = effortValues[effort.selectedItemPosition]
            prefs.autoMode = autoMode.isChecked
            prefs.autoOnDocuments = autoDocs.isChecked
            prefs.notify = notify.isChecked
            prefs.useLocalFallback = local.isChecked
            prefs.ignored = ignored.text.toString().split('\n')
        }

        view<Button>(R.id.btn_save).setOnClickListener {
            save()
            saveMsg.text = getString(R.string.settings_saved)
            saveMsg.postDelayed({ saveMsg.text = "" }, 3000)
        }

        view<Button>(R.id.btn_test).setOnClickListener {
            testResult.text = "Testuji…"
            val settings = JSONObject().put("apiKey", apiKey.text.toString().trim()).put("model", modelValues[model.selectedItemPosition]).put("effort", "low")
            executor.execute {
                val msg = try {
                    val r = ClaudeClient.analyze(JsEngine.get(this), "Testovací text. Cena služby je 10 Kč měsíčně. Předplatné lze zrušit e-mailem na info@example.com s výpovědní lhůtou 30 dní.", JSONObject().put("url", "test").put("title", "test"), settings)
                    "Klíč funguje (model " + r.optString("_model") + ")."
                } catch (e: Exception) { "Chyba: " + (e.message ?: e.toString()) }
                runOnUiThread { testResult.text = msg }
            }
        }
    }
}
