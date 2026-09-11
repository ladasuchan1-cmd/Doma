package cz.hlidacpodminek

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import cz.hlidacpodminek.engine.JsEngine

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        createChannels()
        JsEngine.init(this)
    }

    private fun createChannels() {
        val nm = getSystemService(NotificationManager::class.java)!!
        nm.createNotificationChannel(
            NotificationChannel(CH_RESULTS, getString(R.string.notif_channel_results), NotificationManager.IMPORTANCE_DEFAULT)
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_ALERTS, "Rizikové podmínky", NotificationManager.IMPORTANCE_HIGH)
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_STATUS, getString(R.string.notif_channel_status), NotificationManager.IMPORTANCE_LOW)
        )
    }

    companion object {
        const val CH_RESULTS = "vysledky"
        const val CH_ALERTS = "rizika"
        const val CH_STATUS = "stav"
    }
}
