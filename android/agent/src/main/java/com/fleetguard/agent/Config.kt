package com.fleetguard.agent

import android.content.Context
import org.json.JSONObject

/**
 * Agent configuration, kept in app-private storage (excluded from backups).
 * Contains no secrets: the private key lives in the Android Keystore.
 */
class Config(context: Context) {
    private val p = context.applicationContext.getSharedPreferences("fleetguard", Context.MODE_PRIVATE)

    var apiBase: String? by pref("apiBase")
    var enrollToken: String? by pref("enrollToken")
    var serverPin: String? by pref("serverPin")
    var deviceId: String? by pref("deviceId")
    var certJson: String? by pref("certJson")
    var certSig: String? by pref("certSig")
    var serverPublicKey: String? by pref("serverPublicKey")
    var transparencyPath: String? by pref("transparencyPath")
    var noticeJson: String? by pref("noticeJson")
    var policyJson: String? by pref("policyJson")
    var pushConfigJson: String? by pref("pushConfigJson")
    var pushToken: String? by pref("pushToken")
    var lostMessage: String? by pref("lostMessage")
    var lastError: String? by pref("lastError")

    var acknowledgedAt: Long
        get() = p.getLong("acknowledgedAt", 0)
        set(v) = p.edit().putLong("acknowledgedAt", v).apply()
    var ackSent: Boolean
        get() = p.getBoolean("ackSent", false)
        set(v) = p.edit().putBoolean("ackSent", v).apply()
    var lostMode: Boolean
        get() = p.getBoolean("lostMode", false)
        set(v) = p.edit().putBoolean("lostMode", v).apply()
    var revoked: Boolean
        get() = p.getBoolean("revoked", false)
        set(v) = p.edit().putBoolean("revoked", v).apply()
    var lastLostFixAt: Long
        get() = p.getLong("lastLostFixAt", 0)
        set(v) = p.edit().putLong("lastLostFixAt", v).apply()
    var lastContinuousAt: Long
        get() = p.getLong("lastContinuousAt", 0)
        set(v) = p.edit().putLong("lastContinuousAt", v).apply()

    val enrolled: Boolean get() = deviceId != null && certJson != null && !revoked
    val policy: JSONObject? get() = policyJson?.let { runCatching { JSONObject(it) }.getOrNull() }
    val notice: JSONObject? get() = noticeJson?.let { runCatching { JSONObject(it) }.getOrNull() }

    /** https://server/#/transparency/... — the employee's self-service page. */
    val transparencyUrl: String?
        get() {
            val base = apiBase?.trimEnd('/')?.removeSuffix("/api") ?: return null
            return transparencyPath?.let { "$base/#$it" }
        }

    /** Replay protection store for CommandVerifier (bounded). */
    val seen = object : CommandVerifier.SeenStore {
        override fun contains(key: String) = p.getStringSet("seen", emptySet())!!.contains(key)
        override fun add(key: String) {
            val cur = LinkedHashSet(p.getStringSet("seen", emptySet())!!)
            cur.add(key)
            val trimmed = if (cur.size > 1000) cur.toList().takeLast(1000).toSet() else cur
            p.edit().putStringSet("seen", trimmed).apply()
        }
    }

    fun saveProvisioning(serverUrl: String?, token: String?, pin: String?) {
        if (!serverUrl.isNullOrBlank()) apiBase = serverUrl
        if (!token.isNullOrBlank() && deviceId == null) enrollToken = token
        if (!pin.isNullOrBlank()) serverPin = pin
    }

    fun clearAll() = p.edit().clear().apply()

    private fun pref(key: String) = object : kotlin.properties.ReadWriteProperty<Any?, String?> {
        override fun getValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>): String? = p.getString(key, null)
        override fun setValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>, value: String?) {
            p.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
        }
    }
}
