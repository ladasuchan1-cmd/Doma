package cz.doma.recepty.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import cz.doma.recepty.R
import cz.doma.recepty.data.Recipe
import cz.doma.recepty.data.RecipeDb
import cz.doma.recepty.engine.LocalExtractor
import cz.doma.recepty.engine.RecipeImporter
import cz.doma.recepty.engine.VideoSource
import java.util.concurrent.Executors

/** Cíl pro „Sdílet → Uložit recept“ z YouTube, Instagramu, TikToku, prohlížeče… Také ho volá dialog „Přidat odkaz“. */
class ShareActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_share)
        val status = view<TextView>(R.id.status)
        val text = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty().trim()
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT).orEmpty().trim()
        val url = VideoSource.extractUrl(text)
        if (url == null) {
            status.text = "Ve sdíleném textu není odkaz."
            showActions(null, subject, text); return
        }
        view<Button>(R.id.btn_close).setOnClickListener { finish() }

        executor.execute {
            try {
                val outcome = RecipeImporter(this).import(url) { s -> runOnUiThread { status.text = s } }
                val r = outcome.recipe
                val nothingFetched = !outcome.existed && r.ingredients.isEmpty() && r.description.isBlank()
                runOnUiThread {
                    if (outcome.existed) Toast.makeText(this, R.string.already_saved, Toast.LENGTH_SHORT).show()
                    if (nothingFetched) {
                        // popisek se nestáhl (typicky Instagram bez přihlášení) – rovnou nabídneme ruční doplnění
                        Toast.makeText(this, R.string.fetch_failed_edit, Toast.LENGTH_LONG).show()
                        startActivity(Intent(this, EditActivity::class.java).putExtra(RecipeActivity.EXTRA_ID, r.id))
                    } else {
                        startActivity(Intent(this, RecipeActivity::class.java).putExtra(RecipeActivity.EXTRA_ID, r.id))
                    }
                    finish()
                }
            } catch (e: Exception) {
                runOnUiThread {
                    status.text = "Chyba: " + (e.message ?: e.toString())
                    showActions(url, subject, text)
                }
            }
        }
    }

    /** Při selhání nabídne uložit alespoň odkaz a otevřít ruční úpravu. */
    private fun showActions(url: String?, subject: String, text: String) {
        view<ProgressBar>(R.id.progress).visibility = View.GONE
        view<View>(R.id.actions).visibility = View.VISIBLE
        view<Button>(R.id.btn_close).setOnClickListener { finish() }
        val manual = view<Button>(R.id.btn_manual)
        if (url == null) { manual.visibility = View.GONE; return }
        manual.setOnClickListener {
            executor.execute {
                val info = VideoSource.detect(url)
                val existing = RecipeDb.get(this).findByUrl(info.canonicalUrl)
                val r = existing ?: Recipe(url = info.canonicalUrl, platform = info.platform.name.lowercase(), videoId = info.videoId,
                    title = LocalExtractor.cleanTitle(subject).ifBlank { "Recept z ${info.platform.label}" },
                    description = text.replace(url, "").trim(), needsReview = true, engine = "manual").also { RecipeDb.get(this).insert(it) }
                runOnUiThread { startActivity(Intent(this, EditActivity::class.java).putExtra(RecipeActivity.EXTRA_ID, r.id)); finish() }
            }
        }
    }
}
