package com.mobhunter.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

/**
 * Transparency notifications (Non-negotiables #2 and #3). There is no setting,
 * server flag or code path that suppresses any of them.
 */
object Notifier {
    const val CH_LOCATION = "location_request"
    const val CH_LOST = "lost_mode"
    const val CH_CONTINUOUS = "continuous_location"
    const val CH_MANAGEMENT = "management"
    const val ID_FOREGROUND = 1001
    private var nextId = 2000

    fun createChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannels(
            listOf(
                NotificationChannel(CH_LOCATION, "Location requests", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Shown every time your organisation requests this device's location"
                },
                NotificationChannel(CH_LOST, "Lost Mode", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Shown while the device is in Lost Mode and its location is shared"
                },
                // Quiet but present: the persistent notice for work-hours location sharing.
                NotificationChannel(CH_CONTINUOUS, "Work location sharing", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown for as long as work-hours location sharing runs"
                },
                NotificationChannel(CH_MANAGEMENT, "Device management", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Enrolment, policy and other management events"
                },
            ),
        )
    }

    private fun openNotice(ctx: Context): PendingIntent = PendingIntent.getActivity(
        ctx, 0, Intent(ctx, NoticeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    fun build(ctx: Context, channel: String, title: String, text: String, ongoing: Boolean): Notification =
        Notification.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_stat_managed)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(openNotice(ctx))
            .setOngoing(ongoing)
            .setAutoCancel(!ongoing)
            .setCategory(if (channel == CH_MANAGEMENT) Notification.CATEGORY_STATUS else Notification.CATEGORY_SERVICE)
            .build()

    /** Returns the time it was shown — the agent sends this as proof with the fix. */
    fun post(ctx: Context, channel: String, title: String, text: String, ongoing: Boolean = false, id: Int? = null): Long {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.notify(id ?: nextId++, build(ctx, channel, title, text, ongoing))
        return System.currentTimeMillis()
    }

    fun cancel(ctx: Context, id: Int) = ctx.getSystemService(NotificationManager::class.java).cancel(id)
}
