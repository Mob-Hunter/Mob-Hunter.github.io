package com.mobhunter.agent

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import org.json.JSONObject

/**
 * Foreground service, running ONLY while Lost Mode (Tier 2) or work-hours
 * location (Tier 3) is active — always with its persistent notification.
 */
class AgentService : Service() {
    private lateinit var thread: HandlerThread
    private lateinit var handler: Handler

    companion object {
        fun needed(ctx: Context): Boolean {
            val c = Config(ctx)
            val p: JSONObject? = c.policy
            return c.enrolled && c.acknowledgedAt > 0 && (c.lostMode || (p?.optBoolean("continuousLocation") == true && withinWorkingHours(p, System.currentTimeMillis())))
        }

        fun reconcile(ctx: Context) {
            if (needed(ctx)) ctx.startForegroundService(Intent(ctx, AgentService::class.java)) else stop(ctx)
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, AgentService::class.java))
        }
    }

    override fun onCreate() {
        super.onCreate()
        thread = HandlerThread("mob-hunter-location").also { it.start() }
        handler = Handler(thread.looper)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val c = Config(this)
        val (channel, title, text) = if (c.lostMode) {
            Triple(Notifier.CH_LOST, "Lost Mode is on", Tracking.noticeText(c, null))
        } else {
            Triple(Notifier.CH_CONTINUOUS, "Work location sharing is on", "Location is shared during working hours. Tap for details.")
        }
        startForeground(Notifier.ID_FOREGROUND, Notifier.build(this, channel, title, text, ongoing = true), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        handler.removeCallbacksAndMessages(null)
        handler.post(object : Runnable {
            override fun run() {
                if (!needed(this@AgentService)) {
                    stopSelf()
                    return
                }
                val cfg = Config(this@AgentService)
                // While actively tracked, check in every 2 minutes so "found" / new limits arrive quickly even without push.
                if (cfg.trackingActive && System.currentTimeMillis() - cfg.lastTrackingSyncAt >= 120_000) {
                    cfg.lastTrackingSyncAt = System.currentTimeMillis()
                    Agent(this@AgentService).sync()
                }
                Agent(this@AgentService).periodicLocation()
                handler.postDelayed(this, 60_000) // checks each minute; fixes follow the 5-min / ≥15-min cadence
            }
        })
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        thread.quitSafely()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
