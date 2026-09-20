package cz.doma.recepty.ui

import android.content.Context
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.ImageView
import android.widget.TextView
import cz.doma.recepty.R
import cz.doma.recepty.data.Recipe
import cz.doma.recepty.engine.Thumbs
import cz.doma.recepty.engine.VideoSource
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class RecipeAdapter(private val context: Context) : BaseAdapter() {
    var items: List<Recipe> = emptyList()
        set(v) { field = v; notifyDataSetChanged() }
    private val fmt = SimpleDateFormat("d. M. yyyy", Locale("cs"))

    override fun getCount(): Int = items.size
    override fun getItem(position: Int): Recipe = items[position]
    override fun getItemId(position: Int): Long = items[position].id
    override fun hasStableIds(): Boolean = true

    override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
        val row = convertView ?: LayoutInflater.from(context).inflate(R.layout.item_recipe, parent, false)
        val r = items[position]
        row.view<TextView>(R.id.title).text = r.title.ifBlank { r.url }
        val ings = r.ingredients.map { it.name }.distinct()
        row.view<TextView>(R.id.subtitle).text = if (ings.isEmpty()) context.getString(R.string.no_ingredients) else ings.joinToString(", ")
        val meta = mutableListOf<String>()
        meta.add(platformLabel(r.platform))
        if (r.author.isNotBlank()) meta.add(r.author)
        if (r.category.isNotBlank()) meta.add(r.category)
        r.timeMinutes?.let { meta.add("$it min") }
        meta.add(fmt.format(Date(r.createdAt)))
        if (r.needsReview) meta.add("⚠ zkontrolovat")
        row.view<TextView>(R.id.meta).text = meta.joinToString(" · ")
        Thumbs.into(row.view<ImageView>(R.id.thumb), r.thumbPath, context.dp(72), R.drawable.thumb_placeholder)
        return row
    }

    companion object {
        fun platformLabel(p: String): String = try { VideoSource.Platform.valueOf(p.uppercase()).label } catch (e: Exception) { p }
    }
}
