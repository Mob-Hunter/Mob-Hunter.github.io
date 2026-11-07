package com.fleetguard.agent

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Cross-language interop: the agent's REAL ApiClient + CommandVerifier against a
 * running FleetGuard Worker (workerd via `wrangler dev`). Skipped unless
 * FG_INTEROP_URL (e.g. http://127.0.0.1:8787) and FG_INTEROP_BOOTSTRAP are set;
 * CI sets them in the Android job.
 *
 * The device key is a software P-256 key producing the same DER SHA256withECDSA
 * signatures as the Android Keystore key.
 */
class InteropTest {
    private val base = System.getenv("FG_INTEROP_URL")?.trimEnd('/')
    private val bootstrap = System.getenv("FG_INTEROP_BOOTSTRAP")
    private val password = "correct horse battery staple"

    // ---- a minimal admin client (cookie session + CSRF header) ----
    private inner class Admin {
        var cookie: String? = null
        fun call(method: String, path: String, body: JSONObject? = null): Any {
            val c = URL("$base/api$path").openConnection() as HttpURLConnection
            c.requestMethod = method
            c.setRequestProperty("x-fleetguard-csrf", "1")
            cookie?.let { c.setRequestProperty("Cookie", it) }
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val status = c.responseCode
            c.getHeaderField("Set-Cookie")?.let { cookie = it.substringBefore(';') }
            val text = (if (status < 400) c.inputStream else c.errorStream).bufferedReader().readText()
            check(status < 400) { "$method $path -> $status $text" }
            return if (text.trimStart().startsWith("[")) JSONArray(text) else JSONObject(text)
        }

        fun signIn(email: String, secret: String) {
            val ch = (call("POST", "/admin/login", JSONObject().put("email", email).put("password", password)) as JSONObject).getString("challengeId")
            call("POST", "/admin/mfa", JSONObject().put("challengeId", ch).put("code", totp(secret)))
        }
    }

    private fun totp(b32: String): String {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        var bits = 0
        var value = 0
        val out = java.io.ByteArrayOutputStream()
        for (ch in b32.trimEnd('=')) {
            value = (value shl 5) or alphabet.indexOf(ch)
            bits += 5
            if (bits >= 8) { out.write((value ushr (bits - 8)) and 0xff); bits -= 8 }
        }
        val mac = Mac.getInstance("HmacSHA1").apply { init(SecretKeySpec(out.toByteArray(), "HmacSHA1")) }
            .doFinal(ByteBuffer.allocate(8).putLong(System.currentTimeMillis() / 30_000).array())
        val o = mac[mac.size - 1].toInt() and 15
        val bin = ((mac[o].toInt() and 0x7f) shl 24) or ((mac[o + 1].toInt() and 0xff) shl 16) or ((mac[o + 2].toInt() and 0xff) shl 8) or (mac[o + 3].toInt() and 0xff)
        return (bin % 1_000_000).toString().padStart(6, '0')
    }

    private class Creds(override var apiBase: String?) : DeviceCredentials {
        override var deviceId: String? = null
        override var certJson: String? = null
        override var certSig: String? = null
    }

    @Test fun agentInteroperatesWithRealServer() {
        assumeTrue("set FG_INTEROP_URL and FG_INTEROP_BOOTSTRAP to run", base != null && bootstrap != null)

        // --- admin: bootstrap (or reuse), invite a Location Operator, mint an enrolment
        val admin = Admin()
        val health = URL("$base/api/health").readText()
        val rootEmail = "root-${System.nanoTime()}@corp.test"
        assertTrue("server must be fresh for this test: $health", health.contains("\"needsBootstrap\":true"))
        val boot = admin.call("POST", "/bootstrap", JSONObject().put("token", bootstrap).put("name", "Root").put("email", rootEmail).put("password", password)) as JSONObject
        admin.signIn(rootEmail, boot.getString("totpSecret"))
        val op = admin.call("POST", "/admin/users", JSONObject().put("name", "Op").put("email", "op@corp.test").put("role", "LOCATION_OPERATOR").put("password", password)) as JSONObject
        val enrolment = admin.call("POST", "/admin/enrollments", JSONObject()) as JSONObject
        val extras = enrolment.getJSONObject("provisioning").getJSONObject("android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE")

        // --- device: exactly what Agent.enrollIfNeeded does, with the real ApiClient
        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val signer: (String) -> String = { m -> Hex.encode(Signature.getInstance("SHA256withECDSA").run { initSign(kp.private); update(m.toByteArray()); sign() }) }
        val creds = Creds(extras.getString("serverUrl"))
        val api = ApiClient(creds, signer)
        val res = api.enroll(
            JSONObject().put("token", extras.getString("token")).put("devicePublicKey", Hex.encode(kp.public.encoded)).put("keyAlg", "ES256").put("platform", "android")
                .put("hardware", JSONObject().put("serial", "JVM-1").put("model", "Interop Phone").put("os", "Android 16")),
        )
        assertEquals("server key must match the pin in the QR", extras.getString("serverPin"), ServerCrypto.pinOf(res.getString("serverPublicKey")))
        creds.deviceId = res.getString("deviceId")
        creds.certJson = res.getString("certJson")
        creds.certSig = res.getString("certSig")

        // check-in with telemetry + notice acknowledgement (raw-body hash, DER signature)
        val notice = res.getJSONObject("notice")
        val checkin = api.post("/v1/checkin", JSONObject()
            .put("telemetry", JSONObject().put("batteryLevel", 77).put("batteryHealth", "good").put("batteryTempC", 31.5).put("storageFreeGb", 40.2).put("storageTotalGb", 128.0).put("integrity", "NOT_EVALUATED").put("patchLevel", "2026-10-05"))
            .put("serial", "JVM-1").put("model", "Interop Phone").put("os", "Android 16")
            .put("policyAck", JSONObject().put("version", notice.getString("version")).put("at", System.currentTimeMillis())))
        assertEquals("active", checkin.getString("state"))
        assertEquals(res.getJSONObject("policy").getInt("version"), api.getJson("/v1/policy").getJSONObject("policy").getInt("version"))

        // --- operator issues LOCATE
        val opAdmin = Admin()
        opAdmin.signIn("op@corp.test", op.getString("totpSecret"))
        opAdmin.call("POST", "/admin/devices/${creds.deviceId}/commands", JSONObject().put("type", "LOCATE").put("ticket", "INC-4242").put("reason", "Cross-language interop test"))

        // --- device pulls, verifies with Tink (CommandVerifier), replies with a fix + notification proof
        val seen = object : CommandVerifier.SeenStore {
            val s = HashSet<String>()
            override fun contains(key: String) = key in s
            override fun add(key: String) { s.add(key) }
        }
        val verifier = CommandVerifier(creds.deviceId!!, res.getString("serverPublicKey"), seen)
        val pending = api.getArray("/v1/commands/pending")
        assertEquals(1, pending.length())
        val ok = verifier.verify(pending.getJSONObject(0))
        assertTrue("agent must accept the server's signed command: $ok", ok is CommandVerifier.Result.Ok)
        val cmd = (ok as CommandVerifier.Result.Ok).payload
        assertEquals("LOCATE", cmd.getString("type"))
        assertEquals("INC-4242", cmd.getString("ticket"))
        // a tampered copy and a replay are refused
        val tampered = JSONObject(pending.getJSONObject(0).toString()).put("signed", pending.getJSONObject(0).getString("signed").replace("LOCATE", "WIPE"))
        assertEquals(CommandVerifier.Result.Rejected("bad_signature"), verifier.verify(tampered))
        assertEquals(CommandVerifier.Result.Rejected("replayed"), verifier.verify(pending.getJSONObject(0)))

        val shown = System.currentTimeMillis()
        api.post("/v1/commands/${cmd.getString("id")}/result", JSONObject().put("status", "succeeded").put("detail", "interop").put("location", JSONObject()
            .put("lat", 6.9271).put("lng", 79.8612).put("accuracyM", 9.5).put("fixAt", shown).put("source", "fused").put("tier", 1)
            .put("notification", Locator.notificationProof(shown, Notifier.CH_LOCATION, "Requested for INC-4242"))))

        // --- operator sees the decrypted fix; root verifies the audit chain
        val locs = opAdmin.call("GET", "/admin/location-results?ticket=INC-4242&deviceId=${creds.deviceId}") as JSONArray
        assertEquals(6.9271, locs.getJSONObject(0).getJSONObject("fix").getDouble("lat"), 1e-9)
        assertTrue((admin.call("GET", "/admin/audit/verify") as JSONObject).getBoolean("ok"))

        // --- a forged request (wrong key) is rejected
        val rogue = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val forged = ApiClient(creds) { m -> Hex.encode(Signature.getInstance("SHA256withECDSA").run { initSign(rogue.private); update(m.toByteArray()); sign() }) }
        val err = runCatching { forged.getJson("/v1/policy") }.exceptionOrNull()
        assertTrue("forged signature must be rejected, got $err", err is ApiException && err.status == 401)

        // --- admin deletes the (active) device: the server sends a signed RELEASE for the agent to uninstall itself
        val del = admin.call("POST", "/admin/devices/${creds.deviceId}/delete", JSONObject().put("reason", "Employee left; phone kept as personal").put("confirm", "DELETE")) as JSONObject
        assertEquals("pending_removal", del.getString("status"))
        val release = api.getArray("/v1/commands/pending")
        assertEquals(1, release.length())
        val rel = verifier.verify(release.getJSONObject(0))
        assertTrue("agent must accept the signed RELEASE: $rel", rel is CommandVerifier.Result.Ok)
        val relCmd = (rel as CommandVerifier.Result.Ok).payload
        assertEquals("RELEASE", relCmd.getString("type"))
        assertTrue(relCmd.getJSONObject("params").has("orgName"))
        // what CommandExecutor does: report first, then Releaser lifts policy, drops device owner and uninstalls
        api.post("/v1/commands/${relCmd.getString("id")}/result", JSONObject().put("status", "succeeded").put("detail", "interop release"))
        val gone = runCatching { admin.call("GET", "/admin/devices/${creds.deviceId}") }.exceptionOrNull()
        assertTrue("record must be deleted after the phone confirms, got $gone", gone?.message?.contains("404") == true)
        val revoked = runCatching { api.getJson("/v1/policy") }.exceptionOrNull()
        assertTrue("old credentials must be refused, got $revoked", revoked is ApiException && revoked.status == 401)
    }
}
