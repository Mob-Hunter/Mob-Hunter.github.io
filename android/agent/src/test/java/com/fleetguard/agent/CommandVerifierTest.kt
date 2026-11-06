package com.fleetguard.agent

import com.google.crypto.tink.subtle.Ed25519Sign
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandVerifierTest {
    private val kp = Ed25519Sign.KeyPair.newKeyPair()
    private val pub = Hex.encode(kp.publicKey)
    private val now = 1_800_000_000_000L

    private class MemSeen : CommandVerifier.SeenStore {
        val set = HashSet<String>()
        override fun contains(key: String) = key in set
        override fun add(key: String) { set.add(key) }
    }

    /** Same canonical form the server signs (sorted keys, no whitespace). */
    private fun signed(id: String = "cmd_1", device: String = "dev_1", issuedAt: Long = now, expiresAt: Long = now + 600_000, nonce: String = "nonce-$id"): JSONObject {
        val s = "{\"deviceId\":\"$device\",\"expiresAt\":$expiresAt,\"id\":\"$id\",\"issuedAt\":$issuedAt,\"nonce\":\"$nonce\",\"params\":{},\"ticket\":\"INC-1\",\"type\":\"LOCATE\",\"v\":1}"
        val sig = Hex.encode(Ed25519Sign(kp.privateKey).sign(s.toByteArray()))
        return JSONObject().put("signed", s).put("sig", sig).put("kid", "k")
    }

    private fun verifier(seen: MemSeen = MemSeen(), at: Long = now + 1000) = CommandVerifier("dev_1", pub, seen) { at }

    @Test fun acceptsValidCommandOnce() {
        val seen = MemSeen()
        val v = verifier(seen)
        val env = signed()
        val r = v.verify(env)
        assertTrue(r is CommandVerifier.Result.Ok)
        assertEquals("LOCATE", (r as CommandVerifier.Result.Ok).payload.getString("type"))
        assertEquals(CommandVerifier.Result.Rejected("replayed"), v.verify(env))
    }

    @Test fun rejectsTamperedPayload() {
        val env = signed()
        env.put("signed", env.getString("signed").replace("LOCATE", "WIPE"))
        assertEquals(CommandVerifier.Result.Rejected("bad_signature"), verifier().verify(env))
    }

    @Test fun rejectsOtherKey() {
        val other = Ed25519Sign.KeyPair.newKeyPair()
        val v = CommandVerifier("dev_1", Hex.encode(other.publicKey), MemSeen()) { now }
        assertEquals(CommandVerifier.Result.Rejected("bad_signature"), v.verify(signed()))
    }

    @Test fun rejectsExpiredFutureWrongDeviceAndLongLived() {
        assertEquals(CommandVerifier.Result.Rejected("expired"), verifier(at = now + 600_001).verify(signed()))
        assertEquals(CommandVerifier.Result.Rejected("not_yet_valid"), verifier(at = now - 10 * 60_000).verify(signed()))
        assertEquals(CommandVerifier.Result.Rejected("wrong_device"), verifier().verify(signed(device = "dev_2")))
        assertEquals(CommandVerifier.Result.Rejected("malformed"), verifier().verify(signed(expiresAt = now + 3_600_000)))
        assertEquals(CommandVerifier.Result.Rejected("malformed"), verifier().verify(JSONObject()))
    }

    @Test fun pinIsSha256OfRawKey() {
        assertEquals(64, ServerCrypto.pinOf(pub).length)
        assertFalse(ServerCrypto.verifyEd25519("x", "zz", pub))
    }

    @Test fun workingHoursUsePolicyTimeZone() {
        val p = JSONObject().put("workingHours", JSONObject().put("startHour", 8).put("endHour", 18).put("timeZone", "Asia/Colombo").put("days", org.json.JSONArray(listOf(1, 2, 3, 4, 5))))
        // Monday 2026-11-09 04:00 UTC = 09:30 in Colombo
        assertTrue(withinWorkingHours(p, 1794196800000L))
        // Saturday 2026-11-14 04:00 UTC
        assertFalse(withinWorkingHours(p, 1794628800000L))
        // Monday 2026-11-09 14:00 UTC = 19:30 in Colombo
        assertFalse(withinWorkingHours(p, 1794232800000L))
    }
}
