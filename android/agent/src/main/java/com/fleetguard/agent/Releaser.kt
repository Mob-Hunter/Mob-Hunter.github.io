package com.fleetguard.agent

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.UserManager
import android.util.Log
import androidx.work.WorkManager

/**
 * RELEASE: the organisation deleted this device from the console. Give the phone
 * back to the employee as an ordinary, unmanaged phone — nothing is wiped:
 * lift every restriction, erase the agent's key and settings, give up
 * device-owner rights, then uninstall the agent itself.
 *
 * A device-owner app cannot uninstall itself while it is an active admin, so
 * ownership is released first. Android then removes the app; on builds that ask
 * the user to confirm, the system "Uninstall?" prompt is shown (and offered again
 * from a notification if the system blocks opening it from the background).
 */
object Releaser {
    private const val TAG = "FleetGuardAgent"
    const val ID_UNINSTALL = 1201

    /** Restrictions the agent may have set (PolicyEnforcer) — all cleared on release. */
    private val RESTRICTIONS = listOf(
        UserManager.DISALLOW_FACTORY_RESET,
        UserManager.DISALLOW_USB_FILE_TRANSFER,
        UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY,
        UserManager.DISALLOW_DEBUGGING_FEATURES,
        UserManager.DISALLOW_CONFIG_LOCATION,
    )

    fun release(ctx: Context, config: Config, orgName: String) {
        val dpm = PolicyEnforcer.dpm(ctx)
        val admin = PolicyEnforcer.admin(ctx)
        val isOwner = dpm.isDeviceOwnerApp(ctx.packageName)

        // 1. Stop everything the agent runs.
        runCatching { AgentService.stop(ctx) }
        runCatching { WorkManager.getInstance(ctx).cancelAllWork() }
        ctx.sendBroadcast(Intent(LostModeActivity.ACTION_EXIT).setPackage(ctx.packageName))

        // 2. Lift every policy so the phone is fully usable as a normal phone.
        if (isOwner) {
            for (r in RESTRICTIONS) runCatching { dpm.clearUserRestriction(admin, r) }
            runCatching { dpm.setLockTaskPackages(admin, emptyArray()) }
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    dpm.requiredPasswordComplexity = DevicePolicyManager.PASSWORD_COMPLEXITY_NONE
                } else {
                    @Suppress("DEPRECATION")
                    dpm.setPasswordQuality(admin, DevicePolicyManager.PASSWORD_QUALITY_UNSPECIFIED)
                }
            }
            runCatching { dpm.setMaximumTimeToLock(admin, 0) }
            runCatching { dpm.setSystemUpdatePolicy(admin, null) }
        }

        // 3. Erase the agent's identity and settings; tell the employee.
        DeviceKey.destroy()
        config.clearAll()
        ctx.getSystemService(NotificationManager::class.java).cancelAll()
        Notifier.post(
            ctx, Notifier.CH_MANAGEMENT, "This phone is no longer managed",
            "$orgName removed this phone from management. Restrictions are lifted, nothing is collected any more, and the management app is being uninstalled. Your data was not touched.",
        )

        // 4. Give up device-owner rights (required before an admin app can be uninstalled).
        if (isOwner) {
            @Suppress("DEPRECATION")
            runCatching { dpm.clearDeviceOwnerApp(ctx.packageName) }.onFailure { Log.w(TAG, "clearDeviceOwnerApp failed", it) }
        }
        runCatching { if (dpm.isAdminActive(admin)) dpm.removeActiveAdmin(admin) }

        // 5. Uninstall the agent itself.
        uninstallSelf(ctx)
    }

    fun uninstallSelf(ctx: Context) {
        val pi = PendingIntent.getBroadcast(
            ctx, 0, Intent(ctx, UninstallResultReceiver::class.java),
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        runCatching { ctx.packageManager.packageInstaller.uninstall(ctx.packageName, pi.intentSender) }
            .onFailure { Log.w(TAG, "uninstall request failed", it) }
    }
}

/** Handles the uninstall outcome; if Android needs the user to confirm, show that prompt. */
class UninstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status != PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Log.i("FleetGuardAgent", "uninstall status $status ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
            return
        }
        @Suppress("DEPRECATION")
        val confirm = (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT)) ?: return
        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { context.startActivity(confirm) }
        // Background activity starts can be blocked once the app is no longer device owner: offer it from a notification too.
        val pi = PendingIntent.getActivity(context, 0, confirm, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        context.getSystemService(NotificationManager::class.java).notify(
            Releaser.ID_UNINSTALL,
            Notification.Builder(context, Notifier.CH_MANAGEMENT)
                .setSmallIcon(R.drawable.ic_stat_managed)
                .setContentTitle("Finish removing the management app")
                .setContentText("Your organisation released this phone. Tap to uninstall the management app.")
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build(),
        )
    }
}
