package com.fleetguard.agent

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/**
 * FCM is initialised from options the server hands out at enrolment, so the
 * same APK works for any organisation's Firebase project. Without it the agent
 * simply polls every 15 minutes.
 */
object PushSetup {
    fun init(ctx: Context) {
        val cfg = Config(ctx).pushConfigJson?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return
        if (FirebaseApp.getApps(ctx).isEmpty()) {
            runCatching {
                FirebaseApp.initializeApp(
                    ctx,
                    FirebaseOptions.Builder()
                        .setProjectId(cfg.getString("projectId"))
                        .setApplicationId(cfg.getString("applicationId"))
                        .setApiKey(cfg.getString("apiKey"))
                        .setGcmSenderId(cfg.optString("gcmSenderId"))
                        .build(),
                )
            }.onFailure { return }
        }
        runCatching {
            FirebaseMessaging.getInstance().isAutoInitEnabled = true
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                Thread { Agent(ctx).registerPushToken(token) }.start()
            }
        }
    }
}

/** A push only ever says "wake up": the agent then pulls over its signed channel. */
class PushService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data["type"] == "wake") Sync.now(applicationContext)
    }

    override fun onNewToken(token: String) {
        Thread { Agent(applicationContext).registerPushToken(token) }.start()
    }
}
