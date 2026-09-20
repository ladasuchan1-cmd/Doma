package cz.doma.recepty.ui

import android.app.Activity
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import cz.doma.recepty.R
import cz.doma.recepty.data.Recipe
import cz.doma.recepty.data.RecipeDb
import cz.doma.recepty.engine.RecipeImporter
import java.util.concurrent.Executors

/** Ruční úprava receptu: název, ingredience (řádek = ingredience), postup, klíčová slova, poznámky, popisek. */
class EditActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()
    private var recipe: Recipe? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_edit)
        val id = intent.getLongExtra(RecipeActivity.EXTRA_ID, 0)
        executor.execute {
            val r = RecipeDb.get(this).get(id)
            runOnUiThread { if (r == null) finish() else { recipe = r; fill(r) } }
        }
        view<Button>(R.id.btn_save).setOnClickListener { save(reanalyze = false) }
        view<Button>(R.id.btn_save_reanalyze).setOnClickListener { save(reanalyze = true) }
    }

    private fun fill(r: Recipe) {
        view<EditText>(R.id.title).setText(r.title)
        view<EditText>(R.id.ingredients).setText(r.ingredientsAsLines())
        view<EditText>(R.id.steps).setText(r.steps.joinToString("\n"))
        view<EditText>(R.id.keywords).setText(r.keywords.joinToString(", "))
        view<EditText>(R.id.notes).setText(r.notes)
        view<EditText>(R.id.description).setText(r.description)
    }

    private fun collect(r: Recipe) {
        r.title = view<EditText>(R.id.title).text.toString().trim().ifEmpty { r.title }
        r.ingredients = Recipe.ingredientsFromLines(view<EditText>(R.id.ingredients).text.toString())
        r.steps = view<EditText>(R.id.steps).text.toString().split('\n').map { it.trim().replace(Regex("^\\d{1,2}[.)]\\s*"), "") }.filter { it.isNotEmpty() }.toMutableList()
        r.keywords = view<EditText>(R.id.keywords).text.toString().split(Regex("[,;\\n]")).map { it.trim().lowercase() }.filter { it.isNotEmpty() }.distinct().toMutableList()
        r.notes = view<EditText>(R.id.notes).text.toString().trim()
        r.description = view<EditText>(R.id.description).text.toString().trim()
        r.needsReview = false
        r.error = ""
    }

    private fun save(reanalyze: Boolean) {
        val r = recipe ?: return
        collect(r)
        val progress = view<ProgressBar>(R.id.progress)
        val status = view<TextView>(R.id.status)
        progress.visibility = View.VISIBLE
        view<Button>(R.id.btn_save).isEnabled = false
        view<Button>(R.id.btn_save_reanalyze).isEnabled = false
        executor.execute {
            try {
                if (reanalyze) {
                    RecipeImporter(this).reanalyze(r) { s -> runOnUiThread { status.text = s } }
                } else RecipeDb.get(this).update(r)
                runOnUiThread { Toast.makeText(this, R.string.saved, Toast.LENGTH_SHORT).show(); finish() }
            } catch (e: Exception) {
                runOnUiThread {
                    progress.visibility = View.GONE
                    status.text = "Chyba: " + (e.message ?: e.toString())
                    view<Button>(R.id.btn_save).isEnabled = true
                    view<Button>(R.id.btn_save_reanalyze).isEnabled = true
                }
            }
        }
    }
}
