package com.mobhunter.agent

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.PersistableBundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject

/** Small programmatic UI helpers (no layouts needed for four screens). */
private fun Activity.column(build: LinearLayout.() -> Unit): ScrollView {
    val pad = (20 * resources.displayMetrics.density).toInt()
    val col = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(pad, pad * 2, pad, pad)
        build()
    }
    return ScrollView(this).apply { addView(col) }
}

private fun LinearLayout.text(s: String, size: Float = 16f, bold: Boolean = false, color: Int? = null) = addView(TextView(context).apply {
    text = s
    textSize = size
    if (bold) setTypeface(typeface, Typeface.BOLD)
    color?.let { setTextColor(it) }
    setPadding(0, 0, 0, (10 * resources.displayMetrics.density).toInt())
})

private fun LinearLayout.button(label: String, onClick: () -> Unit): Button = Button(context).apply {
    text = label
    setOnClickListener { onClick() }
    this@button.addView(this)
}

private fun bulletList(o: JSONObject?, key: String, fallback: List<String>): String {
    val arr = o?.optJSONArray(key)
    val items = if (arr != null) (0 until arr.length()).map { arr.optString(it) } else fallback
    return items.joinToString("\n") { "• $it" }
}

private val FALLBACK_COLLECTED = listOf(
    "Device identifiers: serial number, model, OS version and security patch level.",
    "Device health: battery, storage, integrity.",
    "Location — only when requested against a ticket (you are notified every time), in Lost Mode, or during working hours if your policy enables it (with a persistent notification).",
)
private val FALLBACK_NOT_COLLECTED = listOf("Messages, e-mail, calls, photos, files, browsing history.", "Screen contents. There is no remote screen or remote shell.")

/** GET_PROVISIONING_MODE (Android 10+): this is a fully managed, company-owned device. */
class ProvisioningModeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AgentAdminReceiver.saveExtras(this, intent.getParcelableExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE, PersistableBundle::class.java))
        setResult(RESULT_OK, Intent().putExtra(DevicePolicyManager.EXTRA_PROVISIONING_MODE, DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE))
        finish()
    }
}

/**
 * ADMIN_POLICY_COMPLIANCE: runs inside Setup. Enrols with the server, applies the
 * baseline policy and shows the collection notice. Collection starts only after
 * the employee taps "I understand" (Non-negotiable #1).
 */
class PolicyComplianceActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AgentAdminReceiver.saveExtras(this, intent.getParcelableExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE, PersistableBundle::class.java))
        showWorking("Connecting to your organisation…")
        enrol()
    }

    private fun showWorking(msg: String) = setContentView(column { text(msg, 18f, bold = true) })

    private fun enrol() {
        Thread {
            val error = runCatching { Agent(this).enrollIfNeeded() }.exceptionOrNull()
            runOnUiThread { if (error == null) showNotice() else showError(error.message ?: "Enrolment failed") }
        }.start()
    }

    private fun showError(msg: String) = setContentView(column {
        text("Could not reach your organisation", 20f, bold = true)
        text(msg)
        button("Retry") { showWorking("Retrying…"); enrol() }
        button("Continue setup and enrol later") { finishOk() }
    })

    private fun showNotice() = setContentView(noticeView(this) { ack ->
        if (ack) {
            Config(this).acknowledgedAt = System.currentTimeMillis()
            finishOk()
        }
    })

    private fun finishOk() {
        Sync.now(this)
        setResult(RESULT_OK)
        finish()
    }
}

/** The notice + "what we collect" + link to the employee's transparency page. Opened from every notification. */
class NoticeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(noticeView(this) { ack ->
            if (ack) {
                Config(this).acknowledgedAt = System.currentTimeMillis()
                Sync.now(this)
            }
            finish()
        })
    }
}

private fun noticeView(a: Activity, onDone: (Boolean) -> Unit): View {
    val c = Config(a)
    val n = c.notice
    return a.column {
        text(n?.optString("title") ?: "Company device notice", 22f, bold = true)
        text(if (PolicyEnforcer.isDeviceOwner(a)) "This phone is owned and managed by your organisation." else "This phone is enrolled with your organisation without a factory reset. Your organisation cannot wipe it, read your data or install apps on it.")
        text("What is collected", 18f, bold = true)
        text(bulletList(n, "collected", FALLBACK_COLLECTED))
        text("Never collected", 18f, bold = true)
        text(bulletList(n, "notCollected", FALLBACK_NOT_COLLECTED))
        n?.optString("retention")?.takeIf { it.isNotBlank() }?.let { text(it, 14f) }
        n?.optString("rights")?.takeIf { it.isNotBlank() }?.let { text(it, 14f) }
        c.transparencyUrl?.let { url ->
            button("See every location request for this device") { a.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        }
        if (c.acknowledgedAt == 0L) button("I understand") { onDone(true) } else {
            text("You acknowledged this notice.", 14f)
            button("Close") { onDone(false) }
        }
        c.lastError?.let { text("Last sync problem: $it", 12f, color = Color.GRAY) }
    }
}

/** Full-screen Lost Mode (lock task when permitted). Exits only when the server ends Lost Mode. */
class LostModeActivity : Activity() {
    companion object { const val ACTION_EXIT = "com.mobhunter.agent.EXIT_LOST_MODE" }

    private val exit = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            runCatching { stopLockTask() }
            finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val c = Config(this)
        if (!c.lostMode) return finish()
        registerReceiver(exit, IntentFilter(ACTION_EXIT), RECEIVER_NOT_EXPORTED)
        setContentView(column {
            gravity = Gravity.CENTER_HORIZONTAL
            text("Lost device", 28f, bold = true, color = Color.WHITE)
            text(c.lostMessage ?: "This device belongs to a company. Please contact its owner.", 18f, color = Color.WHITE)
            text("Location is shared with the organisation while Lost Mode is on.", 14f, color = Color.WHITE)
        })
        runCatching { startLockTask() }
    }

    @Deprecated("Lost Mode cannot be dismissed with Back")
    override fun onBackPressed() { /* stays until the server disables Lost Mode */ }

    override fun onDestroy() {
        runCatching { unregisterReceiver(exit) }
        super.onDestroy()
    }
}
