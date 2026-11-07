package com.mobhunter.agent

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import org.json.JSONObject

/** Device health only — never content (Non-negotiable #6). */
object Telemetry {
    fun collect(ctx: Context): JSONObject {
        val battery = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.let { (it.getIntExtra(BatteryManager.EXTRA_LEVEL, 0) * 100) / maxOf(1, it.getIntExtra(BatteryManager.EXTRA_SCALE, 100)) } ?: 0
        val health = when (battery?.getIntExtra(BatteryManager.EXTRA_HEALTH, 0)) {
            BatteryManager.BATTERY_HEALTH_GOOD -> "good"
            BatteryManager.BATTERY_HEALTH_DEAD, BatteryManager.BATTERY_HEALTH_OVERHEAT, BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE -> "poor"
            else -> "fair"
        }
        val temp = (battery?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0) / 10.0
        val stat = StatFs(Environment.getDataDirectory().path)
        val gb = 1024.0 * 1024 * 1024
        return JSONObject()
            .put("batteryLevel", level)
            .put("batteryHealth", health)
            .put("batteryTempC", temp)
            .put("storageFreeGb", Math.round(stat.availableBytes / gb * 10) / 10.0)
            .put("storageTotalGb", Math.round(stat.totalBytes / gb * 10) / 10.0)
            // Play Integrity needs a Google Cloud project per organisation; reported honestly until configured.
            .put("integrity", "NOT_EVALUATED")
            .put("patchLevel", Build.VERSION.SECURITY_PATCH)
    }

    @SuppressLint("HardwareIds", "MissingPermission")
    fun serial(): String = try {
        Build.getSerial() // allowed for the device owner
    } catch (_: Exception) {
        "unknown"
    }

    fun model(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
    fun os(): String = "Android ${Build.VERSION.RELEASE}"
}
