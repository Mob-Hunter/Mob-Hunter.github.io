package com.mobhunter.agent

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import org.json.JSONObject

/**
 * The closed command set (Non-negotiable #6): there is no remote shell, no
 * screen capture and no access to messages, photos or browsing — anything
 * not listed here is rejected.
 */
class CommandExecutor(private val ctx: Context, private val config: Config, private val api: ApiClient) {
    private fun result(id: String, status: String, detail: String, location: JSONObject? = null) {
        val body = JSONObject().put("status", status).put("detail", detail.take(200))
        if (location != null) body.put("location", location)
        api.post("/v1/commands/$id/result", body)
    }

    fun execute(p: JSONObject) {
        val id = p.getString("id")
        val type = p.getString("type")
        val params = p.optJSONObject("params") ?: JSONObject()
        val ticket = p.optString("ticket", "—")
        val dpm = PolicyEnforcer.dpm(ctx)
        val admin = PolicyEnforcer.admin(ctx)
        try {
            if ((type == "LOCATE" || type == "LOST_MODE_ON") && config.acknowledgedAt == 0L) {
                result(id, "rejected", "User has not acknowledged the device notice")
                return
            }
            // A phone enrolled without a factory reset is not device owner: never wipe, reboot or
            // install silently there. The server refuses these too; this is the phone's own guard.
            val owner = PolicyEnforcer.isDeviceOwner(ctx)
            if (!owner && type in setOf("WIPE", "REBOOT", "INSTALL_APP", "UNINSTALL_APP")) {
                result(id, "rejected", "Not available on a phone enrolled without a factory reset")
                return
            }
            if (type == "LOCK" && !dpm.isAdminActive(admin)) {
                result(id, "rejected", "Remote lock is not allowed on this phone (Mob Hunter app → Remote lock)")
                return
            }
            when (type) {
                "LOCATE" -> {
                    // Notification FIRST, every time, with the ticket — then the fix.
                    val text = "Requested by your IT team for ticket $ticket. Tap to see all location requests."
                    val shown = Notifier.post(ctx, Notifier.CH_LOCATION, "Your device location was requested", text)
                    val fix = Locator.fix(ctx, 1, Locator.notificationProof(shown, Notifier.CH_LOCATION, text))
                    if (fix != null) result(id, "succeeded", "Fix via FusedLocationProvider (${fix.optString("source")})", fix)
                    else result(id, "failed", "No location available within 30 s")
                }
                "LOST_MODE_ON" -> {
                    config.lostMode = true
                    config.lostMessage = listOf(params.optString("message"), params.optString("phone")).filter { it.isNotBlank() }.joinToString("\n")
                    // Active tracking limits are part of the signed command; the phone enforces the end time itself.
                    config.trackingIntervalSec = params.optInt("trackingIntervalSec", 0).let { if (it == 0) 0 else it.coerceIn(60, 300) }
                    config.trackingUntil = params.optLong("trackingUntil", 0)
                    config.incidentKind = params.optStr("kind")
                    val text = Tracking.noticeText(config, ticket)
                    val shown = Notifier.post(ctx, Notifier.CH_LOST, "Lost Mode is on", text, ongoing = true, id = Notifier.ID_FOREGROUND)
                    runCatching { dpm.setLockTaskPackages(admin, arrayOf(ctx.packageName)) }
                    ctx.startActivity(Intent(ctx, LostModeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    config.lastLostFixAt = System.currentTimeMillis()
                    AgentService.reconcile(ctx)
                    result(id, "succeeded", "Lost Mode screen shown", Locator.fix(ctx, 2, Locator.notificationProof(shown, Notifier.CH_LOST, text)))
                }
                "LOST_MODE_OFF" -> {
                    config.lostMode = false
                    config.trackingIntervalSec = 0
                    config.trackingUntil = 0
                    config.incidentKind = null
                    ctx.sendBroadcast(Intent(LostModeActivity.ACTION_EXIT).setPackage(ctx.packageName))
                    Notifier.cancel(ctx, Notifier.ID_FOREGROUND)
                    Notifier.post(ctx, Notifier.CH_MANAGEMENT, "Lost Mode ended", "Location sharing for Lost Mode has stopped.")
                    AgentService.reconcile(ctx)
                    result(id, "succeeded", "Lost Mode disabled")
                }
                "LOCK" -> {
                    dpm.lockNow()
                    result(id, "succeeded", "Device locked")
                }
                "SYNC_POLICY" -> {
                    val res = api.getJson("/v1/policy")
                    config.policyJson = res.getJSONObject("policy").toString()
                    config.transparencyPath = res.optStr("transparencyUrl") ?: config.transparencyPath
                    Sync.applyInterval(ctx, res.optInt("syncIntervalMin", 0))
                    val problems = PolicyEnforcer.apply(ctx, config.policy!!)
                    AgentService.reconcile(ctx)
                    result(id, "succeeded", if (problems.isEmpty()) "Policy v${config.policy!!.optInt("version")} applied" else "Applied with issues: ${problems.joinToString("; ")}")
                }
                "INSTALL_APP" -> {
                    val r = AppInstaller.install(ctx, params.getString("packageName"), params.getString("url"), params.getString("sha256"))
                    if (r.isEmpty()) config.rememberCatalogueApp(params.getString("packageName"), true)
                    result(id, if (r.isEmpty()) "succeeded" else "failed", r.ifEmpty { "Install session committed for ${params.getString("packageName")}" })
                }
                "COLLECT_INVENTORY" -> {
                    Agent(ctx).sendInventory()
                    result(id, "succeeded", "Inventory collected and uploaded")
                }
                "UNINSTALL_APP" -> {
                    val pkg = params.getString("packageName")
                    when (val r = AppRemover.uninstall(ctx, pkg)) {
                        "" -> { config.rememberCatalogueApp(pkg, false); result(id, "succeeded", "Uninstall requested for $pkg") }
                        "NOT_INSTALLED" -> result(id, "succeeded", "$pkg was not installed")
                        else -> result(id, "failed", r)
                    }
                }
                "MESSAGE" -> {
                    // A visible message to the user: text only, it reads nothing back from the phone.
                    Notifier.post(ctx, Notifier.CH_MESSAGE, params.optString("title", "Message from your IT team").ifBlank { "Message from your IT team" }, params.optString("text"))
                    result(id, "succeeded", "Message shown")
                }
                "RING" -> {
                    Notifier.post(ctx, Notifier.CH_MESSAGE, "Your IT team is ringing this phone", "This sound helps find a misplaced phone. It stops after 30 seconds.")
                    android.os.Handler(android.os.Looper.getMainLooper()).post { Ringer.ring(ctx) }
                    result(id, "succeeded", "Rang for 30 s at alarm volume")
                }
                "REBOOT" -> {
                    result(id, "succeeded", "Rebooting")
                    dpm.reboot(admin)
                }
                "RELEASE" -> {
                    // Report first: after this the agent and its credentials are gone.
                    result(id, "succeeded", "Restrictions cleared, releasing device owner and uninstalling the agent")
                    Releaser.release(ctx, config, params.optString("orgName", "Your organisation"))
                }
                "WIPE" -> {
                    // Report first: after the wipe there is no agent left to report.
                    result(id, "succeeded", "Factory reset initiated")
                    DeviceKey.destroy()
                    config.clearAll()
                    if (Build.VERSION.SDK_INT >= 34) dpm.wipeDevice(0) else @Suppress("DEPRECATION") dpm.wipeData(0)
                }
                else -> result(id, "rejected", "Unsupported command")
            }
        } catch (e: Exception) {
            Log.w("MobHunterAgent", "command $type failed", e)
            runCatching { result(id, "failed", e.message ?: e.javaClass.simpleName) }
        }
    }
}
