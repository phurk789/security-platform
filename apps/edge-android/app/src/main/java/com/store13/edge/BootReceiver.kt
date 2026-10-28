package com.store13.edge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Starts the gateway after the remote boots, only if the person turned "Start on boot" on (off by default). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (Prefs.startOnBoot(ctx) && PairingStore.load(ctx) != null) GatewayService.start(ctx)
        else Prefs.setWantRunning(ctx, false)
    }
}
