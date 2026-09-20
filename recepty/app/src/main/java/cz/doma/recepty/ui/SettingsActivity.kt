package cz.doma.recepty.ui

import android.app.Activity
import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import cz.doma.recepty.R
import cz.doma.recepty.data.Prefs
import cz.doma.recepty.engine.ClaudeExtractor
import cz.doma.recepty.engine.FetchedVideo
import cz.doma.recepty.engine.VideoSource
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
        val useTranscript = view<Switch>(R.id.use_transcript)
        val useThumbnail = view<Switch>(R.id.use_thumbnail)
        val local = view<Switch>(R.id.local_fallback)
        val testResult = view<TextView>(R.id.test_result)
        val saveMsg = view<TextView>(R.id.save_msg)

        val modelValues = resources.getStringArray(R.array.model_values)
        val effortValues = resources.getStringArray(R.array.effort_values)
        model.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, resources.getStringArray(R.array.model_labels)).also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        effort.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, resources.getStringArray(R.array.effort_labels)).also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }

        apiKey.setText(prefs.apiKey)
        model.setSelection(modelValues.indexOf(prefs.model).coerceAtLeast(0))
        effort.setSelection(effortValues.indexOf(prefs.effort).coerceAtLeast(0))
        useTranscript.isChecked = prefs.useTranscript
        useThumbnail.isChecked = prefs.useThumbnail
        local.isChecked = prefs.useLocalFallback

        fun save() {
            prefs.apiKey = apiKey.text.toString()
            prefs.model = modelValues[model.selectedItemPosition]
            prefs.effort = effortValues[effort.selectedItemPosition]
            prefs.useTranscript = useTranscript.isChecked
            prefs.useThumbnail = useThumbnail.isChecked
            prefs.useLocalFallback = local.isChecked
        }

        view<Button>(R.id.btn_save).setOnClickListener {
            save()
            saveMsg.text = getString(R.string.settings_saved)
            saveMsg.postDelayed({ saveMsg.text = "" }, 3000)
        }

        view<Button>(R.id.btn_test).setOnClickListener {
            testResult.text = "Testuji…"
            val settings = ClaudeExtractor.Settings(apiKey.text.toString().trim(), modelValues[model.selectedItemPosition], "low")
            executor.execute {
                val msg = try {
                    val v = FetchedVideo(VideoSource.detect("https://www.youtube.com/watch?v=test1234567"))
                    v.title = "Rychlá kuřecí pánev s rýží"
                    v.description = "Ingredience: 400 g kuřecích prsou, 200 g rýže, 2 stroužky česneku, 1 paprika, sójová omáčka, olej. Postup: kuře opečte, přidejte zeleninu, podávejte s rýží."
                    val r = ClaudeExtractor.extract(v, "", null, "", settings, false)
                    "Klíč funguje (model " + r.optString("_model") + ", rozpoznáno ingrediencí: " + (r.optJSONArray("ingredients")?.length() ?: 0) + ")."
                } catch (e: Exception) { "Chyba: " + (e.message ?: e.toString()) }
                runOnUiThread { testResult.text = msg }
            }
        }
    }
}
