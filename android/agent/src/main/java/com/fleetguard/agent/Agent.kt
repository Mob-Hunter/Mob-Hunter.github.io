package com.fleetguard.agent

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId

/**
 * The agent's main loop: enrol → check in → pull signed commands → verify →
 * execute → report. Called from WorkManager (periodic + on push wake), the
 * foreground service and boot. Serialised with a lock.
 */
class Agent(private val ctx: Context) {
    private val config = Config(ctx)
    private val api = ApiClient(config)

    companion object {
        private const val TAG = "FleetGuardAgent"
        private val lock = Any()
    }

    /** Exchanges the one-time token for a certificate. Generates the Keystore key on first use. */
    fun enrollIfNeeded(): Boolean {
        if (config.enrolled) return true
        val token = config.enrollToken ?: return false
        val pin = config.serverPin ?: throw IllegalStateException("Missing server pin from the provisioning QR")
        val publicKey = DeviceKey.create()
        val res = api.enroll(
            JSONObject()
                .put("token", token)
                .put("devicePublicKey", publicKey)
                .put("keyAlg", "ES256")
                .put("platform", "android")
                .put("hardware", JSONObject().put("serial", Telemetry.serial()).put("model", Telemetry.model()).put("os", Telemetry.os())),
        )
        // Certificate pinning: the server's signing key must match the fingerprint in the QR.
        val serverKey = res.getString("serverPublicKey")
        if (ServerCrypto.pinOf(serverKey) != pin) {
            DeviceKey.destroy()
            throw SecurityException("Server key does not match the pinned fingerprint — refusing to enrol")
        }
        config.deviceId = res.getString("deviceId")
        config.certJson = res.getString("certJson")
        config.certSig = res.getString("certSig")
        config.serverPublicKey = serverKey
        config.policyJson = res.getJSONObject("policy").toString()
        config.noticeJson = res.optJSONObject("notice")?.toString()
        config.transparencyPath = res.optStr("transparencyUrl")
        res.optJSONObject("push")?.let { config.pushConfigJson = it.toString() }
        config.enrollToken = null // one-time token is discarded
        Notifier.post(ctx, Notifier.CH_MANAGEMENT, "This device is managed by your organisation", "Your IT team can see device health and, only when needed, its location. You are notified every time. Tap to see what is collected.")
        PushSetup.init(ctx)
        PolicyEnforcer.apply(ctx, config.policy!!)
        return true
    }

    fun sync(): Unit = synchronized(lock) {
        if (config.revoked) return
        try {
            if (!enrollIfNeeded()) return
            checkin()
            pullAndExecute()
            AgentService.reconcile(ctx)
            config.lastError = null
        } catch (e: ApiException) {
            Log.w(TAG, "API error ${e.status} ${e.code}: ${e.message}")
            config.lastError = "${e.code}: ${e.message}"
            if (e.status == 401 && (e.message?.contains("revoked") == true || e.message?.contains("Unknown device") == true)) {
                // Wiped, retired or deleted on the server: stop for good.
                config.revoked = true
                AgentService.stop(ctx)
            }
        } catch (e: Exception) {
            Log.w(TAG, "sync failed", e)
            config.lastError = e.message
        }
    }

    private fun checkin() {
        val body = JSONObject()
            .put("telemetry", Telemetry.collect(ctx))
            .put("serial", Telemetry.serial())
            .put("model", Telemetry.model())
            .put("os", Telemetry.os())
        val notice = config.notice
        if (config.acknowledgedAt > 0 && !config.ackSent && notice != null) {
            body.put("policyAck", JSONObject().put("version", notice.optString("version")).put("at", config.acknowledgedAt))
        }
        val res = api.post("/v1/checkin", body)
        if (body.has("policyAck")) config.ackSent = true
        config.transparencyPath = res.optStr("transparencyUrl") ?: config.transparencyPath
    }

    private fun pullAndExecute() {
        val verifier = CommandVerifier(config.deviceId!!, config.serverPublicKey!!, config.seen)
        val list: JSONArray = api.getArray("/v1/commands/pending")
        val exec = CommandExecutor(ctx, config, api)
        for (i in 0 until list.length()) {
            val env = list.getJSONObject(i)
            when (val r = verifier.verify(env)) {
                is CommandVerifier.Result.Ok -> exec.execute(r.payload)
                is CommandVerifier.Result.Rejected -> {
                    Log.w(TAG, "rejected command: ${r.reason}")
                    // A replay of something we already ran is skipped silently; anything else is reported.
                    if (r.reason != "replayed") {
                        val id = runCatching { JSONObject(env.optString("signed")).optString("id") }.getOrNull() ?: env.optJSONObject("payload")?.optString("id")
                        if (!id.isNullOrEmpty()) runCatching { api.post("/v1/commands/$id/result", JSONObject().put("status", "rejected").put("detail", "Agent rejected command: ${r.reason}")) }
                    }
                }
            }
        }
    }

    /** Tier 2 (Lost Mode, every 5 min) and Tier 3 (policy, ≥15 min, working hours) — called by AgentService. */
    fun periodicLocation() = synchronized(lock) {
        if (!config.enrolled || config.acknowledgedAt == 0L) return
        val now = System.currentTimeMillis()
        val fixes = JSONArray()
        val battery = runCatching { Telemetry.collect(ctx).optInt("batteryLevel", 100) }.getOrDefault(100)
        if (config.lostMode && now - config.lastLostFixAt >= Tracking.lostFixIntervalMs(config.trackingIntervalSec, config.trackingUntil, now, battery) - 1000) {
            val text = Tracking.noticeText(config, null)
            val shown = Notifier.post(ctx, Notifier.CH_LOST, "Lost Mode is on", text, ongoing = true, id = Notifier.ID_FOREGROUND)
            Locator.fix(ctx, 2, Locator.notificationProof(shown, Notifier.CH_LOST, text))?.let { fixes.put(it) }
            config.lastLostFixAt = now
        }
        val p = config.policy
        if (p != null && p.optBoolean("continuousLocation") && withinWorkingHours(p, now)) {
            val interval = maxOf(15, p.optInt("continuousIntervalMin", 15))
            if (now - config.lastContinuousAt >= interval * 60_000L) {
                val text = "Shared every $interval min during working hours. Tap for details."
                val shown = Notifier.post(ctx, Notifier.CH_CONTINUOUS, "Work location sharing is on", text, ongoing = true, id = Notifier.ID_FOREGROUND)
                Locator.fix(ctx, 3, Locator.notificationProof(shown, Notifier.CH_CONTINUOUS, text))?.let { fixes.put(it) }
                config.lastContinuousAt = now
            }
        }
        if (fixes.length() > 0) runCatching { api.post("/v1/location/batch", JSONObject().put("fixes", fixes)) }
    }

    fun registerPushToken(token: String) {
        if (!config.enrolled) return
        runCatching { api.post("/v1/push-token", JSONObject().put("token", token)) }.onSuccess { config.pushToken = token }
    }
}

/** Mirrors the server's withinWorkingHours (policy time zone, not the phone's). */
fun withinWorkingHours(policy: JSONObject, at: Long): Boolean {
    val wh = policy.optJSONObject("workingHours") ?: return false
    val zone = runCatching { ZoneId.of(wh.optString("timeZone", "UTC")) }.getOrDefault(ZoneId.of("UTC"))
    val t = Instant.ofEpochMilli(at).atZone(zone)
    val day = t.dayOfWeek.value % 7 // Sunday = 0, like JS getDay()
    val days = wh.optJSONArray("days") ?: JSONArray()
    val inDays = (0 until days.length()).any { days.optInt(it) == day }
    return inDays && t.hour >= wh.optInt("startHour", 8) && t.hour < wh.optInt("endHour", 18)
}
