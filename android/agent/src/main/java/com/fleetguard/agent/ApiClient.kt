package com.fleetguard.agent

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom

class ApiException(val status: Int, val code: String, message: String) : IOException(message)

/**
 * The device side of the FleetGuard wire protocol.
 * Every authenticated call carries the CA-issued certificate and an ECDSA
 * signature (Keystore key) over METHOD \n PATH \n ts \n nonce \n sha256(raw body).
 * HTTPS only; the server's command-signing key is pinned separately.
 */
class ApiClient(private val config: Config) {
    private val rng = SecureRandom()

    private fun open(path: String, method: String): HttpURLConnection {
        val base = config.apiBase ?: throw IOException("Not provisioned")
        val url = URL(base.trimEnd('/') + path)
        if (url.protocol != "https" && url.host !in setOf("127.0.0.1", "localhost", "10.0.2.2")) throw IOException("Refusing non-HTTPS server")
        return (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 30_000
            useCaches = false
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "FleetGuardAgent/${BuildConfigShim.VERSION}")
        }
    }

    private fun read(c: HttpURLConnection): String {
        val status = c.responseCode
        val text = (if (status in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        if (status !in 200..299) {
            val j = try { JSONObject(text) } catch (_: Exception) { JSONObject() }
            throw ApiException(status, j.optString("error", "http_$status"), j.optString("message", "HTTP $status"))
        }
        return text
    }

    fun enroll(body: JSONObject): JSONObject {
        val c = open("/v1/enroll", "POST")
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json")
        c.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
        return JSONObject(read(c))
    }

    private fun signed(method: String, path: String, body: JSONObject?): String {
        val raw = body?.toString() ?: ""
        val ts = System.currentTimeMillis()
        val nonce = ByteArray(12).also { rng.nextBytes(it) }.let { Hex.encode(it) }
        val bodyHash = Hex.sha256(raw)
        val message = "${method}\n${path}\n${ts}\n${nonce}\n${bodyHash}"
        val c = open(path, method)
        c.setRequestProperty("X-FG-Device", config.deviceId)
        c.setRequestProperty("X-FG-Cert", Base64.encodeToString(config.certJson!!.toByteArray(Charsets.UTF_8), Base64.NO_WRAP))
        c.setRequestProperty("X-FG-Cert-Sig", config.certSig)
        c.setRequestProperty("X-FG-Ts", ts.toString())
        c.setRequestProperty("X-FG-Nonce", nonce)
        c.setRequestProperty("X-FG-Body-SHA256", bodyHash)
        c.setRequestProperty("X-FG-Sig", DeviceKey.sign(message))
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(raw.toByteArray(Charsets.UTF_8)) }
        }
        return read(c)
    }

    fun getJson(path: String): JSONObject = JSONObject(signed("GET", path, null))
    fun getArray(path: String): JSONArray = JSONArray(signed("GET", path, null))
    fun post(path: String, body: JSONObject): JSONObject = JSONObject(signed("POST", path, body))
}

/** Avoids depending on generated BuildConfig (buildFeatures.buildConfig is off). */
object BuildConfigShim {
    const val VERSION = "1.0.0"
}
