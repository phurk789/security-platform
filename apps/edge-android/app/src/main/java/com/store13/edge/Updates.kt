package com.store13.edge

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlin.concurrent.thread

/** A build the paired server offers (GET /api/v1/edge/app/latest). */
data class AppRelease(val versionCode: Long, val versionName: String, val sha256: String, val size: Long) {
    companion object {
        fun parse(text: String): AppRelease? = try {
            val o = JSONObject(text)
            AppRelease(o.getLong("versionCode"), o.getString("versionName"), o.getString("sha256").lowercase(), o.getLong("size"))
                .takeIf { it.versionCode > 0 && it.size > 0 && Regex("^[0-9a-f]{64}$").matches(it.sha256) }
        } catch (e: Exception) {
            null
        }
    }
}

/** Decisions of the update flow, free of Android so they can be unit-tested. */
object UpdateLogic {
    fun isNewer(installedVersionCode: Long, r: AppRelease) = r.versionCode > installedVersionCode

    fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

    /**
     * Same signing key? True when the APK shares a certificate with the installed app, false when it clearly does not,
     * null when the APK's certificates could not be read (Android's installer then decides).
     */
    fun sameSigner(installed: List<ByteArray>, apk: List<ByteArray>): Boolean? {
        if (apk.isEmpty() || installed.isEmpty()) return null
        val md = { b: ByteArray -> hex(MessageDigest.getInstance("SHA-256").digest(b)) }
        return installed.map(md).toSet().intersect(apk.map(md).toSet()).isNotEmpty()
    }

    /** What Android's installer answered, in words the screen can explain. */
    enum class Outcome { DONE, NEEDS_CONFIRM, CANCELLED, WRONG_SIGNER, NO_SPACE, BLOCKED, BAD_FILE, OTHER }

    fun outcome(status: Int): Outcome = when (status) {
        PackageInstaller.STATUS_SUCCESS -> Outcome.DONE
        PackageInstaller.STATUS_PENDING_USER_ACTION -> Outcome.NEEDS_CONFIRM
        PackageInstaller.STATUS_FAILURE_ABORTED -> Outcome.CANCELLED
        // A different signing key shows up as a conflict with the installed package (INSTALL_FAILED_UPDATE_INCOMPATIBLE).
        PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> Outcome.WRONG_SIGNER
        PackageInstaller.STATUS_FAILURE_STORAGE -> Outcome.NO_SPACE
        PackageInstaller.STATUS_FAILURE_BLOCKED -> Outcome.BLOCKED
        PackageInstaller.STATUS_FAILURE_INVALID -> Outcome.BAD_FILE
        else -> Outcome.OTHER
    }
}

/** Where the update flow is, for the screen (same process as the service). */
object UpdateState {
    enum class Step { IDLE, CHECKING, LATEST, NONE, AVAILABLE, STOPPING, DOWNLOADING, INSTALLING, FAILED }

    /** Why the last check or update failed. */
    enum class Problem { NOT_PAIRED, NO_SERVER, KEY_REFUSED, BAD_FILE, WRONG_PACKAGE, NOT_NEWER, WRONG_SIGNER, NEED_PERMISSION, CANCELLED, NO_SPACE, INSTALL_FAILED }

    @Volatile var step = Step.IDLE
        private set
    @Volatile var release: AppRelease? = null
        private set
    @Volatile var progress = 0
        private set
    @Volatile var problem: Problem? = null
        private set
    @Volatile var detail = ""
        private set
    @Volatile var lastCheckAt = 0L

    fun set(step: Step, release: AppRelease? = this.release, problem: Problem? = null, detail: String = "", progress: Int = this.progress) {
        this.step = step
        this.release = release
        this.problem = problem
        this.detail = detail
        this.progress = progress
        EdgeState.logChanged()
    }

    val busy get() = step == Step.CHECKING || step == Step.STOPPING || step == Step.DOWNLOADING || step == Step.INSTALLING
}

/** Check, download, verify and install updates from the paired server. Network work runs on background threads. */
object Updater {
    private const val CHECK_EVERY_MS = 10 * 60_000L
    const val ACTION_INSTALL_STATUS = "com.store13.edge.INSTALL_STATUS"

    fun installedVersionCode(ctx: Context): Long {
        val pi = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        return if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode else @Suppress("DEPRECATION") pi.versionCode.toLong()
    }

    private fun open(ctx: Context, path: String): HttpURLConnection? {
        val p = PairingStore.load(ctx) ?: return null
        val key = PairingStore.key(ctx) ?: return null
        return (URL("${p.server}$path").openConnection() as HttpURLConnection).apply {
            connectTimeout = 8_000
            readTimeout = 30_000
            setRequestProperty("Authorization", "Bearer $key")
            setRequestProperty("X-Edge-App", PairingClient.clientInfo(ctx))
        }
    }

    /** Ask the server for the latest build. `force`: the person pressed the button; otherwise at most every 10 minutes. */
    fun check(ctx: Context, force: Boolean) {
        val app = ctx.applicationContext
        if (UpdateState.busy) return
        if (!force && System.currentTimeMillis() - UpdateState.lastCheckAt < CHECK_EVERY_MS) return
        if (PairingStore.load(app) == null) return UpdateState.set(UpdateState.Step.FAILED, problem = UpdateState.Problem.NOT_PAIRED)
        UpdateState.lastCheckAt = System.currentTimeMillis()
        UpdateState.set(UpdateState.Step.CHECKING)
        thread(name = "update-check", isDaemon = true) {
            val conn = open(app, "/api/v1/edge/app/latest")
            try {
                val status = conn!!.responseCode
                val body = (if (status in 200..299) conn.inputStream else conn.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
                when {
                    status == 404 -> UpdateState.set(UpdateState.Step.NONE, release = null)
                    status == 401 || status == 403 -> UpdateState.set(UpdateState.Step.FAILED, problem = UpdateState.Problem.KEY_REFUSED)
                    status != 200 -> UpdateState.set(UpdateState.Step.FAILED, problem = UpdateState.Problem.NO_SERVER, detail = "HTTP $status")
                    else -> {
                        val r = AppRelease.parse(body)
                        when {
                            r == null -> UpdateState.set(UpdateState.Step.FAILED, problem = UpdateState.Problem.NO_SERVER, detail = "bad answer")
                            UpdateLogic.isNewer(installedVersionCode(app), r) -> UpdateState.set(UpdateState.Step.AVAILABLE, release = r)
                            else -> UpdateState.set(UpdateState.Step.LATEST, release = r)
                        }
                    }
                }
            } catch (e: Exception) {
                UpdateState.set(UpdateState.Step.FAILED, problem = UpdateState.Problem.NO_SERVER, detail = e.message ?: "")
            } finally {
                conn?.disconnect()
            }
        }
    }

    /** Android allows this app to install packages ("Install unknown apps" for 13STORE Edge). */
    fun canInstall(ctx: Context) = ctx.packageManager.canRequestPackageInstalls()

    /**
     * Stop the gateway (it is started again after the update if it was running), download, verify, install.
     * Call after [canInstall] is true. The person confirms on Android's own install screen.
     */
    fun update(ctx: Context) {
        val app = ctx.applicationContext
        val r = UpdateState.release ?: return
        if (UpdateState.busy) return
        val wasRunning = EdgeState.phase != EdgeState.Phase.STOPPED
        Prefs.setResumeAfterUpdate(app, wasRunning)
        if (wasRunning) {
            UpdateState.set(UpdateState.Step.STOPPING, progress = 0)
            GatewayService.stop(app)
        }
        thread(name = "update", isDaemon = true) {
            val deadline = System.currentTimeMillis() + 15_000
            while (EdgeState.phase != EdgeState.Phase.STOPPED && System.currentTimeMillis() < deadline) Thread.sleep(200)
            GatewayLog.add("[app] downloading update ${r.versionName} (${r.versionCode})")
            UpdateState.set(UpdateState.Step.DOWNLOADING, progress = 0)
            val file = try {
                download(app, r)
            } catch (e: UpdateFailure) {
                return@thread fail(app, e.problem, e.message ?: "")
            } catch (e: IOException) {
                return@thread fail(app, UpdateState.Problem.NO_SERVER, e.message ?: "")
            }
            verify(app, file, r)?.let { return@thread fail(app, it, "") }
            try {
                install(app, file)
                UpdateState.set(UpdateState.Step.INSTALLING)
            } catch (e: Exception) {
                fail(app, UpdateState.Problem.INSTALL_FAILED, e.message ?: "")
            }
        }
    }

    private class UpdateFailure(val problem: UpdateState.Problem, msg: String) : Exception(msg)

    private fun download(ctx: Context, r: AppRelease): File {
        val dir = File(ctx.cacheDir, "updates").apply { deleteRecursively(); mkdirs() }
        val out = File(dir, "13store-edge-${r.versionCode}.apk")
        val conn = open(ctx, "/api/v1/edge/app/download") ?: throw UpdateFailure(UpdateState.Problem.NOT_PAIRED, "")
        try {
            when (conn.responseCode) {
                200 -> {}
                401, 403 -> throw UpdateFailure(UpdateState.Problem.KEY_REFUSED, "")
                404 -> throw UpdateFailure(UpdateState.Problem.NOT_NEWER, "withdrawn")
                else -> throw UpdateFailure(UpdateState.Problem.NO_SERVER, "HTTP ${conn.responseCode}")
            }
            val md = MessageDigest.getInstance("SHA-256")
            var done = 0L
            var shown = -1
            conn.inputStream.use { input ->
                out.outputStream().use { o ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        o.write(buf, 0, n)
                        md.update(buf, 0, n)
                        done += n
                        val pct = (done * 100 / r.size).toInt().coerceIn(0, 100)
                        if (pct != shown) {
                            shown = pct
                            UpdateState.set(UpdateState.Step.DOWNLOADING, progress = pct)
                        }
                    }
                }
            }
            if (done != r.size || UpdateLogic.hex(md.digest()) != r.sha256) {
                out.delete()
                throw UpdateFailure(UpdateState.Problem.BAD_FILE, "")
            }
            return out
        } finally {
            conn.disconnect()
        }
    }

    @Suppress("DEPRECATION")
    private fun signers(pi: PackageInfo?): List<ByteArray> {
        if (pi == null) return emptyList()
        if (Build.VERSION.SDK_INT >= 28) pi.signingInfo?.let { si ->
            val s = if (si.hasMultipleSigners()) si.apkContentsSigners else si.signingCertificateHistory
            if (!s.isNullOrEmpty()) return s.map { it.toByteArray() }
        }
        return pi.signatures?.map { it.toByteArray() } ?: emptyList()
    }

    /** The same app, newer, and signed with the same key; otherwise why not. */
    private fun verify(ctx: Context, file: File, r: AppRelease): UpdateState.Problem? {
        val pm = ctx.packageManager
        @Suppress("DEPRECATION")
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val apk = pm.getPackageArchiveInfo(file.absolutePath, flags) ?: return UpdateState.Problem.BAD_FILE
        if (apk.packageName != ctx.packageName) return UpdateState.Problem.WRONG_PACKAGE
        val apkCode = if (Build.VERSION.SDK_INT >= 28) apk.longVersionCode else @Suppress("DEPRECATION") apk.versionCode.toLong()
        if (apkCode != r.versionCode || apkCode <= installedVersionCode(ctx)) return UpdateState.Problem.NOT_NEWER
        if (UpdateLogic.sameSigner(signers(pm.getPackageInfo(ctx.packageName, flags)), signers(apk)) == false) return UpdateState.Problem.WRONG_SIGNER
        return null
    }

    private fun install(ctx: Context, file: File) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply { setAppPackageName(ctx.packageName) }
        val id = installer.createSession(params)
        installer.openSession(id).use { s ->
            file.inputStream().use { input -> s.openWrite("13store-edge.apk", 0, file.length()).use { out -> input.copyTo(out); s.fsync(out) } }
            val intent = Intent(ctx, InstallReceiver::class.java).setAction(ACTION_INSTALL_STATUS)
            // Mutable: the installer adds the status (and the confirm screen) to this intent.
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            s.commit(PendingIntent.getBroadcast(ctx, id, intent, flags).intentSender)
        }
        GatewayLog.add("[app] installing the update: confirm on Android's screen")
    }

    /** The update did not happen: say why, and bring the gateway back if it was running before. */
    fun fail(ctx: Context, p: UpdateState.Problem, detail: String) {
        GatewayLog.add("[app] update not installed: $p $detail".trim())
        UpdateState.set(UpdateState.Step.FAILED, problem = p, detail = detail)
        if (Prefs.resumeAfterUpdate(ctx)) {
            Prefs.setResumeAfterUpdate(ctx, false)
            GatewayService.start(ctx)
        }
    }
}
