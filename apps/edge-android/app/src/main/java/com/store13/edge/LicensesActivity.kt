package com.store13.edge

import android.app.Activity
import android.content.Context
import android.graphics.Typeface
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView

/** Shows the licenses of what the app ships: ffmpeg (LGPL 2.1+), Node.js, the C++ runtime, ZXing. */
class LicensesActivity : Activity() {
    override fun attachBaseContext(newBase: Context) = super.attachBaseContext(Lang.wrap(newBase))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = buildString {
            append(assets.open("NOTICE.txt").bufferedReader().readText())
            for (f in assets.list("licenses").orEmpty().sorted()) {
                append("\n\n========== $f ==========\n\n")
                append(assets.open("licenses/$f").bufferedReader().readText())
            }
        }
        val pad = (16 * resources.displayMetrics.density).toInt()
        setContentView(
            ScrollView(this).apply {
                addView(
                    TextView(this@LicensesActivity).apply {
                        setPadding(pad, pad, pad, pad)
                        typeface = Typeface.MONOSPACE
                        textSize = 11f
                        setTextIsSelectable(true)
                        this.text = text
                    },
                )
            },
        )
    }
}
