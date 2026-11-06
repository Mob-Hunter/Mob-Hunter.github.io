package com.fleetguard.agent

import org.json.JSONObject

/**
 * Verifies a server command exactly as the build spec requires (Non-negotiable #5):
 * Ed25519 signature over the exact signed string, addressed to this device,
 * not expired (10-minute lifetime max), not from the future, never seen before.
 * Pure Kotlin so it is unit-tested on the JVM.
 */
class CommandVerifier(
    private val deviceId: String,
    private val serverPublicKeyHex: String,
    private val seen: SeenStore,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    interface SeenStore {
        fun contains(key: String): Boolean
        fun add(key: String)
    }

    sealed class Result {
        data class Ok(val payload: JSONObject) : Result()
        data class Rejected(val reason: String) : Result()
    }

    companion object {
        const val MAX_TTL_MS = 10 * 60 * 1000L
        const val CLOCK_SKEW_MS = 2 * 60 * 1000L
    }

    fun verify(envelope: JSONObject): Result {
        val signed = envelope.optString("signed", "")
        val sig = envelope.optString("sig", "")
        if (signed.isEmpty() || sig.isEmpty()) return Result.Rejected("malformed")
        if (!ServerCrypto.verifyEd25519(signed, sig, serverPublicKeyHex)) return Result.Rejected("bad_signature")
        val p = try { JSONObject(signed) } catch (_: Exception) { return Result.Rejected("malformed") }
        if (p.optInt("v") != 1) return Result.Rejected("malformed")
        val id = p.optString("id")
        val nonce = p.optString("nonce")
        if (id.isEmpty() || nonce.length < 8) return Result.Rejected("malformed")
        if (p.optString("deviceId") != deviceId) return Result.Rejected("wrong_device")
        val issuedAt = p.optLong("issuedAt")
        val expiresAt = p.optLong("expiresAt")
        if (expiresAt - issuedAt > MAX_TTL_MS || expiresAt <= issuedAt) return Result.Rejected("malformed")
        val t = now()
        if (t > expiresAt) return Result.Rejected("expired")
        if (issuedAt > t + CLOCK_SKEW_MS) return Result.Rejected("not_yet_valid")
        if (seen.contains("id:$id") || seen.contains("n:$nonce")) return Result.Rejected("replayed")
        seen.add("id:$id")
        seen.add("n:$nonce")
        return Result.Ok(p)
    }
}
