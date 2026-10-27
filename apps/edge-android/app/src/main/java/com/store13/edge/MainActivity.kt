package com.store13.edge

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import com.google.zxing.integration.android.IntentIntegrator
import kotlin.concurrent.thread

class MainActivity : Activity() {
    private lateinit var subtitle: TextView
    private lateinit var pairSection: View
    private lateinit var runSection: View
    private lateinit var serverInput: EditText
    private lateinit var codeInput: EditText
    private lateinit var pairButton: Button
    private lateinit var pairMessage: TextView
    private lateinit var phaseText: TextView
    private lateinit var problemText: TextView
    private lateinit var startButton: Button
    private lateinit var stopButton: Button
    private lateinit var serverStatus: TextView
    private lateinit var devicesStatus: TextView
    private lateinit var videoStatus: TextView
    private lateinit var logView: TextView
    private lateinit var logMore: Button
    private lateinit var bootSwitch: Switch
    private lateinit var batteryText: TextView
    private lateinit var batteryButton: Button
    private lateinit var unpairButton: Button
    private var logExpanded = false
    private var pairing = false

    private val render: () -> Unit = { render() }

    override fun attachBaseContext(newBase: Context) = super.attachBaseContext(Lang.wrap(newBase))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        GatewayLog.init(this)
        subtitle = findViewById(R.id.subtitle)
        pairSection = findViewById(R.id.pairSection)
        runSection = findViewById(R.id.runSection)
        serverInput = findViewById(R.id.serverInput)
        codeInput = findViewById(R.id.codeInput)
        pairButton = findViewById(R.id.pairButton)
        pairMessage = findViewById(R.id.pairMessage)
        phaseText = findViewById(R.id.phaseText)
        problemText = findViewById(R.id.problemText)
        startButton = findViewById(R.id.startButton)
        stopButton = findViewById(R.id.stopButton)
        serverStatus = findViewById(R.id.serverStatus)
        devicesStatus = findViewById(R.id.devicesStatus)
        videoStatus = findViewById(R.id.videoStatus)
        logView = findViewById(R.id.logView)
        logMore = findViewById(R.id.logMore)
        bootSwitch = findViewById(R.id.bootSwitch)
        batteryText = findViewById(R.id.batteryText)
        batteryButton = findViewById(R.id.batteryButton)
        unpairButton = findViewById(R.id.unpairButton)

        serverInput.setText(Prefs.lastServer(this))
        pairButton.setOnClickListener { pair() }
        findViewById<Button>(R.id.scanButton).apply {
            visibility = if (packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) View.VISIBLE else View.GONE
            setOnClickListener {
                IntentIntegrator(this@MainActivity)
                    .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
                    .setPrompt(getString(R.string.scan_prompt))
                    .setBeepEnabled(false)
                    .setOrientationLocked(false)
                    .initiateScan()
            }
        }
        startButton.setOnClickListener { start() }
        stopButton.setOnClickListener { GatewayService.stop(this) }
        logMore.setOnClickListener {
            logExpanded = !logExpanded
            render()
        }
        bootSwitch.setOnCheckedChangeListener { _, on -> Prefs.setStartOnBoot(this, on) }
        batteryButton.setOnClickListener {
            try {
                startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
            } catch (e: Exception) {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }
        }
        unpairButton.setOnClickListener { unpair() }
        findViewById<Button>(R.id.licensesButton).setOnClickListener { startActivity(Intent(this, LicensesActivity::class.java)) }
        findViewById<Button>(R.id.langButton).setOnClickListener {
            Prefs.setLang(this, if (Prefs.lang(this) == "th") "en" else "th")
            recreate()
        }
        findViewById<TextView>(R.id.versionText).text = getString(R.string.version, BuildConfig.VERSION_NAME)
        handleLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleLink(intent)
    }

    override fun onResume() {
        super.onResume()
        EdgeState.listen(render)
        render()
    }

    override fun onPause() {
        EdgeState.unlisten(render)
        super.onPause()
    }

    /** psedge://pair?server=…&code=… opened from the QR (camera app or the in-app scanner). */
    private fun handleLink(intent: Intent?) {
        val data = intent?.data?.toString() ?: return
        applyPairingText(data)
    }

    @Deprecated("Activity result API of the platform Activity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        val r = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (r == null) return super.onActivityResult(requestCode, resultCode, data)
        r.contents?.let { applyPairingText(it) }
    }

    private fun applyPairingText(text: String) {
        val p = PairingLink.parse(text)
        if (p == null) {
            pairMessage.text = getString(R.string.scan_bad)
            return
        }
        p.server?.let { serverInput.setText(it) }
        codeInput.setText(p.code)
        if (PairingStore.load(this) == null) pair()
    }

    private fun pair() {
        if (pairing) return
        val server = ServerAddress.normalize(serverInput.text.toString())
        val code = PairingLink.parse(codeInput.text.toString())?.code
        when {
            server == null -> return say(getString(R.string.pair_bad_server))
            code == null -> return say(getString(R.string.pair_bad_code))
        }
        pairing = true
        pairButton.isEnabled = false
        say(getString(R.string.pairing_wait))
        val client = PairingClient.clientInfo(this)
        thread(name = "pair") {
            val r = PairingClient.pair(server!!, code!!, client)
            runOnUiThread {
                pairing = false
                pairButton.isEnabled = true
                when (r) {
                    is PairingClient.Result.Ok -> {
                        PairingStore.save(this, r.pairing, r.key)
                        Prefs.setLastServer(this, server)
                        codeInput.setText("")
                        GatewayLog.add("[app] paired as ${r.pairing.gatewayId} with $server")
                        Toast.makeText(this, getString(R.string.pair_ok, r.pairing.gatewayId), Toast.LENGTH_LONG).show()
                        say("")
                        render()
                    }
                    is PairingClient.Result.Failed -> say(
                        when (r.reason) {
                            "wrong_code" -> getString(R.string.pair_wrong_code)
                            "too_many" -> getString(R.string.pair_too_many)
                            "no_server" -> getString(R.string.pair_no_server, server)
                            else -> getString(R.string.pair_server_error, r.detail)
                        },
                    )
                }
            }
        }
    }

    private fun say(text: String) {
        pairMessage.text = text
    }

    private fun start() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        GatewayService.start(this)
    }

    private fun unpair() {
        if (EdgeState.phase != EdgeState.Phase.STOPPED) {
            Toast.makeText(this, R.string.unpair_running, Toast.LENGTH_SHORT).show()
            return
        }
        AlertDialog.Builder(this)
            .setMessage(R.string.unpair_confirm)
            .setPositiveButton(R.string.yes) { _, _ ->
                PairingStore.clear(this)
                Prefs.setWantRunning(this, false)
                GatewayLog.add("[app] ${getString(R.string.unpair_done)}")
                render()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun render() {
        val p = PairingStore.load(this)
        subtitle.text = if (p != null) getString(R.string.paired_as, p.gatewayId, p.siteName, p.server) else getString(R.string.not_paired)
        pairSection.visibility = if (p == null) View.VISIBLE else View.GONE
        runSection.visibility = if (p != null) View.VISIBLE else View.GONE
        unpairButton.visibility = if (p != null) View.VISIBLE else View.GONE

        val phase = EdgeState.phase
        phaseText.text = getString(
            when (phase) {
                EdgeState.Phase.STOPPED -> R.string.gateway_stopped
                EdgeState.Phase.STARTING -> R.string.gateway_starting
                EdgeState.Phase.RUNNING -> R.string.gateway_running
                EdgeState.Phase.RESTARTING -> R.string.gateway_restarting
                EdgeState.Phase.STOPPING -> R.string.gateway_stopping
            },
        )
        phaseText.setTextColor(getColor(if (phase == EdgeState.Phase.RUNNING) R.color.ok else if (phase == EdgeState.Phase.STOPPED) R.color.idle else R.color.warn))
        val problem = EdgeState.lastProblem
        problemText.text = problem ?: ""
        problemText.visibility = if (problem != null && phase != EdgeState.Phase.RUNNING) View.VISIBLE else View.GONE
        startButton.isEnabled = phase == EdgeState.Phase.STOPPED
        stopButton.isEnabled = phase != EdgeState.Phase.STOPPED && phase != EdgeState.Phase.STOPPING
        // A tinted button looks the same when disabled: fade the one that cannot be pressed.
        startButton.alpha = if (startButton.isEnabled) 1f else 0.3f
        stopButton.alpha = if (stopButton.isEnabled) 1f else 0.3f

        val s = if (phase == EdgeState.Phase.STOPPED) null else EdgeState.status
        serverStatus.text = lines(
            listOf(if (phase == EdgeState.Phase.STOPPED) StatusText.Line(getString(R.string.not_running), StatusText.Tone.IDLE) else StatusText.server(this, s)),
        )
        devicesStatus.text = lines(StatusText.devices(this, s)).ifEmpty { p?.deviceIds?.joinToString(", ") ?: "" }
        videoStatus.text = lines(StatusText.video(this, s, p))

        val log = GatewayLog.last(if (logExpanded) 150 else 12)
        logView.text = if (log.isEmpty()) getString(R.string.log_empty) else log.joinToString("\n")
        logMore.text = getString(if (logExpanded) R.string.log_less else R.string.log_more)

        bootSwitch.isChecked = Prefs.startOnBoot(this)
        val ignoring = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)
        batteryText.text = getString(if (ignoring) R.string.battery_ok else R.string.battery_on)
        batteryButton.visibility = if (ignoring) View.GONE else View.VISIBLE
    }

    /** Status lines with the leading dot coloured by tone. */
    private fun lines(ls: List<StatusText.Line>): CharSequence {
        val out = SpannableStringBuilder()
        ls.forEachIndexed { i, l ->
            if (i > 0) out.append('\n')
            val start = out.length
            out.append(l.text)
            val color = getColor(
                when (l.tone) {
                    StatusText.Tone.OK -> R.color.ok
                    StatusText.Tone.WARN -> R.color.warn
                    StatusText.Tone.BAD -> R.color.bad
                    StatusText.Tone.IDLE -> R.color.idle
                },
            )
            if (l.text.startsWith("●")) out.setSpan(ForegroundColorSpan(color), start, start + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        return out
    }
}
