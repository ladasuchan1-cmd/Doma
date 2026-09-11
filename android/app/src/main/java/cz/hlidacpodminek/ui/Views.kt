package cz.hlidacpodminek.ui

import android.app.Activity
import android.view.View

/** findViewById s garancí non-null (pohled musí v layoutu existovat). */
fun <T : View> Activity.view(id: Int): T = findViewById<T>(id)!!
fun <T : View> View.view(id: Int): T = findViewById<T>(id)!!
