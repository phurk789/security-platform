package com.store13.edge

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.content.res.ColorStateList
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import java.util.Locale
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
    private lateinit var phaseDot: View
    private lateinit var uptimeText: TextView
    private lateinit var problemText: TextView
    private lateinit var mainButton: Button
    private lateinit var datalinkWarning: View
    private lateinit var leftCol: View
    private lateinit var rightCol: View
    private lateinit var settingsSection: View
    private lateinit var serverStatus: TextView
    private lateinit var devicesStatus: TextView
    private lateinit var videoStatus: TextView
    private lateinit var logView: TextView
    private lateinit var logMore: Button
    private lateinit var bootSwitch: Switch
    private lateinit var batteryText: TextView
    private lateinit var batteryButton: Button
    private lateinit var unpairButton: Button
    private lateinit var updateBanner: View
    private lateinit var updateBannerText: TextView
    private lateinit var updateBannerButton: Button
    private lateinit var updateText: TextView
    private lateinit var checkUpdateButton: Button
    private lateinit var installUpdateButton: Button
    private var logExpanded = false
    private var pairing = false

    private val render: () -> Unit = { render() }

    /** Ticks once a second while the screen is open, for the "online for" clock. */
    private val ui = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            showUptime()
            ui.postDelayed(this, 1000)
        }
    }

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
        phaseDot = findViewById(R.id.phaseDot)
        uptimeText = findViewById(R.id.uptimeText)
        problemText = findViewById(R.id.problemText)
        mainButton = findViewById(R.id.mainButton)
        datalinkWarning = findViewById(R.id.datalinkWarning)
        leftCol = findViewById(R.id.leftCol)
        rightCol = findViewById(R.id.rightCol)
        settingsSection = findViewById(R.id.settingsSection)
        serverStatus = findViewById(R.id.serverStatus)
        devicesStatus = findViewById(R.id.devicesStatus)
        videoStatus = findViewById(R.id.videoStatus)
        logView = findViewById(R.id.logView)
        logMore = findViewById(R.id.logMore)
        bootSwitch = findViewById(R.id.bootSwitch)
        batteryText = findViewById(R.id.batteryText)
        batteryButton = findViewById(R.id.batteryButton)
        unpairButton = findViewById(R.id.unpairButton)
        updateBanner = findViewById(R.id.updateBanner)
        updateBannerText = findViewById(R.id.updateBannerText)
        updateBannerButton = findViewById(R.id.updateBannerButton)
        updateText = findViewById(R.id.updateText)
        checkUpdateButton = findViewById(R.id.checkUpdateButton)
        installUpdateButton = findViewById(R.id.installUpdateButton)
        checkUpdateButton.setOnClickListener { Updater.check(this, force = true) }
        installUpdateButton.setOnClickListener { startUpdate() }
        updateBannerButton.setOnClickListener { startUpdate() }

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
        // One big button: Start when stopped, Stop otherwise (nothing while it is stopping).
        mainButton.setOnClickListener {
            when (EdgeState.phase) {
                EdgeState.Phase.STOPPED -> start()
                EdgeState.Phase.STOPPING -> Unit
                else -> GatewayService.stop(this)
            }
        }
        findViewById<Button>(R.id.settingsButton).setOnClickListener {
            val show = settingsSection.visibility != View.VISIBLE
            settingsSection.visibility = if (show) View.VISIBLE else View.GONE
            if (show) settingsSection.post { (settingsSection.parent.parent as? ScrollView)?.smoothScrollTo(0, settingsSection.top) }
        }
        applyColumns()
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
        findViewById<TextView>(R.id.versionText).text = getString(R.string.version, "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
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
        ui.post(tick)
        // Look for a newer version when the app opens (at most every 10 minutes).
        if (PairingStore.load(this) != null) Updater.check(this, force = false)
    }

    /** Update button: ask once for "install unknown apps", then stop the gateway, download, verify and install. */
    private fun startUpdate() {
        if (UpdateState.release == null || UpdateState.busy) return
        if (!Updater.canInstall(this)) {
            UpdateState.set(UpdateState.Step.AVAILABLE, problem = UpdateState.Problem.NEED_PERMISSION)
            startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
            return
        }
        Updater.update(this)
    }

    /** What the update section says, and whether its Update button shows (with which label). */
    private fun updateView(paired: Boolean): Pair<String, String?> {
        val s = UpdateState
        val r = s.release
        val mine = BuildConfig.VERSION_NAME
        val newer = r != null && UpdateLogic.isNewer(BuildConfig.VERSION_CODE.toLong(), r)
        if (!paired) return getString(R.string.update_not_paired) to null
        val text = when (s.step) {
            UpdateState.Step.IDLE -> getString(R.string.update_installed, mine)
            UpdateState.Step.CHECKING -> getString(R.string.update_checking)
            UpdateState.Step.LATEST -> getString(R.string.update_latest, mine)
            UpdateState.Step.NONE -> getString(R.string.update_none)
            UpdateState.Step.AVAILABLE ->
                if (s.problem == UpdateState.Problem.NEED_PERMISSION) getString(R.string.update_permission) else getString(R.string.update_available, r?.versionName ?: "", mine)
            UpdateState.Step.STOPPING -> getString(R.string.update_stopping)
            UpdateState.Step.DOWNLOADING -> getString(R.string.update_downloading, r?.versionName ?: "", s.progress)
            UpdateState.Step.INSTALLING -> getString(R.string.update_installing)
            UpdateState.Step.FAILED -> when (s.problem) {
                UpdateState.Problem.NOT_PAIRED -> getString(R.string.update_not_paired)
                UpdateState.Problem.KEY_REFUSED -> getString(R.string.update_key_refused)
                UpdateState.Problem.BAD_FILE -> getString(R.string.update_bad_file)
                UpdateState.Problem.WRONG_PACKAGE -> getString(R.string.update_wrong_package)
                UpdateState.Problem.NOT_NEWER -> getString(R.string.update_not_newer)
                UpdateState.Problem.WRONG_SIGNER -> getString(R.string.update_wrong_signer)
                UpdateState.Problem.NEED_PERMISSION -> getString(R.string.update_permission)
                UpdateState.Problem.CANCELLED -> getString(R.string.update_cancelled)
                UpdateState.Problem.NO_SPACE -> getString(R.string.update_no_space)
                UpdateState.Problem.INSTALL_FAILED -> getString(R.string.update_failed, s.detail)
                UpdateState.Problem.NO_SERVER, null -> getString(R.string.update_no_server)
            }
        }
        val retryable = s.step == UpdateState.Step.FAILED && newer &&
            s.problem in setOf(UpdateState.Problem.NO_SERVER, UpdateState.Problem.BAD_FILE, UpdateState.Problem.CANCELLED, UpdateState.Problem.NO_SPACE, UpdateState.Problem.INSTALL_FAILED)
        val button = when {
            s.step == UpdateState.Step.AVAILABLE && r != null -> getString(R.string.update_now, r.versionName)
            retryable -> getString(R.string.update_retry)
            else -> null
        }
        return text to button
    }

    override fun onPause() {
        EdgeState.unlisten(render)
        ui.removeCallbacks(tick)
        super.onPause()
    }

    /** Wide screen (the remote in landscape): state on the left, status and log on the right. */
    private fun applyColumns() {
        val wide = resources.configuration.screenWidthDp >= 720
        (runSection as LinearLayout).orientation = if (wide) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        val gap = (16 * resources.displayMetrics.density).toInt()
        fun column(v: View, weight: Float, start: Int) {
            val lp = v.layoutParams as LinearLayout.LayoutParams
            lp.width = if (wide) 0 else ViewGroup.LayoutParams.MATCH_PARENT
            lp.weight = if (wide) weight else 0f
            lp.marginStart = if (wide) start else 0
            v.layoutParams = lp
        }
        column(leftCol, 2f, 0)
        column(rightCol, 3f, gap)
    }

    private fun showUptime() {
        val since = EdgeState.runningSince
        if (since == null) {
            uptimeText.visibility = View.GONE
            return
        }
        val s = (SystemClock.elapsedRealtime() - since) / 1000
        uptimeText.text = getString(R.string.uptime, String.format(Locale.US, "%02d:%02d:%02d", s / 3600, s / 60 % 60, s % 60))
        uptimeText.visibility = View.VISIBLE
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
        val tone = getColor(if (phase == EdgeState.Phase.RUNNING) R.color.ok else if (phase == EdgeState.Phase.STOPPED) R.color.idle else R.color.warn)
        phaseDot.backgroundTintList = ColorStateList.valueOf(tone)
        showUptime()
        val problem = EdgeState.lastProblem
        problemText.text = problem ?: ""
        problemText.visibility = if (problem != null && phase != EdgeState.Phase.RUNNING) View.VISIBLE else View.GONE
        // Green Start when stopped, red Stop while running or starting, greyed while stopping.
        mainButton.text = getString(
            when (phase) {
                EdgeState.Phase.STOPPED -> R.string.button_start
                EdgeState.Phase.STOPPING -> R.string.button_wait
                else -> R.string.button_stop
            },
        )
        mainButton.backgroundTintList = ColorStateList.valueOf(
            getColor(
                when (phase) {
                    EdgeState.Phase.STOPPED -> R.color.ok
                    EdgeState.Phase.STOPPING -> R.color.idle
                    else -> R.color.bad
                },
            ),
        )
        mainButton.isEnabled = phase != EdgeState.Phase.STOPPING
        datalinkWarning.visibility = if (phase == EdgeState.Phase.STOPPED) View.VISIBLE else View.GONE

        val s = if (phase == EdgeState.Phase.STOPPED) null else EdgeState.status
        serverStatus.text = lines(
            listOf(if (phase == EdgeState.Phase.STOPPED) StatusText.Line(getString(R.string.not_running), StatusText.Tone.IDLE) else StatusText.server(this, s)),
        )
        devicesStatus.text = lines(StatusText.devices(this, s)).ifEmpty { p?.deviceIds?.joinToString(", ") ?: "" }
        videoStatus.text = lines(StatusText.video(this, s, p))

        val log = GatewayLog.last(if (logExpanded) 150 else 8)
        logView.text = if (log.isEmpty()) getString(R.string.log_empty) else log.joinToString("\n")
        logMore.text = getString(if (logExpanded) R.string.log_less else R.string.log_more)

        val (uText, uButton) = updateView(p != null)
        updateText.text = uText
        installUpdateButton.visibility = if (uButton != null) View.VISIBLE else View.GONE
        installUpdateButton.text = uButton ?: ""
        checkUpdateButton.isEnabled = p != null && !UpdateState.busy
        val inBanner = uButton != null || UpdateState.busy && UpdateState.step != UpdateState.Step.CHECKING
        updateBanner.visibility = if (p != null && inBanner) View.VISIBLE else View.GONE
        updateBannerText.text = uText
        updateBannerButton.visibility = installUpdateButton.visibility
        updateBannerButton.text = uButton ?: ""

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
