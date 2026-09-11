package cz.hlidacpodminek.service

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import cz.hlidacpodminek.App
import cz.hlidacpodminek.R
import cz.hlidacpodminek.ui.ResultActivity
import cz.hlidacpodminek.ui.ShareActivity
import org.json.JSONObject

object Notifier {
    private const val ID_RESULT_BASE = 1000
    private const val ID_CONSENT_BASE = 5000

    private fun pending(ctx: Context, intent: Intent, req: Int): PendingIntent =
        PendingIntent.getActivity(ctx, req, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    fun showResult(ctx: Context, id: String, result: JSONObject, sourceLabel: String, alertRisky: Boolean) {
        val verdict = result.optString("verdict")
        val (title, channel) = when (verdict) {
            "nebezpecne" -> "Pozor: rizikové podmínky" to (if (alertRisky) App.CH_ALERTS else App.CH_RESULTS)
            "pozor" -> "Podmínky stojí za pozornost" to (if (alertRisky) App.CH_ALERTS else App.CH_RESULTS)
            else -> "Podmínky vypadají standardně" to App.CH_RESULTS
        }
        val findings = result.optJSONArray("findings")
        val lines = ArrayList<String>()
        if (findings != null) for (i in 0 until findings.length()) {
            val f = findings.getJSONObject(i)
            if (f.optString("severity") != "info" && lines.size < 4) lines.add("• " + f.optString("title"))
        }
        val body = (if (sourceLabel.isNotEmpty()) "$sourceLabel\n" else "") + (if (lines.isEmpty()) result.optString("summary").take(220) else lines.joinToString("\n"))
        val intent = Intent(ctx, ResultActivity::class.java).putExtra(ResultActivity.EXTRA_ID, id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val n = Notification.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body.lines().firstOrNull() ?: "")
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(pending(ctx, intent, id.hashCode()))
            .setAutoCancel(true)
            .setColor(when (verdict) { "nebezpecne" -> 0xFFC62828.toInt(); "pozor" -> 0xFFEF8F00.toInt(); else -> 0xFF2E7D32.toInt() })
            .build()
        ctx.getSystemService(NotificationManager::class.java)!!.notify(ID_RESULT_BASE + (id.hashCode() and 0xffff), n)
    }

    /** V aplikaci je vidět souhlas s podmínkami, ale odkazy na ně nejsou dostupné – nabídne analýzu textu na obrazovce. */
    fun showConsentPrompt(ctx: Context, appLabel: String, screenText: String, key: String) {
        val intent = Intent(ctx, ShareActivity::class.java)
            .setAction(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, screenText.take(200_000))
            .putExtra(Intent.EXTRA_SUBJECT, appLabel)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val n = Notification.Builder(ctx, App.CH_RESULTS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(ctx.getString(R.string.notif_consent_title))
            .setContentText(ctx.getString(R.string.notif_consent_text, appLabel))
            .setStyle(Notification.BigTextStyle().bigText(ctx.getString(R.string.notif_consent_text, appLabel)))
            .setContentIntent(pending(ctx, intent, key.hashCode()))
            .addAction(Notification.Action.Builder(null, ctx.getString(R.string.notif_analyze_screen), pending(ctx, intent, key.hashCode())).build())
            .setAutoCancel(true)
            .build()
        ctx.getSystemService(NotificationManager::class.java)!!.notify(ID_CONSENT_BASE + (key.hashCode() and 0xfff), n)
    }

    fun showError(ctx: Context, message: String) {
        val n = Notification.Builder(ctx, App.CH_STATUS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(ctx.getString(R.string.notif_analyzing_title))
            .setContentText(message.take(200))
            .setStyle(Notification.BigTextStyle().bigText(message.take(600)))
            .setAutoCancel(true)
            .build()
        ctx.getSystemService(NotificationManager::class.java)!!.notify(ID_CONSENT_BASE - 1, n)
    }
}
