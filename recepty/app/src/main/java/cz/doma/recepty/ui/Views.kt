package cz.doma.recepty.ui

import android.app.Activity
import android.content.Context
import android.util.AttributeSet
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import cz.doma.recepty.R

/** findViewById s garancí non-null (pohled musí v layoutu existovat). */
fun <T : View> Activity.view(id: Int): T = findViewById<T>(id)!!
fun <T : View> View.view(id: Int): T = findViewById<T>(id)!!

fun Context.dp(v: Int): Int = (v * resources.displayMetrics.density + 0.5f).toInt()

/** „Štítek“ – klikací TextView ve tvaru pilulky (klíčové slovo / filtr). */
fun Context.chip(text: String, selected: Boolean = false, onClick: ((String) -> Unit)? = null): TextView {
    val tv = TextView(this)
    tv.text = text
    tv.setBackgroundResource(R.drawable.chip_bg)
    tv.isSelected = selected
    tv.setTextColor(getColor(if (selected) R.color.chip_text_selected else R.color.chip_text))
    tv.textSize = 13f
    tv.setPadding(dp(12), dp(6), dp(12), dp(6))
    val lp = ViewGroup.MarginLayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    lp.setMargins(0, 0, dp(6), dp(6))
    tv.layoutParams = lp
    if (onClick != null) tv.setOnClickListener { onClick(text) }
    return tv
}

/** Jednoduchý zalamovací layout pro štítky (bez AndroidX FlexboxLayout). */
class FlowLayout(context: Context, attrs: AttributeSet? = null) : ViewGroup(context, attrs) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec) - paddingLeft - paddingRight
        var x = 0; var y = 0; var rowH = 0
        for (i in 0 until childCount) {
            val c = getChildAt(i); if (c.visibility == GONE) continue
            measureChild(c, MeasureSpec.makeMeasureSpec(width, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
            val lp = c.layoutParams as? MarginLayoutParams
            val w = c.measuredWidth + (lp?.leftMargin ?: 0) + (lp?.rightMargin ?: 0)
            val h = c.measuredHeight + (lp?.topMargin ?: 0) + (lp?.bottomMargin ?: 0)
            if (x + w > width && x > 0) { x = 0; y += rowH; rowH = 0 }
            x += w; rowH = maxOf(rowH, h)
        }
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), resolveSize(y + rowH + paddingTop + paddingBottom, heightMeasureSpec))
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val width = r - l - paddingLeft - paddingRight
        var x = 0; var y = 0; var rowH = 0
        for (i in 0 until childCount) {
            val c = getChildAt(i); if (c.visibility == GONE) continue
            val lp = c.layoutParams as? MarginLayoutParams
            val ml = lp?.leftMargin ?: 0; val mt = lp?.topMargin ?: 0
            val w = c.measuredWidth + ml + (lp?.rightMargin ?: 0)
            val h = c.measuredHeight + mt + (lp?.bottomMargin ?: 0)
            if (x + w > width && x > 0) { x = 0; y += rowH; rowH = 0 }
            c.layout(paddingLeft + x + ml, paddingTop + y + mt, paddingLeft + x + ml + c.measuredWidth, paddingTop + y + mt + c.measuredHeight)
            x += w; rowH = maxOf(rowH, h)
        }
    }

    override fun generateLayoutParams(attrs: AttributeSet?): LayoutParams = MarginLayoutParams(context, attrs)
    override fun generateDefaultLayoutParams(): LayoutParams = MarginLayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)
    override fun generateLayoutParams(p: LayoutParams?): LayoutParams = MarginLayoutParams(p)
    override fun checkLayoutParams(p: LayoutParams?): Boolean = p is MarginLayoutParams
}
