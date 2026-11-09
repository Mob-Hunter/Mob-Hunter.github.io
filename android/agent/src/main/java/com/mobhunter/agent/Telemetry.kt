package com.mobhunter.agent

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.app.KeyguardManager
import android.app.admin.DevicePolicyManager
import android.net.ConnectivityManager
import android.net.wifi.WifiInfo
import android.provider.Settings
import java.io.File
import org.json.JSONObject

/** Device health and security settings only — never content (Non-negotiable #6). */
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
            .put("security", security(ctx))
    }

    /**
     * Security settings for threat detection: on/off states only. No Wi-Fi name, no app list,
     * nothing the user does on the phone (shown in the notice).
     */
    fun security(ctx: Context): JSONObject {
        val s = JSONObject().put("agentVersion", BuildConfigShim.VERSION)
        runCatching { s.put("screenLock", ctx.getSystemService(KeyguardManager::class.java).isDeviceSecure) }
        runCatching {
            val st = ctx.getSystemService(DevicePolicyManager::class.java).storageEncryptionStatus
            s.put("encrypted", st == DevicePolicyManager.ENCRYPTION_STATUS_ACTIVE || st == DevicePolicyManager.ENCRYPTION_STATUS_ACTIVE_PER_USER || st == DevicePolicyManager.ENCRYPTION_STATUS_ACTIVE_DEFAULT_KEY)
        }
        runCatching { s.put("devOptions", Settings.Global.getInt(ctx.contentResolver, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) == 1) }
        runCatching { s.put("usbDebugging", Settings.Global.getInt(ctx.contentResolver, Settings.Global.ADB_ENABLED, 0) == 1) }
        s.put("compromised", looksRooted())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            runCatching {
                val cm = ctx.getSystemService(ConnectivityManager::class.java)
                val wifi = cm.getNetworkCapabilities(cm.activeNetwork)?.transportInfo as? WifiInfo
                if (wifi != null) s.put("openWifi", wifi.currentSecurityType == WifiInfo.SECURITY_TYPE_OPEN)
            }
        }
        return s
    }

    private val SU_PATHS = listOf("/system/bin/su", "/system/xbin/su", "/sbin/su", "/su/bin/su", "/system/app/Superuser.apk", "/data/adb/magisk", "/system/bin/.ext/su")

    /** Root heuristics: su binaries / Magisk, or a build signed with test keys. */
    fun looksRooted(): Boolean = Build.TAGS?.contains("test-keys") == true || SU_PATHS.any { runCatching { File(it).exists() }.getOrDefault(false) }

    @SuppressLint("HardwareIds", "MissingPermission")
    fun serial(): String = try {
        Build.getSerial() // allowed for the device owner
    } catch (_: Exception) {
        "unknown"
    }

    fun model(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
    fun os(): String = "Android ${Build.VERSION.RELEASE}"
}
