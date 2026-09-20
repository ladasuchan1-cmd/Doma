package cz.doma.recepty.ui

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import cz.doma.recepty.R
import cz.doma.recepty.data.Prefs
import cz.doma.recepty.data.Recipe
import cz.doma.recepty.data.RecipeDb
import cz.doma.recepty.engine.Thumbs
import org.json.JSONArray
import java.io.File
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var adapter: RecipeAdapter
    private lateinit var search: EditText
    private var pendingSearch: Runnable? = null
    private var activeTerms: Set<String> = emptySet()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        adapter = RecipeAdapter(this)
        val list = view<ListView>(R.id.list)
        list.adapter = adapter
        list.emptyView = view<TextView>(R.id.empty)
        list.setOnItemClickListener { _, _, pos, _ -> openRecipe(adapter.getItem(pos)) }
        list.setOnItemLongClickListener { _, _, pos, _ -> confirmDelete(adapter.getItem(pos)); true }

        search = view(R.id.search)
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) { scheduleSearch() }
        })
        search.setOnEditorActionListener { _, actionId, _ -> if (actionId == EditorInfo.IME_ACTION_SEARCH) { runSearch(); true } else false }
        intent?.getStringExtra(EXTRA_QUERY)?.let { search.setText(it) }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        intent?.getStringExtra(EXTRA_QUERY)?.let { search.setText(it) }
    }

    override fun onResume() {
        super.onResume()
        view<TextView>(R.id.no_key_notice).visibility = if (Prefs(this).apiKey.isEmpty()) View.VISIBLE else View.GONE
        runSearch()
        loadChips()
    }

    private fun scheduleSearch() {
        pendingSearch?.let { handler.removeCallbacks(it) }
        val r = Runnable { runSearch() }
        pendingSearch = r
        handler.postDelayed(r, 250)
    }

    private fun runSearch() {
        val q = search.text.toString()
        executor.execute {
            val db = RecipeDb.get(this)
            val results = db.search(q)
            val total = db.count()
            runOnUiThread {
                adapter.items = results
                activeTerms = q.split(Regex("[\\s,;]+")).map { it.trim().lowercase() }.filter { it.isNotEmpty() }.toSet()
                highlightChips()
                view<TextView>(R.id.empty).text = getString(if (total == 0) R.string.empty_intro else R.string.empty_search)
                view<TextView>(R.id.count).text = if (q.isBlank()) getString(R.string.count_format, total) else "${results.size} / " + getString(R.string.count_format, total)
            }
        }
    }

    private fun loadChips() {
        executor.execute {
            val top = RecipeDb.get(this).topKeywords(30)
            runOnUiThread {
                val box = view<LinearLayout>(R.id.chips)
                box.removeAllViews()
                for ((word, _) in top) box.addView(chip(word) { toggleTerm(it) })
                view<View>(R.id.chips_scroll).visibility = if (top.isEmpty()) View.GONE else View.VISIBLE
                highlightChips()
            }
        }
    }

    private fun highlightChips() {
        val box = view<LinearLayout>(R.id.chips)
        for (i in 0 until box.childCount) {
            val tv = box.getChildAt(i) as TextView
            val sel = tv.text.toString().lowercase() in activeTerms
            tv.isSelected = sel
            tv.setTextColor(getColor(if (sel) R.color.chip_text_selected else R.color.chip_text))
        }
    }

    private fun toggleTerm(word: String) {
        val parts = search.text.toString().split(Regex("[\\s,;]+")).filter { it.isNotBlank() }.toMutableList()
        val idx = parts.indexOfFirst { it.equals(word, true) }
        if (idx >= 0) parts.removeAt(idx) else parts.add(word)
        search.setText(parts.joinToString(" "))
        search.setSelection(search.text.length)
    }

    private fun openRecipe(r: Recipe) = startActivity(Intent(this, RecipeActivity::class.java).putExtra(RecipeActivity.EXTRA_ID, r.id))

    private fun confirmDelete(r: Recipe) {
        AlertDialog.Builder(this).setTitle(r.title).setMessage(R.string.delete_confirm)
            .setPositiveButton(R.string.delete) { _, _ ->
                executor.execute { RecipeDb.get(this).delete(r.id); Thumbs.deleteFile(r.thumbPath); runOnUiThread { runSearch(); loadChips() } }
            }
            .setNegativeButton(R.string.cancel, null).show()
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean { menuInflater.inflate(R.menu.main, menu); return true }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            R.id.action_add -> showAddDialog()
            R.id.action_settings -> startActivity(Intent(this, SettingsActivity::class.java))
            R.id.action_export -> exportBackup()
            R.id.action_import -> startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"), REQ_IMPORT)
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }

    private fun showAddDialog() {
        val input = EditText(this)
        input.hint = getString(R.string.add_dialog_hint)
        input.setSingleLine()
        val clip = (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip?.getItemAt(0)?.coerceToText(this)?.toString()
        if (clip != null && clip.startsWith("http")) input.setText(clip.trim())
        val pad = dp(20)
        val wrap = LinearLayout(this).apply { setPadding(pad, dp(8), pad, 0); addView(input, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)) }
        AlertDialog.Builder(this).setTitle(R.string.add_dialog_title).setView(wrap)
            .setPositiveButton(R.string.btn_save) { _, _ ->
                val text = input.text.toString().trim()
                if (text.isNotEmpty()) startActivity(Intent(this, ShareActivity::class.java).setAction(Intent.ACTION_SEND).putExtra(Intent.EXTRA_TEXT, text))
            }
            .setNegativeButton(R.string.cancel, null).show()
    }

    private fun exportBackup() {
        executor.execute {
            try {
                val json = RecipeDb.get(this).exportAll().toString(2)
                val dir = File(cacheDir, "export").apply { mkdirs() }
                val f = File(dir, "recepty-zaloha.json")
                f.writeText(json)
                // sdílení přes FileProvider vyžaduje AndroidX/konfiguraci; jednoduše předáme text (JSON) – funguje do Disku, mailu i Keep
                val send = Intent(Intent.ACTION_SEND).setType("application/json").putExtra(Intent.EXTRA_SUBJECT, "Recepty – záloha").putExtra(Intent.EXTRA_TEXT, json)
                runOnUiThread { startActivity(Intent.createChooser(send, getString(R.string.menu_export))) }
            } catch (e: Exception) { runOnUiThread { Toast.makeText(this, "Export selhal: ${e.message}", Toast.LENGTH_LONG).show() } }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_IMPORT || resultCode != RESULT_OK) return
        val uri: Uri = data?.data ?: return
        executor.execute {
            try {
                val text = contentResolver.openInputStream(uri)!!.bufferedReader().use { it.readText() }
                val n = RecipeDb.get(this).importAll(JSONArray(text))
                runOnUiThread { Toast.makeText(this, "Přidáno receptů: $n", Toast.LENGTH_LONG).show(); runSearch(); loadChips() }
            } catch (e: Exception) { runOnUiThread { Toast.makeText(this, "Import selhal: ${e.message}", Toast.LENGTH_LONG).show() } }
        }
    }

    companion object {
        const val EXTRA_QUERY = "query"
        private const val REQ_IMPORT = 11
    }
}
