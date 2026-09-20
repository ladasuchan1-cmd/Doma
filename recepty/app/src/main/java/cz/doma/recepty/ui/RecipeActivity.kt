package cz.doma.recepty.ui

import android.app.Activity
import android.app.AlertDialog
import android.app.ProgressDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import cz.doma.recepty.R
import cz.doma.recepty.data.Recipe
import cz.doma.recepty.data.RecipeDb
import cz.doma.recepty.engine.RecipeImporter
import cz.doma.recepty.engine.Thumbs
import java.util.concurrent.Executors

class RecipeActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()
    private var recipe: Recipe? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_recipe)
        actionBar?.setDisplayHomeAsUpEnabled(true)
    }

    override fun onResume() {
        super.onResume()
        val id = intent.getLongExtra(EXTRA_ID, 0)
        executor.execute {
            val r = RecipeDb.get(this).get(id)
            runOnUiThread { if (r == null) finish() else { recipe = r; render(r) } }
        }
    }

    private fun render(r: Recipe) {
        title = r.title
        view<TextView>(R.id.title).text = r.title
        val src = listOf(RecipeAdapter.platformLabel(r.platform), r.author).filter { it.isNotBlank() }.joinToString(" · ")
        view<TextView>(R.id.source).text = src
        Thumbs.into(view<ImageView>(R.id.thumb), r.thumbPath, dp(400), R.drawable.thumb_placeholder)
        view<Button>(R.id.btn_open).setOnClickListener {
            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(r.url))) } catch (e: Exception) { Toast.makeText(this, r.url, Toast.LENGTH_LONG).show() }
        }
        val banner = view<TextView>(R.id.banner)
        val bannerText = listOf(if (r.needsReview) getString(R.string.review_banner) else "", r.error).filter { it.isNotBlank() }.joinToString("\n")
        banner.visibility = if (bannerText.isEmpty()) View.GONE else View.VISIBLE
        banner.text = bannerText
        banner.setOnClickListener { edit() }

        view<TextView>(R.id.summary).apply { text = r.summary; visibility = if (r.summary.isBlank()) View.GONE else View.VISIBLE }
        val meta = mutableListOf<String>()
        if (r.category.isNotBlank()) meta.add(r.category)
        if (r.cuisine.isNotBlank()) meta.add(r.cuisine + " kuchyně")
        r.timeMinutes?.let { meta.add("$it min") }
        r.servings?.let { meta.add("$it porce") }
        view<TextView>(R.id.meta).apply { text = meta.joinToString(" · "); visibility = if (meta.isEmpty()) View.GONE else View.VISIBLE }

        val ingBox = view<LinearLayout>(R.id.ingredients)
        ingBox.removeAllViews()
        if (r.ingredients.isEmpty()) {
            ingBox.addView(TextView(this).apply { text = getString(R.string.no_ingredients); setTextColor(getColor(R.color.muted)) })
        } else for (ing in r.ingredients) {
            ingBox.addView(CheckBox(this).apply { text = ing.display(); textSize = 15f; setPadding(dp(4), dp(2), 0, dp(2)) })
        }

        val stepsBox = view<LinearLayout>(R.id.steps)
        stepsBox.removeAllViews()
        view<View>(R.id.steps_title).visibility = if (r.steps.isEmpty()) View.GONE else View.VISIBLE
        r.steps.forEachIndexed { i, s ->
            stepsBox.addView(TextView(this).apply { text = "${i + 1}. $s"; textSize = 15f; setPadding(0, dp(4), 0, dp(4)) })
        }

        val kw = view<FlowLayout>(R.id.keywords)
        kw.removeAllViews()
        val words = (r.keywords + r.ingredients.map { it.name.lowercase() }).distinct()
        for (w in words) kw.addView(chip(w) { term ->
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(MainActivity.EXTRA_QUERY, term))
        })

        view<View>(R.id.notes_title).visibility = if (r.notes.isBlank()) View.GONE else View.VISIBLE
        view<TextView>(R.id.notes).apply { text = r.notes; visibility = if (r.notes.isBlank()) View.GONE else View.VISIBLE }
        view<View>(R.id.description_title).visibility = if (r.description.isBlank()) View.GONE else View.VISIBLE
        view<TextView>(R.id.description).apply { text = r.description; visibility = if (r.description.isBlank()) View.GONE else View.VISIBLE }
        val engine = when {
            r.engine.startsWith("claude") -> "Zapsal model " + r.engine.removePrefix("claude:")
            r.engine == "schema.org" -> "Převzato ze strukturovaných dat stránky"
            r.engine == "offline" -> "Offline rozpoznání podle slovníku"
            else -> ""
        }
        view<TextView>(R.id.engine).text = listOf(engine, if (r.confidence.isNotBlank()) "jistota: " + r.confidence else "", r.url).filter { it.isNotBlank() }.joinToString("\n")
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean { menuInflater.inflate(R.menu.recipe, menu); return true }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        val r = recipe ?: return super.onOptionsItemSelected(item)
        when (item.itemId) {
            android.R.id.home -> finish()
            R.id.action_edit -> edit()
            R.id.action_reanalyze -> reanalyze(r)
            R.id.action_share -> {
                val text = buildString {
                    append(r.title).append('\n').append(r.url).append("\n\n").append(getString(R.string.ingredients)).append(":\n")
                    r.ingredients.forEach { append("• ").append(it.display()).append('\n') }
                    if (r.steps.isNotEmpty()) { append('\n').append(getString(R.string.steps)).append(":\n"); r.steps.forEachIndexed { i, s -> append(i + 1).append(". ").append(s).append('\n') } }
                }
                startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_SUBJECT, r.title).putExtra(Intent.EXTRA_TEXT, text), getString(R.string.menu_share)))
            }
            R.id.action_delete -> AlertDialog.Builder(this).setMessage(R.string.delete_confirm)
                .setPositiveButton(R.string.delete) { _, _ -> executor.execute { RecipeDb.get(this).delete(r.id); Thumbs.deleteFile(r.thumbPath); runOnUiThread { finish() } } }
                .setNegativeButton(R.string.cancel, null).show()
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }

    private fun edit() { recipe?.let { startActivity(Intent(this, EditActivity::class.java).putExtra(EXTRA_ID, it.id)) } }

    @Suppress("DEPRECATION")
    private fun reanalyze(r: Recipe) {
        val dlg = ProgressDialog(this).apply { setMessage(getString(R.string.importing)); setCancelable(false); show() }
        executor.execute {
            try {
                RecipeImporter(this).reanalyze(r) { s -> runOnUiThread { dlg.setMessage(s) } }
                runOnUiThread { dlg.dismiss(); render(r) }
            } catch (e: Exception) {
                runOnUiThread { dlg.dismiss(); Toast.makeText(this, e.message ?: e.toString(), Toast.LENGTH_LONG).show() }
            }
        }
    }

    companion object { const val EXTRA_ID = "id" }
}
