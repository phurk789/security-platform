package com.store13.edge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import java.io.File

/** Android's installer reports here: show its confirm screen, or say what became of the update. */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        GatewayLog.init(ctx)
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: ""
        when (UpdateLogic.outcome(status)) {
            UpdateLogic.Outcome.NEEDS_CONFIRM -> {
                @Suppress("DEPRECATION")
                val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT)
                confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let { ctx.startActivity(it) }
            }
            UpdateLogic.Outcome.DONE -> GatewayLog.add("[app] update installed") // this process is replaced by the new version
            UpdateLogic.Outcome.CANCELLED -> Updater.fail(ctx, UpdateState.Problem.CANCELLED, "")
            UpdateLogic.Outcome.WRONG_SIGNER -> Updater.fail(ctx, UpdateState.Problem.WRONG_SIGNER, message)
            UpdateLogic.Outcome.NO_SPACE -> Updater.fail(ctx, UpdateState.Problem.NO_SPACE, message)
            else -> Updater.fail(ctx, UpdateState.Problem.INSTALL_FAILED, message)
        }
    }
}

/** Runs in the new version right after an update: note it, tell the person, start the gateway again if it was running. */
class UpdatedReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val c = Lang.wrap(ctx)
        GatewayLog.init(ctx)
        val version = try {
            ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: ""
        } catch (e: Exception) {
            ""
        }
        GatewayLog.add("[app] updated to $version")
        File(ctx.cacheDir, "updates").deleteRecursively()
        val resume = Prefs.resumeAfterUpdate(ctx) && PairingStore.load(ctx) != null
        Prefs.setResumeAfterUpdate(ctx, false)
        var started = false
        if (resume) {
            started = try {
                GatewayService.start(ctx)
                true
            } catch (e: Exception) {
                // Android may refuse a background start: the person presses Start.
                GatewayLog.add("[app] could not start the gateway after the update: ${e.message}")
                false
            }
        }
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("updates", c.getString(R.string.update_title), NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(ctx, 2, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        nm.notify(
            2,
            Notification.Builder(ctx, "updates")
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(c.getString(R.string.update_done, version))
                .setContentText(c.getString(if (started) R.string.update_done_resumed else R.string.update_done_start))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build(),
        )
    }
}
