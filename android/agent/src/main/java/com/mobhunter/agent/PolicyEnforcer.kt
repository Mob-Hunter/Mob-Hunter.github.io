package com.mobhunter.agent

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.app.admin.SystemUpdatePolicy
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.UserManager
import org.json.JSONObject

/** Applies the server policy through DevicePolicyManager (device owner only). */
object PolicyEnforcer {
    fun admin(ctx: Context) = ComponentName(ctx, AgentAdminReceiver::class.java)
    fun dpm(ctx: Context) = ctx.getSystemService(DevicePolicyManager::class.java)!!
    fun isDeviceOwner(ctx: Context) = dpm(ctx).isDeviceOwnerApp(ctx.packageName)

    /** Returns a list of human-readable problems (empty = fully applied). */
    fun apply(ctx: Context, policy: JSONObject): List<String> {
        if (!isDeviceOwner(ctx)) return listOf("not device owner — policy cannot be enforced")
        val dpm = dpm(ctx)
        val admin = admin(ctx)
        val problems = mutableListOf<String>()
        fun restrict(key: String, on: Boolean) = runCatching {
            if (on) dpm.addUserRestriction(admin, key) else dpm.clearUserRestriction(admin, key)
        }.onFailure { problems += "$key: ${it.message}" }

        restrict(UserManager.DISALLOW_FACTORY_RESET, policy.optBoolean("disallowFactoryReset", true))
        restrict(UserManager.DISALLOW_USB_FILE_TRANSFER, policy.optBoolean("disallowUsbTransfer", true))
        restrict(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY, policy.optBoolean("disallowUnknownSources", true))
        restrict(UserManager.DISALLOW_DEBUGGING_FEATURES, policy.optBoolean("disallowDebugging", true))
        // Optional restrictions an administrator switches on per device (all off by default).
        restrict(UserManager.DISALLOW_BLUETOOTH, policy.optBoolean("bluetoothDisabled", false))
        restrict(UserManager.DISALLOW_ADD_USER, policy.optBoolean("disallowAddUser", false))
        restrict(UserManager.DISALLOW_CONFIG_WIFI, policy.optBoolean("disallowConfigWifi", false))
        runCatching { dpm.setCameraDisabled(admin, policy.optBoolean("cameraDisabled", false)) }.onFailure { problems += "camera: ${it.message}" }
        runCatching { dpm.setScreenCaptureDisabled(admin, policy.optBoolean("screenCaptureDisabled", false)) }.onFailure { problems += "screenshots: ${it.message}" }
        val keepLocation = policy.optBoolean("keepLocationOn", true)
        restrict(UserManager.DISALLOW_CONFIG_LOCATION, keepLocation)
        if (keepLocation) runCatching { dpm.setLocationEnabled(admin, true) }.onFailure { problems += "location: ${it.message}" }

        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                dpm.requiredPasswordComplexity = DevicePolicyManager.PASSWORD_COMPLEXITY_MEDIUM
            } else {
                @Suppress("DEPRECATION")
                dpm.setPasswordQuality(admin, DevicePolicyManager.PASSWORD_QUALITY_NUMERIC_COMPLEX)
                @Suppress("DEPRECATION")
                dpm.setPasswordMinimumLength(admin, policy.optInt("passwordMinLength", 6))
            }
        }.onFailure { problems += "password: ${it.message}" }
        runCatching { dpm.setMaximumTimeToLock(admin, policy.optLong("maxTimeToLockSec", 300) * 1000) }.onFailure { problems += "lock: ${it.message}" }
        policy.optJSONObject("updateWindow")?.let { w ->
            runCatching { dpm.setSystemUpdatePolicy(admin, SystemUpdatePolicy.createWindowedInstallPolicy(w.optInt("startMinute", 120), w.optInt("endMinute", 240))) }
                .onFailure { problems += "updates: ${it.message}" }
        }

        // The agent's own permissions (location must work for LOCATE / Lost Mode).
        val perms = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_BACKGROUND_LOCATION, Manifest.permission.READ_PHONE_STATE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) perms += Manifest.permission.POST_NOTIFICATIONS
        for (perm in perms) runCatching { dpm.setPermissionGrantState(admin, ctx.packageName, perm, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED) }

        // Hard-wired OFF (design requirement): no security or network logging, whatever the policy says.
        runCatching { dpm.setSecurityLoggingEnabled(admin, false) }
        runCatching { dpm.setNetworkLoggingEnabled(admin, false) }
        // Staying alive: device-owner apps are exempt from App Standby buckets and background
        // start limits, so WorkManager + the foreground service keep running (design-doc §5.8).
        return problems
    }
}
