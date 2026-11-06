package com.fleetguard.console

import android.app.Activity
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/** Choose: connect to your organisation's FleetGuard server, or explore the offline demo. */
class ConnectionActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("console", MODE_PRIVATE)
        val pad = (20 * resources.displayMetrics.density).toInt()
        val input = EditText(this).apply {
            hint = "https://fleet.yourcompany.com"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(prefs.getString("serverUrl", ""))
        }
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad * 2, pad, pad)
            addView(TextView(context).apply { text = "FleetGuard Console"; textSize = 24f; setTypeface(typeface, Typeface.BOLD) })
            addView(TextView(context).apply { text = "Connect to your organisation's FleetGuard server. Only HTTPS servers are allowed."; setPadding(0, pad / 2, 0, pad / 2) })
            addView(input)
            addView(Button(context).apply {
                text = "Connect"
                setOnClickListener {
                    val url = input.text.toString().trim().trimEnd('/')
                    if (!Regex("^https://[A-Za-z0-9.-]+(:\\d+)?(/.*)?$").matches(url)) {
                        Toast.makeText(context, "Enter an https:// address", Toast.LENGTH_LONG).show()
                        return@setOnClickListener
                    }
                    prefs.edit().putString("serverUrl", "$url/").putBoolean("chosen", true).apply()
                    open()
                }
            })
            addView(TextView(context).apply { text = "\nNo server yet?"; setTypeface(typeface, Typeface.BOLD) })
            addView(TextView(context).apply { text = "The demo runs the complete console and backend on this phone with simulated devices. Nothing leaves the phone." })
            addView(Button(context).apply {
                text = "Explore the offline demo"
                setOnClickListener {
                    prefs.edit().remove("serverUrl").putBoolean("chosen", true).apply()
                    open()
                }
            })
        }
        setContentView(col)
    }

    private fun open() {
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        finish()
    }
}
