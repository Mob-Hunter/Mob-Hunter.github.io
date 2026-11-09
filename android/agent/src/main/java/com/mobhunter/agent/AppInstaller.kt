package com.mobhunter.agent

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** Silent install of an approved catalogue app (device owner), only if its SHA-256 matches. */
object AppInstaller {
    /** Returns "" on success or an error description. */
    fun install(ctx: Context, packageName: String, url: String, sha256: String): String {
        if (!url.startsWith("https://")) return "Refusing non-HTTPS download"
        val tmp = File.createTempFile("install", ".apk", ctx.cacheDir)
        try {
            val md = MessageDigest.getInstance("SHA-256")
            (URL(url).openConnection() as HttpURLConnection).apply { connectTimeout = 15_000; readTimeout = 60_000 }.inputStream.use { input ->
                tmp.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > 500L * 1024 * 1024) return "APK larger than 500 MB"
                        md.update(buf, 0, n)
                        out.write(buf, 0, n)
                    }
                }
            }
            if (Hex.encode(md.digest()) != sha256.lowercase()) return "SHA-256 mismatch — download refused"
            val installer = ctx.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply { setAppPackageName(packageName) }
            val sessionId = installer.createSession(params)
            installer.openSession(sessionId).use { session ->
                session.openWrite("base.apk", 0, tmp.length()).use { out -> tmp.inputStream().use { it.copyTo(out) }; session.fsync(out) }
                val pi = PendingIntent.getBroadcast(ctx, sessionId, Intent(ctx, InstallResultReceiver::class.java), PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                session.commit(pi.intentSender)
            }
            return ""
        } catch (e: Exception) {
            return e.message ?: "install failed"
        } finally {
            tmp.delete()
        }
    }
}

/** Silent removal of a catalogue app (device owner). Never the agent itself — that is RELEASE. */
object AppRemover {
    fun uninstall(ctx: Context, packageName: String): String {
        if (packageName == ctx.packageName) return "Use Delete device to remove Mob Hunter"
        return try {
            ctx.packageManager.getPackageInfo(packageName, 0)
            val pi = PendingIntent.getBroadcast(ctx, packageName.hashCode(), Intent(ctx, InstallResultReceiver::class.java), PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            ctx.packageManager.packageInstaller.uninstall(packageName, pi.intentSender)
            ""
        } catch (e: android.content.pm.PackageManager.NameNotFoundException) {
            "NOT_INSTALLED"
        } catch (e: Exception) {
            e.message ?: "uninstall failed"
        }
    }
}

/** Rings the phone at alarm volume for 30 s so a misplaced phone can be found. Always paired with a notification. */
object Ringer {
    private var current: android.media.Ringtone? = null

    fun ring(ctx: Context, seconds: Long = 30) {
        stop()
        val uri = android.media.RingtoneManager.getActualDefaultRingtoneUri(ctx, android.media.RingtoneManager.TYPE_ALARM)
            ?: android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE)
        val tone = android.media.RingtoneManager.getRingtone(ctx, uri) ?: return
        tone.audioAttributes = android.media.AudioAttributes.Builder()
            .setUsage(android.media.AudioAttributes.USAGE_ALARM)
            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        current = tone
        tone.play()
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ stop() }, seconds * 1000)
    }

    fun stop() {
        runCatching { current?.stop() }
        current = null
    }
}

class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        Log.i("MobHunterAgent", "install result $status ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
    }
}
