package cz.hlidacpodminek.service

import android.accessibilityservice.AccessibilityService
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import cz.hlidacpodminek.data.Prefs
import cz.hlidacpodminek.engine.Analyzer
import cz.hlidacpodminek.engine.PageSignals
import cz.hlidacpodminek.engine.Http
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Služba na pozadí – obdoba content skriptu z rozšíření. Čte obsah aktivního okna a:
 *  - v prohlížeči zjistí adresu stránky; pokud vypadá jako podmínky nebo pokladna/registrace,
 *    stáhne HTML a spustí stejnou detekci a analýzu jako rozšíření,
 *  - v ostatních aplikacích (Obchod Play, aplikace e-shopů, registrace v appce) sbírá text obrazovky;
 *    dlouhý právní text analyzuje, u souhlasu bez dostupných odkazů nabídne analýzu notifikací.
 * Žádný text neopouští telefon, dokud detektor nerozhodne, že jde o podmínky (a i pak jen s API klíčem).
 */
class TermsAccessibilityService : AccessibilityService() {
    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()
    private var pending: Runnable? = null
    private val doneKeys = LinkedHashSet<String>()
    private val buffers = LinkedHashMap<String, LinkedHashSet<String>>()
    private lateinit var prefs: Prefs
    private lateinit var analyzer: Analyzer

    override fun onServiceConnected() {
        super.onServiceConnected()
        prefs = Prefs(this)
        analyzer = Analyzer(this)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val pkg = event?.packageName?.toString() ?: return
        if (pkg == packageName || pkg in SYSTEM_PACKAGES) return
        pending?.let { handler.removeCallbacks(it) }
        val r = Runnable { scan() }
        pending = r
        handler.postDelayed(r, 1300)
    }

    override fun onInterrupt() {}

    private fun scan() {
        val root = try { rootInActiveWindow } catch (e: Exception) { null } ?: return
        val pkg = root.packageName?.toString() ?: return
        if (pkg == packageName || pkg in SYSTEM_PACKAGES) return
        val snap = Snapshot.capture(root, pkg, pkg in BROWSER_PACKAGES)
        executor.execute { try { process(snap) } catch (e: Throwable) { android.util.Log.w(TAG, "process", e) } }
    }

    private fun process(s: Snapshot) {
        if (!prefs.autoMode && !prefs.autoOnDocuments) return
        if (prefs.isIgnored(s.pkg)) return
        if (s.isBrowser) processBrowser(s) else processApp(s)
    }

    // ---------- prohlížeč: máme URL, můžeme stáhnout HTML ----------
    private fun processBrowser(s: Snapshot) {
        val url = s.url ?: return
        val host = try { java.net.URL(url).host } catch (e: Exception) { return }
        if (prefs.isIgnored(host)) return
        val urlKey = "url|" + url.substringBefore('#')
        val quick = analyzer.engine().detect(
            JSONObject().put("url", url).put("title", s.title).put("headings", JSONArray()).put("buttons", s.buttons)
                .put("labels", s.labels).put("links", JSONArray()).put("text", s.text)
        )
        val looksLikeDocument = !quick.isNull("urlHit") || !quick.isNull("titleHit") || quick.optString("kind") == "document"
        val consentSignals = quick.optJSONArray("context")?.length() ?: 0
        val strong = quick.optJSONArray("strong")?.length() ?: 0
        val looksLikeConsent = consentSignals > 0 && (strong > 0 || !quick.isNull("agree"))
        if (!looksLikeDocument && !looksLikeConsent) return
        if (looksLikeDocument && !prefs.autoOnDocuments) return
        if (!looksLikeDocument && !prefs.autoMode) return
        if (!markOnce(urlKey)) return

        try {
            val res = Http.get(url)
            if (res.code !in 200..299) return
            val extra = JSONObject().put("buttons", s.buttons).put("labels", s.labels)
            val page = PageSignals.fromHtml(analyzer.engine(), url, res.body, extra)
            val det = analyzer.engine().detect(page.signals)
            val meta = JSONObject().put("url", url).put("title", page.title)
            val outcome = when (det.optString("kind")) {
                "document" -> analyzer.analyzeText(page.text, meta.put("context", "Uživatel si otevřel tento dokument v prohlížeči."), minLength = prefs.minTextLength)
                "consent" -> {
                    val links = det.optJSONArray("termsLinks") ?: JSONArray()
                    analyzer.analyzeLinks((0 until links.length()).map { links.getJSONObject(it).optString("url") }, meta, Analyzer.describeContext(det.optJSONArray("context")))
                }
                else -> if (looksLikeDocument && page.text.length >= prefs.minTextLength)
                    analyzer.analyzeText(page.text, meta.put("context", "Uživatel si otevřel tento dokument v prohlížeči."), minLength = prefs.minTextLength)
                else null
            } ?: return
            if (!outcome.cached || !shownIds.contains(outcome.id)) {
                shownIds.add(outcome.id)
                Notifier.showResult(this, outcome.id, outcome.result, host, prefs.notify)
            }
        } catch (e: Analyzer.AnalysisException) {
            if (e.message != "NO_API_KEY") android.util.Log.i(TAG, "analýza: " + e.message)
        } catch (e: Exception) {
            android.util.Log.w(TAG, "browser", e)
        }
    }

    // ---------- ostatní aplikace: jen text obrazovky ----------
    private fun processApp(s: Snapshot) {
        val winKey = s.pkg + "|" + s.title.take(60)
        val buf = buffers.getOrPut(winKey) { LinkedHashSet() }
        for (line in s.text.split('\n')) { val l = line.trim(); if (l.length > 3) buf.add(l) }
        while (buffers.size > 4) buffers.remove(buffers.keys.first())
        val accumulated = buf.joinToString("\n").take(300_000)

        val links = JSONArray()
        for (m in URL_RE.findAll(accumulated).take(20)) links.put(JSONObject().put("href", m.value).put("text", m.value))
        val det = analyzer.engine().detect(
            JSONObject().put("url", "app://" + s.pkg).put("title", s.title).put("headings", s.headings).put("buttons", s.buttons)
                .put("labels", s.labels).put("links", links).put("text", accumulated)
        )
        val appLabel = appLabel(s.pkg)
        when (det.optString("kind")) {
            "document" -> {
                if (!prefs.autoOnDocuments || accumulated.length < prefs.minTextLength) return
                val key = "doc|" + winKey + "|" + (accumulated.length / 2000) // znovu až po výrazném doscrollování
                if (!markOnce(key)) return
                runCatching {
                    val out = analyzer.analyzeText(accumulated, JSONObject().put("url", "app://" + s.pkg).put("title", "$appLabel – ${s.title}").put("context", "Text zobrazený v aplikaci $appLabel."), minLength = prefs.minTextLength)
                    Notifier.showResult(this, out.id, out.result, appLabel, prefs.notify)
                }.onFailure { android.util.Log.i(TAG, "app doc: " + it.message) }
            }
            "consent" -> {
                if (!prefs.autoMode) return
                val termsLinks = det.optJSONArray("termsLinks") ?: JSONArray()
                val urls = (0 until termsLinks.length()).map { termsLinks.getJSONObject(it).optString("url") }
                val key = "consent|" + s.pkg + "|" + urls.joinToString(",")
                if (!markOnce(key)) return
                runCatching {
                    val out = analyzer.analyzeLinks(urls, JSONObject().put("url", "app://" + s.pkg).put("title", appLabel), Analyzer.describeContext(det.optJSONArray("context")) + " v aplikaci $appLabel")
                    Notifier.showResult(this, out.id, out.result, appLabel, prefs.notify)
                }.onFailure { android.util.Log.i(TAG, "app consent: " + it.message) }
            }
            else -> {
                // Souhlas s podmínkami bez dostupných odkazů (typicky Obchod Play, registrace v aplikaci).
                val ctx = det.optJSONArray("context")?.length() ?: 0
                val agree = !det.isNull("agree")
                if (!prefs.autoMode || ctx == 0 || !agree) return
                val key = "prompt|" + winKey
                if (!markOnce(key)) return
                Notifier.showConsentPrompt(this, appLabel, accumulated, key)
            }
        }
    }

    private fun markOnce(key: String): Boolean {
        synchronized(doneKeys) {
            if (doneKeys.contains(key)) return false
            doneKeys.add(key)
            while (doneKeys.size > 200) doneKeys.remove(doneKeys.first())
            return true
        }
    }

    private fun appLabel(pkg: String): String = try {
        packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
    } catch (e: PackageManager.NameNotFoundException) { pkg }

    /** Snímek obsahu okna – obdoba collectSignals() z content.js, ale z accessibility stromu. */
    class Snapshot(val pkg: String, val isBrowser: Boolean, val title: String, val url: String?, val text: String,
                   val headings: JSONArray, val buttons: JSONArray, val labels: JSONArray) {
        companion object {
            fun capture(root: AccessibilityNodeInfo, pkg: String, isBrowser: Boolean): Snapshot {
                val texts = StringBuilder()
                val headings = JSONArray(); val buttons = JSONArray(); val labels = JSONArray()
                var url: String? = null
                var count = 0
                fun nodeText(n: AccessibilityNodeInfo): String {
                    val t = n.text?.toString()?.trim().orEmpty()
                    return if (t.isNotEmpty()) t else n.contentDescription?.toString()?.trim().orEmpty()
                }
                fun subtreeText(n: AccessibilityNodeInfo, depth: Int, sb: StringBuilder) {
                    if (depth > 3 || sb.length > 400) return
                    val t = nodeText(n); if (t.isNotEmpty()) sb.append(t).append(' ')
                    for (i in 0 until n.childCount) n.getChild(i)?.let { subtreeText(it, depth + 1, sb) }
                }
                fun walk(n: AccessibilityNodeInfo, depth: Int) {
                    if (++count > 3000 || depth > 60) return
                    val cls = n.className?.toString().orEmpty()
                    val t = nodeText(n)
                    if (n.isPassword) return
                    val id = n.viewIdResourceName.orEmpty()
                    if (isBrowser && url == null && (id.endsWith("url_bar") || id.endsWith("url_field") || id.endsWith("location_bar_edit_text") || id.endsWith("mozac_browser_toolbar_url_view") || id.endsWith("url_text"))) {
                        val u = t.trim()
                        if (u.isNotEmpty() && !u.contains(' ')) url = if (u.startsWith("http")) u else "https://$u"
                    }
                    if (t.isNotEmpty()) {
                        if (cls.contains("CheckBox") || cls.contains("Switch") || cls.contains("RadioButton") || n.isCheckable) {
                            val sb = StringBuilder(); n.parent?.let { subtreeText(it, 0, sb) }
                            labels.put(if (sb.isNotEmpty()) sb.toString().trim() else t)
                        } else if (cls.contains("Button") || (n.isClickable && t.length <= 60)) {
                            buttons.put(t)
                        } else if (n.isHeading || (depth < 8 && t.length in 8..90 && cls.contains("TextView") && count < 40)) {
                            headings.put(t)
                        }
                        if (t.length > 1 && t.length < 5000) texts.append(t).append('\n')
                    } else if (n.isCheckable) {
                        val sb = StringBuilder(); n.parent?.let { subtreeText(it, 0, sb) }
                        if (sb.isNotEmpty()) labels.put(sb.toString().trim())
                    }
                    for (i in 0 until n.childCount) n.getChild(i)?.let { walk(it, depth + 1) }
                }
                walk(root, 0)
                val title = (try { root.window?.title?.toString() } catch (e: Exception) { null })
                    ?: (if (headings.length() > 0) headings.optString(0) else "")
                return Snapshot(pkg, isBrowser, title, url, texts.toString(), headings, buttons, labels)
            }
        }
    }

    companion object {
        private const val TAG = "HlidacPodminek"
        private val shownIds = HashSet<String>()
        private val URL_RE = Regex("https?://[\\w.-]+(?:/[^\\s\"'<>)]*)?", RegexOption.IGNORE_CASE)
        val BROWSER_PACKAGES = setOf(
            "com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary", "org.chromium.chrome",
            "org.mozilla.firefox", "org.mozilla.firefox_beta", "org.mozilla.fenix", "com.brave.browser",
            "com.sec.android.app.sbrowser", "com.opera.browser", "com.opera.mini.native", "com.microsoft.emmx",
            "com.vivaldi.browser", "com.duckduckgo.mobile.android", "com.kiwibrowser.browser", "com.android.browser",
            "com.google.android.apps.chrome", "com.mi.globalbrowser", "com.huawei.browser", "com.ecosia.android",
        )
        val SYSTEM_PACKAGES = setOf(
            "com.android.systemui", "com.android.launcher3", "com.google.android.apps.nexuslauncher", "com.android.settings",
            "com.google.android.inputmethod.latin", "com.samsung.android.honeyboard", "com.android.inputmethod.latin",
            "com.google.android.gms", "android", "com.sec.android.app.launcher", "com.miui.home",
        )
    }
}
