package com.store13.edge

import android.content.Context
import android.content.res.Configuration
import android.os.Handler
import android.os.Looper
import java.io.File
import java.util.Locale

/** Live state shared by the service and the screen (same process). Listeners run on the main thread. */
object EdgeState {
    enum class Phase { STOPPED, STARTING, RUNNING, RESTARTING, STOPPING }

    @Volatile var phase = Phase.STOPPED
        private set
    @Volatile var status: GatewayStatus? = null
        private set
    /** Why the gateway last stopped on its own, for the screen. */
    @Volatile var lastProblem: String? = null
        private set
    /** When the gateway last reached RUNNING (elapsedRealtime ms), for "online for"; null when not running. */
    @Volatile var runningSince: Long? = null
        private set

    private val main = Handler(Looper.getMainLooper())
    private val listeners = mutableSetOf<() -> Unit>()

    fun listen(l: () -> Unit) = listeners.add(l)
    fun unlisten(l: () -> Unit) = listeners.remove(l)

    private fun changed() = main.post { listeners.toList().forEach { it() } }

    fun setPhase(p: Phase, problem: String? = lastProblem) {
        if (p == Phase.RUNNING && phase != Phase.RUNNING) runningSince = android.os.SystemClock.elapsedRealtime()
        if (p != Phase.RUNNING) runningSince = null
        phase = p
        lastProblem = problem
        if (p == Phase.STOPPED) status = null
        changed()
    }

    fun setStatus(s: GatewayStatus?) {
        status = s
        changed()
    }

    fun logChanged() = changed()
}

/** Last lines the gateway printed, kept in memory for the screen and in files/logs/gateway.log (rotated at 1 MB). */
object GatewayLog {
    private const val KEEP = 400
    private const val MAX_FILE = 1_000_000L
    private val lines = ArrayDeque<String>()
    private var file: File? = null

    fun init(ctx: Context) {
        if (file == null) file = File(ctx.filesDir, "logs/gateway.log").also { it.parentFile?.mkdirs() }
    }

    @Synchronized
    fun add(line: String) {
        lines.addLast(line)
        while (lines.size > KEEP) lines.removeFirst()
        file?.let { f ->
            try {
                if (f.length() > MAX_FILE) f.renameTo(File(f.parentFile, "gateway.1.log"))
                f.appendText(line + "\n")
            } catch (e: Exception) {
                // the screen still has the line
            }
        }
        EdgeState.logChanged()
    }

    @Synchronized
    fun last(n: Int): List<String> = lines.toList().takeLast(n)
}

object Prefs {
    const val DEFAULT_SERVER = "http://192.168.20.13:8090"
    private fun p(ctx: Context) = ctx.getSharedPreferences("edge", Context.MODE_PRIVATE)

    /** Start the gateway when the remote boots. Off by default: the gateway and UniGCS must not share the datalink. */
    fun startOnBoot(ctx: Context) = p(ctx).getBoolean("startOnBoot", false)
    fun setStartOnBoot(ctx: Context, v: Boolean) = p(ctx).edit().putBoolean("startOnBoot", v).apply()

    /** The person pressed Start and not yet Stop: the service brings the gateway back after a crash or restart. */
    fun wantRunning(ctx: Context) = p(ctx).getBoolean("wantRunning", false)
    fun setWantRunning(ctx: Context, v: Boolean) = p(ctx).edit().putBoolean("wantRunning", v).apply()

    /** The gateway was running when an update started: start it again once the new version is installed (or the update fails). */
    fun resumeAfterUpdate(ctx: Context) = p(ctx).getBoolean("resumeAfterUpdate", false)
    fun setResumeAfterUpdate(ctx: Context, v: Boolean) = p(ctx).edit().putBoolean("resumeAfterUpdate", v).commit()

    fun lastServer(ctx: Context): String = p(ctx).getString("lastServer", DEFAULT_SERVER) ?: DEFAULT_SERVER
    fun setLastServer(ctx: Context, v: String) = p(ctx).edit().putString("lastServer", v).apply()

    /** "th" or "en". Thai unless the person switches. */
    fun lang(ctx: Context): String = p(ctx).getString("lang", "th") ?: "th"
    fun setLang(ctx: Context, v: String) = p(ctx).edit().putString("lang", v).apply()
}

object Lang {
    fun wrap(base: Context): Context {
        val cfg = Configuration(base.resources.configuration)
        cfg.setLocale(Locale.forLanguageTag(Prefs.lang(base)))
        return base.createConfigurationContext(cfg)
    }
}
