package cz.hlidacpodminek.engine

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import org.json.JSONTokener
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * Most ke sdíleným JS knihovnám (lib/…js) – běží ve skrytém WebView, takže Android používá
 * přesně stejný detektor, offline analyzátor a sestavení požadavku na Claude jako rozšíření prohlížeče.
 * Volání jsou synchronní a NESMÍ probíhat na hlavním vlákně (WebView na něm vyhodnocuje skript).
 */
class JsEngine private constructor(context: Context) {
    private val main = Handler(Looper.getMainLooper())
    private val ready = CompletableFuture<Boolean>()
    private var web: WebView? = null

    init {
        val app = context.applicationContext
        if (Looper.myLooper() == Looper.getMainLooper()) create(app) else main.post { create(app) }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun create(ctx: Context) {
        try {
            val w = WebView(ctx)
            w.settings.javaScriptEnabled = true
            w.settings.allowFileAccess = true
            w.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) { ready.complete(true) }
            }
            w.loadUrl("file:///android_asset/engine.html")
            web = w
        } catch (e: Throwable) {
            ready.completeExceptionally(e)
        }
    }

    /** Zavolá `TG.<fn>(...args)` a vrátí návratovou hodnotu (řetězec). */
    fun call(fn: String, vararg args: String): String {
        check(Looper.myLooper() != Looper.getMainLooper()) { "JsEngine.call nesmí běžet na hlavním vlákně" }
        ready.get(30, TimeUnit.SECONDS)
        val script = StringBuilder("TG.").append(fn).append("(")
        args.forEachIndexed { i, a -> if (i > 0) script.append(','); script.append(JSONObject.quote(a)) }
        script.append(")")
        val f = CompletableFuture<String>()
        main.post {
            val w = web
            if (w == null) f.completeExceptionally(IllegalStateException("WebView není k dispozici"))
            else w.evaluateJavascript(script.toString()) { f.complete(it ?: "null") }
        }
        val raw = f.get(120, TimeUnit.SECONDS)
        val v = JSONTokener(raw).nextValue()
        if (v == null || v === JSONObject.NULL) throw IllegalStateException("JS funkce $fn vrátila null")
        return v.toString()
    }

    fun detect(signals: JSONObject): JSONObject = JSONObject(call("detect", signals.toString()))
    fun analyzeLocal(text: String, meta: JSONObject): JSONObject = JSONObject(call("analyzeLocal", text, meta.toString()))
    fun fromHtml(html: String): JSONObject = JSONObject(call("fromHtml", html))
    fun hash(text: String): String = call("hash", text)
    fun buildRequest(text: String, meta: JSONObject, settings: JSONObject): JSONObject =
        JSONObject(call("buildRequest", text, meta.toString(), settings.toString()))

    companion object {
        @Volatile private var instance: JsEngine? = null
        fun init(context: Context) { get(context) }
        fun get(context: Context): JsEngine {
            return instance ?: synchronized(this) { instance ?: JsEngine(context).also { instance = it } }
        }
    }
}
