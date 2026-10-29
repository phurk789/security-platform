package com.store13.edge

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLDecoder
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** What pairing gave this remote (everything a site.json holds, except the key). */
data class Pairing(
    /** http(s)://host:port the app paired with. */
    val server: String,
    val gatewayId: String,
    val siteName: String,
    val geo: JSONObject,
    val devices: JSONArray,
    val pairedAt: Long,
) {
    /** The gateway's WebSocket address: same host as pairing. */
    val serverWs: String get() = ServerAddress.toWs(server)

    val deviceIds: List<String>
        get() = (0 until devices.length()).mapNotNull { devices.optJSONObject(it)?.optString("deviceId")?.takeIf(String::isNotEmpty) }

    /** site.json for the gateway. The key is not in it: it goes to the gateway in GATEWAY_KEY. */
    fun siteJson(): String = JSONObject().put("gatewayId", gatewayId).put("serverUrl", serverWs).put("geo", geo).put("devices", gatewayDevices()).toString(2)

    /**
     * The devices for the gateway, with UniGCS on this remote relayed through the app ("gcsRelay") on the first MAVLink
     * vehicle, unless the pairing already decides (true, false or host/port on any vehicle). Remotes paired before the
     * relay existed get it without a new code; it only listens on 127.0.0.1.
     */
    fun gatewayDevices(): JSONArray {
        val out = JSONArray(devices.toString())
        val list = (0 until out.length()).mapNotNull { out.optJSONObject(it) }
        if (list.none { it.has("gcsRelay") }) list.firstOrNull { it.optString("type") == "mavlink" }?.put("gcsRelay", true)
        return out
    }

    fun toJson(): JSONObject =
        JSONObject().put("server", server).put("gatewayId", gatewayId).put("siteName", siteName).put("geo", geo).put("devices", devices).put("pairedAt", pairedAt)

    companion object {
        fun fromJson(o: JSONObject) = Pairing(
            server = o.getString("server"),
            gatewayId = o.getString("gatewayId"),
            siteName = o.optString("siteName"),
            geo = o.getJSONObject("geo"),
            devices = o.getJSONArray("devices"),
            pairedAt = o.optLong("pairedAt"),
        )
    }
}

/** Server address and code from a scanned QR or typed text (same rules as parsePairingLink in packages/shared). */
object PairingLink {
    data class Parsed(val server: String?, val code: String)

    private val SIX = Regex("^\\d{6}$")

    fun parse(text: String): Parsed? {
        val t = text.trim()
        val digits = t.replace(Regex("[\\s-]"), "")
        if (SIX.matches(digits)) return Parsed(null, digits)
        val m = Regex("^psedge://pair\\?(.*)$", RegexOption.IGNORE_CASE).find(t) ?: return null
        val q = m.groupValues[1].split('&').mapNotNull { part ->
            val i = part.indexOf('=')
            if (i <= 0) null else part.substring(0, i) to URLDecoder.decode(part.substring(i + 1), "UTF-8")
        }.toMap()
        val code = (q["code"] ?: "").replace(Regex("[\\s-]"), "")
        val server = q["server"]
        if (!SIX.matches(code)) return null
        if (server != null && !Regex("^https?://[^\\s/]+$", RegexOption.IGNORE_CASE).matches(server)) return null
        return Parsed(server, code)
    }
}

object ServerAddress {
    /** "192.168.20.13:8090", "http://192.168.20.13:8090/" → "http://192.168.20.13:8090"; null if it is not an address. */
    fun normalize(input: String): String? {
        var s = input.trim().trimEnd('/')
        if (s.isEmpty()) return null
        if (!Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://").containsMatchIn(s)) s = "http://$s"
        return try {
            val u = URI(s)
            val scheme = u.scheme?.lowercase()
            if ((scheme != "http" && scheme != "https") || u.host.isNullOrEmpty() || !(u.path.isNullOrEmpty() || u.path == "/") || u.query != null) return null
            "$scheme://${u.host}${if (u.port > 0) ":${u.port}" else ""}"
        } catch (e: Exception) {
            null
        }
    }

    fun toWs(http: String) = http.replaceFirst(Regex("^http", RegexOption.IGNORE_CASE), "ws")
}

/** Keeps the pairing in the app's private, never-backed-up storage; the key encrypted with an Android Keystore key. */
object PairingStore {
    private const val FILE = "pairing.json"
    private const val KEY_FILE = "gateway-key.bin"
    private const val ALIAS = "edge-gateway-key"

    private fun dir(ctx: Context) = ctx.noBackupFilesDir

    fun load(ctx: Context): Pairing? = try {
        File(dir(ctx), FILE).takeIf { it.isFile }?.let { Pairing.fromJson(JSONObject(it.readText())) }
    } catch (e: Exception) {
        null
    }

    fun save(ctx: Context, p: Pairing, key: String) {
        File(dir(ctx), KEY_FILE).writeBytes(encrypt(key.toByteArray()))
        File(dir(ctx), FILE).writeText(p.toJson().toString())
    }

    /** The gateway key, decrypted; only handed to the gateway process. */
    fun key(ctx: Context): String? = try {
        File(dir(ctx), KEY_FILE).takeIf { it.isFile }?.let { String(decrypt(it.readBytes())) }
    } catch (e: Exception) {
        null
    }

    fun clear(ctx: Context) {
        File(dir(ctx), FILE).delete()
        File(dir(ctx), KEY_FILE).delete()
        try {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(ALIAS)
        } catch (e: Exception) {
            // nothing to delete
        }
    }

    private fun secretKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun encrypt(plain: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, secretKey())
        val iv = c.iv
        return byteArrayOf(iv.size.toByte()) + iv + c.doFinal(plain)
    }

    private fun decrypt(blob: ByteArray): ByteArray {
        val n = blob[0].toInt()
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, blob, 1, n))
        return c.doFinal(blob, 1 + n, blob.size - 1 - n)
    }
}

/** POST /api/v1/edge/pair. Call from a background thread. */
object PairingClient {
    sealed class Result {
        data class Ok(val pairing: Pairing, val key: String) : Result()
        /** [reason]: wrong_code, too_many, no_server, server_error. */
        data class Failed(val reason: String, val detail: String) : Result()
    }

    fun clientInfo(ctx: Context): String {
        val v = try {
            ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName
        } catch (e: Exception) {
            "?"
        }
        return "Edge app $v · ${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE}"
    }

    fun pair(server: String, code: String, client: String): Result {
        val conn = try {
            (URL("$server/api/v1/edge/pair").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 8_000
                readTimeout = 15_000
                doOutput = true
                setRequestProperty("content-type", "application/json")
                setRequestProperty("accept", "application/json")
            }
        } catch (e: Exception) {
            return Result.Failed("no_server", e.message ?: "")
        }
        try {
            conn.outputStream.use { it.write(JSONObject().put("code", code).put("client", client).toString().toByteArray()) }
            val status = conn.responseCode
            val body = (if (status in 200..299) conn.inputStream else conn.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            val json = try {
                JSONObject(body)
            } catch (e: Exception) {
                null
            }
            if (status == 200 && json != null) {
                val key = json.getString("key")
                val site = json.optJSONObject("site")
                return Result.Ok(
                    Pairing(
                        server = server,
                        gatewayId = json.getString("gatewayId"),
                        siteName = site?.optString("name") ?: "",
                        geo = json.getJSONObject("geo"),
                        devices = json.getJSONArray("devices"),
                        pairedAt = System.currentTimeMillis(),
                    ),
                    key,
                )
            }
            val detail = json?.optString("error") ?: "HTTP $status"
            return when {
                status == 429 -> Result.Failed("too_many", detail)
                json?.optString("code") == "invalid_code" -> Result.Failed("wrong_code", detail)
                else -> Result.Failed("server_error", detail)
            }
        } catch (e: IOException) {
            return Result.Failed("no_server", e.message ?: "")
        } catch (e: Exception) {
            return Result.Failed("server_error", e.message ?: "")
        } finally {
            conn.disconnect()
        }
    }
}
