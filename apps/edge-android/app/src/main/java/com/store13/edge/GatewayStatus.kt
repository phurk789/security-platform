package com.store13.edge

import org.json.JSONObject

/** The gateway's status file (GatewayStatus in apps/gateway/src/gateway.ts), written every second. */
data class GatewayStatus(
    val at: Long,
    val gatewayId: String,
    val serverUrl: String,
    val serverConnected: Boolean,
    val keyRefused: Boolean,
    val serverSince: Long,
    val devices: List<Device>,
) {
    data class Device(
        val id: String,
        val kind: String,
        val accepted: Boolean,
        val rejected: String?,
        val lastTelemetryAt: Long?,
        val video: Video?,
        /** UniGCS relayed through the gateway (gcsRelay), when the vehicle has one. */
        val relay: Relay? = null,
    ) {
        /** Seconds since the device last reported, by the gateway's clock; null if it never did. */
        fun ageSeconds(statusAt: Long): Double? = lastTelemetryAt?.let { (statusAt - it).coerceAtLeast(0) / 1000.0 }
    }

    /** status: starting | pushing | retrying | missing | stopped (apps/gateway/src/videoPush.ts). */
    data class Video(val status: String, val detail: String, val codec: String?)

    /** listen: host:port UniGCS connects to (apps/gateway/src/real/gcsRelay.ts). */
    data class Relay(val listen: String, val connected: Boolean)

    companion object {
        /** A device that reported within this many seconds counts as alive (the MAVLink adapter reports every second). */
        const val ALIVE_S = 3.0

        fun parse(text: String): GatewayStatus? = try {
            val o = JSONObject(text)
            val server = o.getJSONObject("server")
            val devices = o.optJSONArray("devices")
            GatewayStatus(
                at = o.getLong("at"),
                gatewayId = o.optString("gatewayId"),
                serverUrl = server.optString("url"),
                serverConnected = server.optBoolean("connected"),
                keyRefused = server.optBoolean("refused"),
                serverSince = server.optLong("since"),
                devices = (0 until (devices?.length() ?: 0)).map { i ->
                    val d = devices!!.getJSONObject(i)
                    val v = d.optJSONObject("video")
                    val r = d.optJSONObject("relay")
                    Device(
                        id = d.getString("deviceId"),
                        kind = d.optString("kind"),
                        accepted = d.optBoolean("accepted"),
                        rejected = if (d.has("rejected")) d.getString("rejected") else null,
                        lastTelemetryAt = if (d.has("lastTelemetryAt")) d.getLong("lastTelemetryAt") else null,
                        video = v?.let { Video(it.optString("status"), it.optString("detail"), if (it.has("codec")) it.getString("codec") else null) },
                        relay = r?.let { Relay(it.optString("listen"), it.optBoolean("connected")) },
                    )
                },
            )
        } catch (e: Exception) {
            null
        }
    }
}
