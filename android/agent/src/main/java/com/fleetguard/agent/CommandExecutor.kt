package com.fleetguard.agent

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
                    val text = "Your organisation put this device in Lost Mode (ticket $ticket). Its location is shared every 5 minutes until Lost Mode ends."
                    val shown = Notifier.post(ctx, Notifier.CH_LOST, "Lost Mode is on", text, ongoing = true, id = Notifier.ID_FOREGROUND)
                    runCatching { dpm.setLockTaskPackages(admin, arrayOf(ctx.packageName)) }
                    ctx.startActivity(Intent(ctx, LostModeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    config.lastLostFixAt = System.currentTimeMillis()
                    AgentService.reconcile(ctx)
                    result(id, "succeeded", "Lost Mode screen shown", Locator.fix(ctx, 2, Locator.notificationProof(shown, Notifier.CH_LOST, text)))
                }
                "LOST_MODE_OFF" -> {
                    config.lostMode = false
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
                    val problems = PolicyEnforcer.apply(ctx, config.policy!!)
                    AgentService.reconcile(ctx)
                    result(id, "succeeded", if (problems.isEmpty()) "Policy v${config.policy!!.optInt("version")} applied" else "Applied with issues: ${problems.joinToString("; ")}")
                }
                "INSTALL_APP" -> {
                    val r = AppInstaller.install(ctx, params.getString("packageName"), params.getString("url"), params.getString("sha256"))
                    result(id, if (r.isEmpty()) "succeeded" else "failed", r.ifEmpty { "Install session committed for ${params.getString("packageName")}" })
                }
                "REBOOT" -> {
                    result(id, "succeeded", "Rebooting")
                    dpm.reboot(admin)
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
            Log.w("FleetGuardAgent", "command $type failed", e)
            runCatching { result(id, "failed", e.message ?: e.javaClass.simpleName) }
        }
    }
}
