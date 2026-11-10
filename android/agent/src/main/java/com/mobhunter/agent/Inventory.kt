package com.mobhunter.agent

import android.app.ActivityManager
import android.app.KeyguardManager
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.os.SystemClock
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.net.NetworkInterface
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Device inventory: hardware, OS, storage, network adapters and configuration settings. Apps: only
 * those installed from the company catalogue — never the user's personal apps (Non-negotiable #6).
 */
object Inventory {
    const val EVERY_MS = 6 * 60 * 60 * 1000L

    fun collect(ctx: Context, config: Config): JSONObject {
        val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        val am = ctx.getSystemService(ActivityManager::class.java)
        val mem = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        val gb = 1_000_000_000.0
        val stat = StatFs(Environment.getDataDirectory().path)
        val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
        val settings = JSONArray()
        fun set(cat: String, name: String, value: Any?) {
            val v = value?.toString()?.trim().orEmpty()
            if (v.isNotEmpty()) settings.put(JSONObject().put("category", cat).put("name", name).put("value", v))
        }
        fun global(k: String) = runCatching { Settings.Global.getInt(ctx.contentResolver, k, 0) }.getOrDefault(0)
        val onOff = { b: Boolean -> if (b) "On" else "Off" }
        val owner = PolicyEnforcer.isDeviceOwner(ctx)

        set("Management", "Mode", if (owner) "Company device (device owner)" else "Existing phone (standard)")
        set("Management", "Agent version", BuildConfigShim.VERSION)
        set("Management", "Check-in interval", "${config.syncIntervalMin} min")
        runCatching { set("Security", "Screen lock", if (ctx.getSystemService(KeyguardManager::class.java).isDeviceSecure) "PIN / pattern / password" else "None") }
        runCatching {
            val st = dpm.storageEncryptionStatus
            set("Security", "Storage encryption", if (st == DevicePolicyManager.ENCRYPTION_STATUS_ACTIVE || st == DevicePolicyManager.ENCRYPTION_STATUS_ACTIVE_PER_USER || st == DevicePolicyManager.ENCRYPTION_STATUS_ACTIVE_DEFAULT_KEY) "On" else "Off")
        }
        set("Security", "Security patch level", Build.VERSION.SECURITY_PATCH)
        set("Security", "USB debugging", onOff(global(Settings.Global.ADB_ENABLED) == 1))
        set("Security", "Developer options", onOff(global(Settings.Global.DEVELOPMENT_SETTINGS_ENABLED) == 1))
        set("Security", "Root indicators", if (Telemetry.looksRooted()) "Found" else "None found")
        set("Security", "Verified boot state", sysProp("ro.boot.verifiedbootstate"))
        set("Security", "Bootloader", if (sysProp("ro.boot.flash.locked") == "1") "Locked" else if (sysProp("ro.boot.flash.locked") == "0") "Unlocked" else "")
        if (owner) {
            runCatching { set("Restrictions", "Camera", if (dpm.getCameraDisabled(null)) "Disabled by policy" else "Allowed") }
            runCatching { set("Restrictions", "Screen capture", if (dpm.getScreenCaptureDisabled(null)) "Blocked by policy" else "Allowed") }
        }
        runCatching { set("Display", "Screen timeout", "${Settings.System.getInt(ctx.contentResolver, Settings.System.SCREEN_OFF_TIMEOUT) / 1000} s") }
        set("System", "Automatic date & time", onOff(global(Settings.Global.AUTO_TIME) == 1))
        set("System", "Airplane mode", onOff(global(Settings.Global.AIRPLANE_MODE_ON) == 1))
        runCatching { set("System", "Location", if (Settings.Secure.getInt(ctx.contentResolver, Settings.Secure.LOCATION_MODE) == Settings.Secure.LOCATION_MODE_OFF) "Off" else "On") }
        set("System", "Build", Build.DISPLAY)
        runCatching {
            val cm = ctx.getSystemService(ConnectivityManager::class.java)
            val caps = cm.getNetworkCapabilities(cm.activeNetwork)
            set("Network", "Active connection", when {
                caps == null -> "None"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "Mobile data"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "Ethernet"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "VPN"
                else -> "Other"
            })
            if (caps != null) set("Network", "VPN active", onOff(caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)))
        }

        val network = JSONArray()
        runCatching {
            for (ni in NetworkInterface.getNetworkInterfaces()) {
                if (ni.isLoopback || ni.name.startsWith("dummy") || ni.name.startsWith("ip6")) continue
                val v4 = JSONArray(); val v6 = JSONArray()
                for (a in ni.inetAddresses) {
                    if (a.isLinkLocalAddress || a.isLoopbackAddress) continue
                    val h = a.hostAddress?.substringBefore('%') ?: continue
                    if (h.contains(':')) v6.put(h) else v4.put(h)
                }
                if (v4.length() == 0 && v6.length() == 0 && !ni.isUp) continue
                // Android hides real MAC addresses from apps; none is reported.
                network.put(JSONObject().put("name", ni.name).put("ipv4", v4).put("ipv6", v6).put("up", ni.isUp))
            }
        }

        val software = JSONArray()
        for (pkg in config.installedCatalogueApps()) {
            runCatching {
                val pi = ctx.packageManager.getPackageInfo(pkg, 0)
                software.put(JSONObject().put("name", pi.applicationInfo?.loadLabel(ctx.packageManager)?.toString() ?: pkg).put("version", pi.versionName ?: "").put("publisher", "Company catalogue ($pkg)"))
            }
        }

        return JSONObject()
            .put("collectedAt", System.currentTimeMillis())
            .put("agentVersion", BuildConfigShim.VERSION)
            .put("system", JSONObject().put("manufacturer", Build.MANUFACTURER).put("model", "${Build.MANUFACTURER} ${Build.MODEL}").put("serial", Telemetry.serial()).put("chassis", "Phone / tablet").put("firmware", Build.BOOTLOADER))
            .put("os", JSONObject().put("name", "Android ${Build.VERSION.RELEASE}").put("version", Build.VERSION.RELEASE).put("build", Build.ID).put("arch", Build.SUPPORTED_ABIS.firstOrNull() ?: "").put("kernel", System.getProperty("os.version") ?: "")
                .put("lastBoot", iso.format(Date(System.currentTimeMillis() - SystemClock.elapsedRealtime()))).put("timezone", TimeZone.getDefault().id))
            .put("hardware", JSONObject().put("cpu", "${Build.HARDWARE} (${Build.SUPPORTED_ABIS.joinToString()})").put("threads", Runtime.getRuntime().availableProcessors()).put("memoryGb", Math.round(mem.totalMem / gb * 10) / 10.0))
            .put("disks", JSONArray().put(JSONObject().put("mount", "/data").put("sizeGb", Math.round(stat.totalBytes / gb * 10) / 10.0).put("freeGb", Math.round(stat.availableBytes / gb * 10) / 10.0)))
            .put("network", network)
            .put("settings", settings)
            .put("software", software)
    }

    @Suppress("PrivateApi")
    private fun sysProp(key: String): String = runCatching {
        Class.forName("android.os.SystemProperties").getMethod("get", String::class.java).invoke(null, key) as String
    }.getOrDefault("")
}
