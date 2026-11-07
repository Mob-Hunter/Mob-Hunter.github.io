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

/** Background sync via WorkManager: every 15 min, plus immediately on push wake / boot / enrolment. */
object Sync {
    private val net = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun schedulePeriodic(ctx: Context) {
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
            "mob-hunter-sync",
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setConstraints(net).build(),
        )
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
