package com.mobhunter.agent

import android.app.Application
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import android.content.Context
import java.util.concurrent.TimeUnit

class AgentApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
        PushSetup.init(this)
        Sync.schedulePeriodic(this)
    }
}

/**
 * Background sync via WorkManager at the interval set in the console (15 min by default; Android's
 * minimum for periodic work is 15 min), plus immediately on push wake / boot / enrolment.
 */
object Sync {
    private val net = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun schedulePeriodic(ctx: Context, replace: Boolean = false) {
        val minutes = Config(ctx).syncIntervalMin.coerceIn(15, 1440).toLong()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
            "mob-hunter-sync",
            if (replace) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SyncWorker>(minutes, TimeUnit.MINUTES).setConstraints(net).build(),
        )
    }

    /** Applies a new interval from the server; reschedules only when it changed. */
    fun applyInterval(ctx: Context, minutes: Int) {
        if (minutes <= 0) return
        val c = Config(ctx)
        if (c.syncIntervalMin == minutes) return
        c.syncIntervalMin = minutes
        schedulePeriodic(ctx, replace = true)
    }

    fun now(ctx: Context) {
        WorkManager.getInstance(ctx).enqueueUniqueWork(
            "mob-hunter-sync-now",
            ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(net).setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST).build(),
        )
    }
}

class SyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        Agent(applicationContext).sync()
        return Result.success()
    }

    override fun getForegroundInfo(): androidx.work.ForegroundInfo =
        androidx.work.ForegroundInfo(Notifier.ID_FOREGROUND + 1, Notifier.build(applicationContext, Notifier.CH_MANAGEMENT, "Syncing with your organisation", "Checking for policy updates", false))
}
