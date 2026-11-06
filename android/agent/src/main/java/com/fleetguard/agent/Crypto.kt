package com.fleetguard.agent

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.google.crypto.tink.subtle.Ed25519Verify
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/** Hex / hashing helpers shared by the agent and its unit tests (pure JVM). */
object Hex {
    fun encode(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }
    fun decode(s: String): ByteArray {
        require(s.length % 2 == 0 && s.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) { "invalid hex" }
        return ByteArray(s.length / 2) { i -> s.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }
    fun sha256(data: ByteArray): String = encode(MessageDigest.getInstance("SHA-256").digest(data))
    fun sha256(data: String): String = sha256(data.toByteArray(Charsets.UTF_8))
}

/** Server-signature verification (Ed25519, via Google Tink) and the pinned-key check. */
object ServerCrypto {
    fun verifyEd25519(message: String, signatureHex: String, publicKeyHex: String): Boolean = try {
        Ed25519Verify(Hex.decode(publicKeyHex)).verify(Hex.decode(signatureHex), message.toByteArray(Charsets.UTF_8))
        true
    } catch (_: Exception) {
        false
    }

    /** SHA-256 of the raw public key bytes — what the provisioning QR pins. */
    fun pinOf(publicKeyHex: String): String = Hex.sha256(Hex.decode(publicKeyHex))
}

/**
 * Device identity: an ECDSA P-256 key generated inside the Android Keystore
 * (hardware-backed where available, StrongBox if present). The private key
 * never leaves the secure hardware; only its public half is sent at enrolment.
 */
object DeviceKey {
    private const val ALIAS = "fleetguard-device-identity"
    private val ks: KeyStore get() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun exists(): Boolean = ks.containsAlias(ALIAS)

    fun create(): String {
        if (exists()) ks.deleteEntry(ALIAS)
        fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setIsStrongBoxBacked(strongBox)
            .build()
        val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        try {
            gen.initialize(spec(true))
            gen.generateKeyPair()
        } catch (_: Exception) {
            gen.initialize(spec(false)) // no StrongBox on this device: TEE-backed key
            gen.generateKeyPair()
        }
        return publicKeySpkiHex()
    }

    fun publicKeySpkiHex(): String = Hex.encode(ks.getCertificate(ALIAS).publicKey.encoded)

    /** SHA256withECDSA → ASN.1 DER signature, hex (the server accepts DER). */
    fun sign(message: String): String {
        val key = ks.getKey(ALIAS, null) as PrivateKey
        return Hex.encode(Signature.getInstance("SHA256withECDSA").run {
            initSign(key)
            update(message.toByteArray(Charsets.UTF_8))
            sign()
        })
    }

    fun destroy() {
        if (exists()) ks.deleteEntry(ALIAS)
    }
}

/** Null instead of "" / "null" for absent keys. */
fun org.json.JSONObject.optStr(key: String): String? = if (has(key) && !isNull(key)) optString(key) else null
