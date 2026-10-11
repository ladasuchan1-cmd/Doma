package cz.boubinkviz

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import org.json.JSONObject
import java.util.concurrent.Executors

/** Jediná obrazovka: WebView s menu (/app/menu.html) a kvízy (/kviz/…). */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var library: Library
    private lateinit var server: LocalServer
    private val executor = Executors.newSingleThreadExecutor()
    @Volatile private var busy = false
    private var pendingClip: String? = null
    private var chooserCallback: ValueCallback<Array<Uri>>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        library = Library(this)
        server = LocalServer(assets, library)
        volumeControlStream = AudioManager.STREAM_MUSIC     // tlačítka hlasitosti řídí ukázky, ne vyzvánění
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)

        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#14161a"))
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            textZoom = 100
            setSupportZoom(false)
        }
        web.addJavascriptInterface(Bridge(), "KvizApp")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = server.handle(request)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == LocalServer.HOST) return false
                try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: ActivityNotFoundException) {}
                return true
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) = applyMode(url)
        }
        // Záloha pro <input type="file">, kdyby ho kvíz otevřel jinak než přes bridge.js.
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                chooserCallback?.onReceiveValue(null)
                chooserCallback = callback
                return try { startActivityForResult(params.createIntent(), REQ_CHOOSER); true }
                catch (_: ActivityNotFoundException) { chooserCallback = null; false }
            }
        }
        setContentView(web)
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(MENU)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    private val inQuiz get() = Uri.parse(web.url ?: "").path.orEmpty().startsWith("/kviz/")

    /** V kvízu celá obrazovka a nezhasínat; v menu běžné okno. */
    private fun applyMode(url: String) {
        val quiz = Uri.parse(url).path.orEmpty().startsWith("/kviz/")
        if (quiz || busy) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= 30) {
            val c = window.insetsController ?: return
            if (quiz) {
                c.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                c.hide(WindowInsets.Type.systemBars())
            } else c.show(WindowInsets.Type.systemBars())
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = if (quiz) View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE else View.SYSTEM_UI_FLAG_VISIBLE
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) web.url?.let { applyMode(it) }
    }

    @Deprecated("Systémové Zpět – v kvízu se nejdřív zeptá, v menu aplikaci zavře.")
    override fun onBackPressed() {
        when {
            inQuiz -> confirmExit()
            busy -> Toast.makeText(this, "Počkej, až se dokončí nahrávání ukázek.", Toast.LENGTH_SHORT).show()
            else -> @Suppress("DEPRECATION") super.onBackPressed()
        }
    }

    private fun confirmExit() {
        AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("Ukončit kvíz?")
            .setMessage("Rozehraná pozice i skóre zůstanou uložené, příště můžeš pokračovat.")
            .setPositiveButton("Do menu") { _, _ -> web.loadUrl(MENU) }
            .setNegativeButton("Hrát dál", null)
            .show()
    }

    // ---- výběr ukázek ----

    private fun mediaIntent(multiple: Boolean) = Intent(Intent.ACTION_OPEN_DOCUMENT)
        .addCategory(Intent.CATEGORY_OPENABLE)
        .setType("*/*")
        .putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("video/*", "audio/*"))
        .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)

    private fun launch(intent: Intent, code: Int) {
        if (busy) { Toast.makeText(this, "Ukázky se právě nahrávají.", Toast.LENGTH_SHORT).show(); return }
        try { startActivityForResult(intent, code) }
        catch (_: ActivityNotFoundException) { Toast.makeText(this, "V telefonu chybí výběr souborů.", Toast.LENGTH_LONG).show() }
    }

    @Deprecated("Výsledek výběru souborů")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_CHOOSER) {
            chooserCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            chooserCallback = null
            return
        }
        if (resultCode != RESULT_OK || data == null) return
        when (requestCode) {
            REQ_FILES -> {
                val uris = ArrayList<Uri>()
                data.clipData?.let { c -> for (i in 0 until c.itemCount) uris += c.getItemAt(i).uri }
                if (uris.isEmpty()) data.data?.let { uris += it }
                runImport("Načítám vybrané soubory…") { library.import(library.sourcesFromUris(uris), it) }
            }
            REQ_TREE -> data.data?.let { tree -> runImport("Procházím složku…") { library.import(library.sourcesFromTree(tree), it) } }
            REQ_ONE -> {
                val uri = data.data ?: return
                val clip = pendingClip ?: return
                runImport("Načítám soubor…") { library.importOne(library.sourcesFromUris(listOf(uri)).first(), clip, it) }
            }
        }
    }

    private fun runImport(start: String, work: ((JSONObject) -> Unit) -> JSONObject) {
        busy = true
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        js("kvizProgress", JSONObject().put("message", start))
        executor.execute {
            val result = try { work { p -> js("kvizProgress", p) } }
            catch (e: Exception) { JSONObject().put("error", e.message ?: e.toString()) }
            busy = false
            js("kvizImportDone", result)
            runOnUiThread { web.url?.let { applyMode(it) } }
        }
    }

    /** Zavolá window.name(json) na právě otevřené stránce, pokud tam funkce je. */
    private fun js(fn: String, arg: JSONObject) = runOnUiThread {
        web.evaluateJavascript("window.$fn&&window.$fn($arg)", null)
    }

    /** Rozhraní pro menu.html a bridge.js (window.KvizApp). */
    inner class Bridge {
        @JavascriptInterface fun state(): String = library.state(busy).toString()
        @JavascriptInterface fun busy(): Boolean = busy
        @JavascriptInterface fun version(): String = packageManager.getPackageInfo(packageName, 0).versionName ?: ""
        @JavascriptInterface fun importFiles() = runOnUiThread { launch(mediaIntent(true), REQ_FILES) }
        @JavascriptInterface fun importFolder() = runOnUiThread { launch(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQ_TREE) }
        @JavascriptInterface fun pickClip(name: String) = runOnUiThread { pendingClip = name; launch(mediaIntent(false), REQ_ONE) }
        @JavascriptInterface fun exitQuiz() = runOnUiThread { confirmExit() }
        @JavascriptInterface fun deleteMedia() = runOnUiThread {
            if (busy) return@runOnUiThread
            AlertDialog.Builder(this@MainActivity, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("Smazat ukázky?")
                .setMessage("Z aplikace se smažou všechny nahrané filmy a hudba. Kvízy ani skóre se nesmažou.")
                .setPositiveButton("Smazat") { _, _ -> library.deleteMedia(); js("kvizImportDone", JSONObject().put("deleted", true)) }
                .setNegativeButton("Zrušit", null)
                .show()
        }
    }

    companion object {
        const val MENU = "${LocalServer.ORIGIN}/app/menu.html"
        private const val REQ_FILES = 1
        private const val REQ_TREE = 2
        private const val REQ_ONE = 3
        private const val REQ_CHOOSER = 4
    }
}
