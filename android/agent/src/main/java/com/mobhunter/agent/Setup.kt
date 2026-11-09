package com.mobhunter.agent

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** What this phone lets the agent do right now — reported at every check-in. */
object Capabilities {
    fun notifications(ctx: Context): Boolean = ctx.getSystemService(NotificationManager::class.java).areNotificationsEnabled()

    fun location(ctx: Context): String = when {
        !granted(ctx, Manifest.permission.ACCESS_FINE_LOCATION) && !granted(ctx, Manifest.permission.ACCESS_COARSE_LOCATION) -> "none"
        granted(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION) -> "background"
        else -> "foreground"
    }

    fun deviceAdmin(ctx: Context): Boolean = PolicyEnforcer.dpm(ctx).isAdminActive(PolicyEnforcer.admin(ctx))

    fun collect(ctx: Context): JSONObject = JSONObject()
        .put("deviceOwner", PolicyEnforcer.isDeviceOwner(ctx))
        .put("deviceAdmin", deviceAdmin(ctx))
        .put("notifications", notifications(ctx))
        .put("location", location(ctx))

    private fun granted(ctx: Context, p: String) = ctx.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
}

/** Parses the enrolment link the console shows for phones enrolled without a factory reset. */
object EnrolLink {
    data class Parsed(val server: String, val token: String, val pin: String)

    /** mobhunter://enrol?server=…&token=…&pin=… */
    fun parse(uri: Uri?): Parsed? {
        if (uri == null || uri.scheme != "mobhunter" || uri.host != "enrol") return null
        val server = uri.getQueryParameter("server") ?: return null
        val token = uri.getQueryParameter("token") ?: return null
        val pin = uri.getQueryParameter("pin") ?: return null
        if (!server.startsWith("https://") && !server.startsWith("http://127.0.0.1") && !server.startsWith("http://10.0.2.2")) return null
        return Parsed(server, token, pin)
    }

    /**
     * Accepts what a person may paste: the mobhunter:// link itself, or the console's install link
     * (https://host/#/e/TOKEN), which is resolved through the server's public install-page API.
     */
    fun resolve(text: String): Parsed? {
        val t = text.trim()
        parse(Uri.parse(t))?.let { return it }
        val m = Regex("""^(https://[^/#?\s]+)(?:/[^#\s]*)?#/e/([A-Za-z0-9_-]{16,64})$""").find(t) ?: return null
        val (origin, token) = m.destructured
        val conn = URL("$origin/api/e/$token").openConnection() as HttpURLConnection
        return try {
            conn.connectTimeout = 15_000
            conn.readTimeout = 15_000
            val body = JSONObject(conn.inputStream.bufferedReader().readText())
            when (body.optString("status")) {
                "valid" -> parse(Uri.parse(body.getString("standardLink")))
                "used" -> throw IllegalStateException("This enrolment link has already been used. Mint a new one in the console.")
                "expired" -> throw IllegalStateException("This enrolment link has expired. Mint a new one in the console.")
                else -> throw IllegalStateException("The console does not recognise this enrolment link.")
            }
        } finally {
            conn.disconnect()
        }
    }
}

/**
 * Launcher screen. On a company phone set up by QR provisioning it shows the device's status.
 * On a phone where the agent was simply installed (no factory reset) it enrols the phone in
 * "standard" mode: health, notifications and location against a ticket — never wipe, reboot,
 * silent installs or policy enforcement, which need a factory-reset (device-owner) enrolment.
 */
class SetupActivity : Activity() {
    private lateinit var config: Config
    private val reqNotifications = 1
    private val reqLocation = 2
    private val reqBackground = 3
    private val reqAdmin = 4

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        config = Config(this)
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onResume() {
        super.onResume()
        if (working) return
        if (guided) nextStep() else if (config.enrolled) render()
    }

    private var working = false

    /** True while walking a freshly enrolled phone through permissions and the notice, one step at a time. */
    private var guided = false
    private val asked = mutableSetOf<String>()
    private var clipboardChecked = false

    /**
     * Zero-typing enrolment: the console's enrolment page copies the mobhunter:// link to the clipboard
     * before downloading the app, so the first time the freshly installed app opens it enrols by itself.
     * Only a Mob Hunter enrolment link is ever acted on, and it is cleared from the clipboard once used.
     */
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || clipboardChecked || working || config.enrolled) return
        clipboardChecked = true
        val cm = getSystemService(android.content.ClipboardManager::class.java) ?: return
        val text = runCatching { cm.primaryClip?.getItemAt(0)?.coerceToText(this)?.toString() }.getOrNull()?.trim() ?: return
        val link = EnrolLink.parse(Uri.parse(text)) ?: return
        if (Build.VERSION.SDK_INT >= 28) runCatching { cm.clearPrimaryClip() }
        enrol(link)
    }

    /** Next missing step of the guided setup; shows the status screen when everything is done. */
    private fun nextStep() {
        val owner = PolicyEnforcer.isDeviceOwner(this)
        val loc = Capabilities.location(this)
        when {
            Build.VERSION.SDK_INT >= 33 && !Capabilities.notifications(this) && asked.add("notifications") ->
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), reqNotifications)
            loc == "none" && asked.add("location") ->
                requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), reqLocation)
            loc == "foreground" && asked.add("background") -> show {
                title("One more location setting")
                body("So a lost phone can still be found when the app is closed, Android will open a settings page. Choose \"Allow all the time\".")
                body("Mob Hunter only reads the location when your organisation asks against a ticket, or in Lost Mode — and you get a notification every time.", 14f, Color.GRAY)
                action("Continue") { requestPermissions(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), reqBackground) }
                action("Not now") { nextStep() }
            }
            config.acknowledgedAt == 0L && asked.add("notice") -> startActivity(Intent(this, NoticeActivity::class.java))
            else -> {
                guided = false
                Sync.now(this)
                render()
                if (!owner && config.acknowledgedAt > 0) toastBody("All set — this phone is now enrolled")
            }
        }
    }

    private fun handle(intent: Intent?) {
        val link = EnrolLink.parse(intent?.data)
        when {
            config.enrolled -> render()
            link != null -> enrol(link)
            else -> render()
        }
    }

    private fun enrol(link: EnrolLink.Parsed) {
        working = true
        show { title("Connecting to your organisation…"); body("Checking the server and creating this phone's key.") }
        Thread {
            val error = runCatching {
                config.saveProvisioning(link.server, link.token, link.pin)
                Agent(this).enrollIfNeeded()
            }.exceptionOrNull()
            runOnUiThread {
                working = false
                if (error == null) {
                    Sync.schedulePeriodic(this)
                    Sync.now(this)
                    guided = true
                    nextStep()
                } else {
                    config.enrollToken = null
                    showEnrolForm(error.message ?: "Enrolment failed")
                }
            }
        }.start()
    }

    /** The whole screen is driven by current state, so it is always safe to call again. */
    private fun render() {
        if (!config.enrolled) return showEnrolForm(null)
        val owner = PolicyEnforcer.isDeviceOwner(this)
        if (config.acknowledgedAt == 0L) return show {
            title("Almost done")
            body("Read what your organisation can and cannot see on this phone, then tap \"I understand\". Nothing is collected before that.")
            action("Read the notice") { startActivity(Intent(this@SetupActivity, NoticeActivity::class.java)) }
        }
        show {
            title("This phone is managed")
            body(if (owner) "Company device (fully managed)." else "Standard enrolment — this phone was enrolled without a factory reset. Your organisation sees device health and, only when it asks against a ticket, its location. It cannot wipe this phone, read your data or install apps.")
            section("Permissions")
            row("Notifications", Capabilities.notifications(this@SetupActivity), "Needed so you are told every time your location is requested.") {
                if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), reqNotifications)
                else openAppSettings()
            }
            val loc = Capabilities.location(this@SetupActivity)
            row("Location", loc != "none", "Only used when your organisation requests it, or in Lost Mode. You get a notification each time.") {
                requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), reqLocation)
            }
            if (loc != "none") {
                row("Location while the app is closed", loc == "background", "Choose \"Allow all the time\" so a lost phone can still be found.") {
                    requestPermissions(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), reqBackground)
                }
            }
            if (!owner) {
                row("Remote lock (optional)", Capabilities.deviceAdmin(this@SetupActivity), "Lets your organisation lock the screen if the phone is lost. It cannot wipe it.") {
                    startActivityForResult(
                        Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
                            .putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, PolicyEnforcer.admin(this@SetupActivity))
                            .putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, "Allows your organisation to lock this phone's screen remotely if it is lost. Mob Hunter never wipes a phone enrolled this way."),
                        reqAdmin,
                    )
                }
            }
            section("Status")
            body("Last check-in problem: ${config.lastError ?: "none"}", 13f, Color.GRAY)
            action("Sync now") { Sync.now(this@SetupActivity); toastBody("Syncing with your organisation…") }
            action("What is collected") { startActivity(Intent(this@SetupActivity, NoticeActivity::class.java)) }
            config.transparencyUrl?.let { url -> action("See every location request") { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } }
        }
    }

    private fun showEnrolForm(error: String?): Unit = show {
        title("Enrol this phone")
        body("Scan the enrolment QR code from your IT team with this phone's camera and tap \"Install Mob Hunter & enrol\" — the phone enrols itself.")
        body("Or paste the enrolment link you were sent:", 14f, Color.GRAY)
        if (error != null) body(error, 14f, Color.rgb(185, 28, 28))
        val input = EditText(this@SetupActivity).apply {
            hint = "https://…/#/e/… or mobhunter://enrol?…"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        }
        addView(input)
        action("Enrol") {
            val text = input.text.toString()
            working = true
            show { title("Checking the link…") }
            Thread {
                val parsed = runCatching { EnrolLink.resolve(text) }
                runOnUiThread {
                    working = false
                    parsed.fold(
                        { p -> if (p != null) enrol(p) else showEnrolForm("That is not a Mob Hunter enrolment link.") },
                        { e -> showEnrolForm(e.message ?: "Could not check the link.") },
                    )
                }
            }.start()
        }
        body("Company-owned phones are enrolled differently: factory-reset the phone, tap the welcome screen six times and scan the company-device QR.", 13f, Color.GRAY)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        Sync.now(this) // report the new capabilities straight away
        if (guided) nextStep() else render()
    }

    @Deprecated("Activity result API is not used in this dependency-free UI")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        Sync.now(this)
        render()
    }

    private fun openAppSettings() = startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))

    // ---- tiny view DSL (no layout files) ----
    private fun show(build: LinearLayout.() -> Unit) {
        val pad = (20 * resources.displayMetrics.density).toInt()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad * 2, pad, pad)
            build()
        }
        setContentView(ScrollView(this).apply { addView(col) })
    }

    private fun LinearLayout.title(s: String): Unit = body(s, 22f, null, bold = true)
    private fun LinearLayout.section(s: String): Unit = body(s, 17f, null, bold = true, top = 14)
    private fun LinearLayout.body(s: String, size: Float = 15f, color: Int? = null, bold: Boolean = false, top: Int = 0): Unit = addView(TextView(context).apply {
        text = s
        textSize = size
        if (bold) setTypeface(typeface, Typeface.BOLD)
        color?.let { setTextColor(it) }
        val d = resources.displayMetrics.density
        setPadding(0, (top * d).toInt(), 0, (10 * d).toInt())
    })

    private fun LinearLayout.action(label: String, onClick: () -> Unit): Unit = addView(Button(context).apply {
        text = label
        setOnClickListener { onClick() }
    })

    private fun LinearLayout.row(label: String, ok: Boolean, why: String, fix: () -> Unit) {
        body("${if (ok) "✓" else "•"} $label — ${if (ok) "allowed" else "not allowed"}", 15f, if (ok) Color.rgb(21, 128, 61) else null, bold = true)
        body(why, 13f, Color.GRAY)
        if (!ok) action("Allow ${label.lowercase().removeSuffix(" (optional)")}", fix)
    }

    private fun toastBody(s: String) = android.widget.Toast.makeText(this, s, android.widget.Toast.LENGTH_SHORT).show()

}
