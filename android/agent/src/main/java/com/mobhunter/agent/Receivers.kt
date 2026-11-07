package com.mobhunter.agent

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PersistableBundle

class AgentAdminReceiver : DeviceAdminReceiver() {
    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        saveExtras(context, intent.getParcelableExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE, PersistableBundle::class.java))
        Sync.now(context)
    }

    override fun onEnabled(context: Context, intent: Intent) {
        Sync.schedulePeriodic(context)
    }

    companion object {
        /** Reads { serverUrl, token, serverPin } from the provisioning QR's admin extras bundle. */
        fun saveExtras(ctx: Context, extras: PersistableBundle?) {
            extras ?: return
            Config(ctx).saveProvisioning(extras.getString("serverUrl"), extras.getString("token"), extras.getString("serverPin"))
        }
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            Sync.schedulePeriodic(context)
            Sync.now(context)
            AgentService.reconcile(context)
            if (Config(context).lostMode) {
                context.startActivity(Intent(context, LostModeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }
    }
}
