package com.mobhunter.agent

import android.annotation.SuppressLint
import android.content.Context
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import com.google.android.gms.tasks.Tasks
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Location fixes. Every caller must have posted the transparency notification
 * first and passes its timestamp, which travels with the fix as proof.
 */
object Locator {
    @SuppressLint("MissingPermission")
    fun fix(ctx: Context, tier: Int, notification: JSONObject): JSONObject? {
        val client = LocationServices.getFusedLocationProviderClient(ctx)
        val cts = CancellationTokenSource()
        val loc = try {
            Tasks.await(client.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cts.token), 30, TimeUnit.SECONDS)
        } catch (_: Exception) {
            cts.cancel()
            null
        }
        val (best, source) = if (loc != null) loc to "fused" else (runCatching { Tasks.await(client.lastLocation, 5, TimeUnit.SECONDS) }.getOrNull() to "last_known")
        best ?: return null
        val out = JSONObject()
            .put("lat", best.latitude)
            .put("lng", best.longitude)
            .put("accuracyM", best.accuracy.toDouble())
            .put("fixAt", best.time)
            .put("source", source)
            .put("tier", tier)
            .put("notification", notification)
        if (source == "last_known") out.put("ageSec", (System.currentTimeMillis() - best.time) / 1000)
        return out
    }

    fun notificationProof(shownAt: Long, channel: String, text: String): JSONObject =
        JSONObject().put("shownAt", shownAt).put("channel", channel).put("text", text.take(200))
}
