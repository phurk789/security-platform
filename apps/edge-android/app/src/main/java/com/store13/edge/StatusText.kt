package com.store13.edge

import android.content.Context
import java.util.Locale

/** Plain sentences for the screen and the notification, from the gateway's status. */
object StatusText {
    enum class Tone { OK, WARN, BAD, IDLE }
    data class Line(val text: String, val tone: Tone)

    /** A status file older than this means the gateway stopped answering. */
    private const val STALE_MS = 5_000

    private fun fresh(s: GatewayStatus?) = s != null && System.currentTimeMillis() - s.at < STALE_MS

    fun server(ctx: Context, s: GatewayStatus?): Line = when {
        !fresh(s) -> Line(ctx.getString(R.string.server_unknown), Tone.IDLE)
        s!!.keyRefused -> Line(ctx.getString(R.string.server_refused), Tone.BAD)
        s.serverConnected -> Line(ctx.getString(R.string.server_connected, s.serverUrl), Tone.OK)
        else -> Line(ctx.getString(R.string.server_connecting, s.serverUrl), Tone.WARN)
    }

    fun devices(ctx: Context, s: GatewayStatus?): List<Line> {
        if (!fresh(s)) return emptyList()
        return s!!.devices.map { d ->
            val age = d.ageSeconds(s.at)
            when {
                d.rejected != null -> Line(ctx.getString(R.string.device_refused, d.id, d.rejected), Tone.BAD)
                age == null -> Line(ctx.getString(R.string.device_never, d.id), Tone.WARN)
                age <= GatewayStatus.ALIVE_S -> Line(ctx.getString(R.string.device_alive, d.id, String.format(Locale.US, "%.1f", age)), if (d.accepted) Tone.OK else Tone.WARN)
                else -> Line(ctx.getString(R.string.device_silent, d.id, Math.round(age).toString()), Tone.BAD)
            }
        }
    }

    fun video(ctx: Context, s: GatewayStatus?, pairing: Pairing?): List<Line> {
        if (!fresh(s)) return emptyList()
        val pushed = pairing?.let { p ->
            (0 until p.devices.length()).mapNotNull { p.devices.optJSONObject(it) }.filter { it.optJSONObject("stream")?.optBoolean("push") == true }.map { it.optString("deviceId") }
        } ?: emptyList()
        if (pushed.isEmpty()) return listOf(Line(ctx.getString(R.string.video_none), Tone.IDLE))
        return pushed.map { id ->
            val v = s!!.devices.find { it.id == id }?.video
            when (v?.status) {
                null -> Line(ctx.getString(R.string.video_waiting, id), Tone.IDLE)
                "pushing" -> Line(ctx.getString(R.string.video_pushing, id, v.codec ?: "video"), if (v.codec == "hevc") Tone.WARN else Tone.OK)
                "starting" -> Line(ctx.getString(R.string.video_starting, id), Tone.WARN)
                "missing" -> Line(ctx.getString(R.string.video_missing, id), Tone.BAD)
                "stopped" -> Line(ctx.getString(R.string.video_stopped, id), Tone.IDLE)
                else -> Line(ctx.getString(R.string.video_retrying, id, v.detail), Tone.BAD)
            }
        }
    }

    /** One line for the notification: "Server ✓ · UGV-01 ✓ · Video ✓". */
    fun summary(ctx: Context, s: GatewayStatus?): String {
        if (!fresh(s)) return ctx.getString(R.string.gateway_starting)
        val mark = { t: Tone -> if (t == Tone.OK) "✓" else "✗" }
        val parts = mutableListOf("${ctx.getString(R.string.section_server)} ${mark(server(ctx, s).tone)}")
        s!!.devices.zip(devices(ctx, s)).forEach { (d, l) -> parts += "${d.id} ${mark(l.tone)}" }
        s.devices.filter { it.video != null }.forEach { parts += "${ctx.getString(R.string.section_video)} ${mark(if (it.video!!.status == "pushing") Tone.OK else Tone.BAD)}" }
        return parts.joinToString(" · ")
    }
}
