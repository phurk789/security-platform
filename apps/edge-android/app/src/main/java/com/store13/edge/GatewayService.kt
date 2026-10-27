package com.store13.edge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import java.io.File
import kotlin.concurrent.thread

/**
 * Runs the edge gateway (apps/gateway, Node 18 from nodejs-mobile) as a child process, like Termux did:
 *   libnode_launcher.so edge-gateway.mjs, with ffmpeg (libffmpeg.so) for the video push.
 * A foreground service with a wake lock and a Wi-Fi lock, so it keeps going with the screen off.
 * If the gateway exits on its own it is started again (2 s, doubling to 30 s).
 */
class GatewayService : Service() {
    companion object {
        const val ACTION_START = "com.store13.edge.START"
        const val ACTION_STOP = "com.store13.edge.STOP"
        private const val CHANNEL = "gateway"
        private const val NOTIFICATION_ID = 1

        fun start(ctx: Context) {
            Prefs.setWantRunning(ctx, true)
            ctx.startForegroundService(Intent(ctx, GatewayService::class.java).setAction(ACTION_START))
        }

        fun stop(ctx: Context) {
            Prefs.setWantRunning(ctx, false)
            ctx.startService(Intent(ctx, GatewayService::class.java).setAction(ACTION_STOP))
        }
    }

    private val main = Handler(Looper.getMainLooper())
    @Volatile private var proc: Process? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var restartDelayMs = 2_000L
    private var startedAt = 0L
    private var lastSummary = ""
    private val gwDir by lazy { File(filesDir, "gateway") }
    private val statusFile by lazy { File(gwDir, "status.json") }

    private val poll = object : Runnable {
        override fun run() {
            readStatus()
            main.postDelayed(this, 1_000)
        }
    }

    override fun attachBaseContext(newBase: Context) = super.attachBaseContext(Lang.wrap(newBase))

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        GatewayLog.init(this)
        if (intent?.action == ACTION_STOP) {
            stopGateway()
            return START_NOT_STICKY
        }
        // ACTION_START, or Android restarting a service it had to kill (null intent).
        goForeground()
        if (!Prefs.wantRunning(this)) {
            finish()
            return START_NOT_STICKY
        }
        startGateway()
        return START_STICKY
    }

    private fun goForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW))
        val n = notification(getString(R.string.gateway_starting))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        else startForeground(NOTIFICATION_ID, n)
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, GatewayService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val gw = PairingStore.load(this)?.gatewayId ?: ""
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.notif_running, gw))
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, getString(R.string.stop), stop).build())
            .build()
    }

    private fun acquireLocks() {
        if (wakeLock == null) {
            wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "edge:gateway").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
        if (wifiLock == null) {
            // HIGH_PERF keeps Wi-Fi out of power save with the screen off (LOW_LATENCY needs the screen on).
            @Suppress("DEPRECATION")
            wifiLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "edge:gateway").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
    }

    private fun releaseLocks() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        wifiLock?.let { if (it.isHeld) it.release() }
        wifiLock = null
    }

    private fun startGateway() {
        if (proc != null) return
        val pairing = PairingStore.load(this)
        val key = PairingStore.key(this)
        if (pairing == null || key == null) {
            GatewayLog.add("[app] ${getString(R.string.no_key)}")
            Prefs.setWantRunning(this, false)
            EdgeState.setPhase(EdgeState.Phase.STOPPED, getString(R.string.no_key))
            finish()
            return
        }
        acquireLocks()
        EdgeState.setPhase(EdgeState.Phase.STARTING, null)
        val libs = applicationInfo.nativeLibraryDir
        reapLeftovers()
        try {
            gwDir.mkdirs()
            val bundle = File(gwDir, "edge-gateway.mjs")
            assets.open("gateway/edge-gateway.mjs").use { input -> bundle.outputStream().use { input.copyTo(it) } }
            val site = File(gwDir, "site.json").apply { writeText(pairing.siteJson()) }
            statusFile.delete()
            val pb = ProcessBuilder("$libs/libnode_launcher.so", bundle.absolutePath).directory(gwDir).redirectErrorStream(true)
            pb.environment().apply {
                put("LD_LIBRARY_PATH", libs)
                put("HOME", filesDir.absolutePath)
                put("TMPDIR", cacheDir.absolutePath)
                put("GATEWAY_CONFIG", site.absolutePath)
                put("GATEWAY_KEY", key)
                put("GATEWAY_DATA_DIR", File(gwDir, "data").absolutePath)
                put("FFMPEG_PATH", "$libs/libffmpeg.so")
                put("GATEWAY_STATUS_FILE", statusFile.absolutePath)
                put("GATEWAY_EXIT_WITH_PARENT", "1")
            }
            val p = pb.start()
            proc = p
            startedAt = System.currentTimeMillis()
            GatewayLog.add("[app] ${getString(R.string.gateway_starting)} ${pairing.gatewayId} → ${pairing.serverWs}")
            thread(name = "gateway-log", isDaemon = true) {
                try {
                    p.inputStream.bufferedReader().forEachLine { GatewayLog.add(it) }
                } catch (e: Exception) {
                    // stream closed when the process ends
                }
            }
            thread(name = "gateway-wait", isDaemon = true) {
                val code = p.waitFor()
                main.post { onExit(p, code) }
            }
            EdgeState.setPhase(EdgeState.Phase.RUNNING, null)
            main.removeCallbacks(poll)
            main.post(poll)
        } catch (e: Exception) {
            GatewayLog.add("[app] cannot start the gateway: ${e.message}")
            proc = null
            scheduleRestart(getString(R.string.gateway_failed, e.message ?: ""))
        }
    }

    private fun onExit(p: Process, code: Int) {
        if (proc !== p) return
        proc = null
        if (!Prefs.wantRunning(this)) return finish()
        if (System.currentTimeMillis() - startedAt > 60_000) restartDelayMs = 2_000
        scheduleRestart(getString(R.string.gateway_crashed, code, restartDelayMs / 1000))
    }

    private fun scheduleRestart(why: String) {
        GatewayLog.add("[app] $why")
        EdgeState.setPhase(EdgeState.Phase.RESTARTING, why)
        updateNotification(why)
        main.postDelayed({ if (Prefs.wantRunning(this) && proc == null) startGateway() }, restartDelayMs)
        restartDelayMs = (restartDelayMs * 2).coerceAtMost(30_000)
    }

    private fun stopGateway() {
        main.removeCallbacksAndMessages(null)
        val p = proc
        if (p == null) return finish()
        EdgeState.setPhase(EdgeState.Phase.STOPPING)
        GatewayLog.add("[app] ${getString(R.string.gateway_stopping)}")
        p.destroy() // SIGTERM: the gateway stops ffmpeg and closes the server link itself
        thread(name = "gateway-stop", isDaemon = true) {
            val deadline = System.currentTimeMillis() + 5_000
            while (p.isAlive && System.currentTimeMillis() < deadline) Thread.sleep(100)
            if (p.isAlive) p.destroyForcibly()
            main.post {
                proc = null
                reapLeftovers()
                finish()
            }
        }
    }

    /**
     * A gateway that died abruptly can leave its ffmpeg running (still pushing video, or a second gateway on the
     * datalink after a restart). Call only while no gateway of ours should run: kills this app's leftovers.
     * Android shows a process only the processes of its own app, so nothing else is touched.
     */
    private fun reapLeftovers() {
        val libs = applicationInfo.nativeLibraryDir
        val ours = listOf("$libs/libffmpeg.so", "$libs/libnode_launcher.so")
        File("/proc").listFiles()?.forEach { d ->
            val pid = d.name.toIntOrNull() ?: return@forEach
            if (pid == android.os.Process.myPid()) return@forEach
            val cmd = try {
                File(d, "cmdline").readText().substringBefore('\u0000')
            } catch (e: Exception) {
                return@forEach
            }
            if (cmd in ours) {
                GatewayLog.add("[app] stopping a leftover ${cmd.substringAfterLast('/')} (pid $pid)")
                android.os.Process.killProcess(pid)
            }
        }
    }

    /** Stop being a foreground service and let Android end it. */
    private fun finish() {
        main.removeCallbacks(poll)
        releaseLocks()
        EdgeState.setPhase(EdgeState.Phase.STOPPED)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun readStatus() {
        val s = try {
            statusFile.takeIf { it.isFile }?.readText()?.let(GatewayStatus::parse)
        } catch (e: Exception) {
            null
        }
        EdgeState.setStatus(s)
        updateNotification(StatusText.summary(this, s))
    }

    private fun updateNotification(text: String) {
        if (text == lastSummary) return
        lastSummary = text
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        proc?.destroy()
        releaseLocks()
        super.onDestroy()
    }
}
