package bd.takamatch.reader

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * অ্যাপের একমাত্র স্ক্রিন।
 *
 * ★ গুরুত্বপূর্ণ: এসএমএস অনুমতি না দেওয়া পর্যন্ত অ্যাপে ঢোকা যায় না।
 *   গেট স্ক্রিন পুরো টাচ ব্লক করে রাখে, আর লঞ্চের সঙ্গে সঙ্গে সিস্টেমের
 *   পারমিশন পপ-আপ দেখানো হয়।
 */
class MainActivity : AppCompatActivity() {

    private lateinit var store: PairingStore
    private lateinit var etServer: EditText
    private lateinit var etCode: EditText
    private lateinit var tvStatus: TextView
    private lateinit var contentRoot: View
    private lateinit var permissionGate: View

    private val executor = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        store = PairingStore(this)
        etServer = findViewById(R.id.etServer)
        etCode = findViewById(R.id.etCode)
        tvStatus = findViewById(R.id.tvStatus)
        contentRoot = findViewById(R.id.contentRoot)
        permissionGate = findViewById(R.id.permissionGate)

        etServer.setText(store.serverUrl)

        findViewById<Button>(R.id.btnPair).setOnClickListener { pairDevice() }
        findViewById<Button>(R.id.btnSms).setOnClickListener { requestSmsPermission() }
        findViewById<Button>(R.id.btnNotif).setOnClickListener { openNotificationAccess() }
        findViewById<Button>(R.id.btnSync).setOnClickListener { syncNow() }

        findViewById<Button>(R.id.btnGrant).setOnClickListener { requestSmsPermission() }
        findViewById<Button>(R.id.btnNotifGate).setOnClickListener { openNotificationAccess() }
        findViewById<Button>(R.id.btnOpenSettings).setOnClickListener { openAppSettings() }

        Uploader.schedulePeriodic(this)

        // অনুমতি না থাকলে লঞ্চের সাথেই সিস্টেম পপ-আপ
        if (!hasSmsPermission()) {
            requestSmsPermission()
        }
        applyGate()
    }

    override fun onResume() {
        super.onResume()
        applyGate()
        if (hasSmsPermission() && store.isPaired) Uploader.schedule(this)
    }

    override fun onDestroy() {
        super.onDestroy()
        executor.shutdown()
    }

    /* ═══════════════ পারমিশন গেট ═══════════════ */

    private fun hasSmsPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * অনুমতি না থাকলে কনটেন্ট পুরোপুরি লুকিয়ে গেট দেখাই,
     * আর অনুমতি পেলে সঙ্গে সঙ্গে খুলে দিই।
     */
    private fun applyGate() {
        val granted = hasSmsPermission()
        permissionGate.visibility = if (granted) View.GONE else View.VISIBLE
        contentRoot.visibility = if (granted) View.VISIBLE else View.GONE
        if (granted) render()
    }

    private fun requestSmsPermission() {
        if (hasSmsPermission()) {
            toast(getString(R.string.sms_already_granted))
            applyGate()
            return
        }

        val wanted = mutableListOf(Manifest.permission.RECEIVE_SMS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            wanted.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        ActivityCompat.requestPermissions(this, wanted.toTypedArray(), REQUEST_PERMISSIONS)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_PERMISSIONS) return

        applyGate()
        if (hasSmsPermission()) {
            toast(getString(R.string.gate_granted))
            Uploader.schedulePeriodic(this)
        }
        // অস্বীকার করলে গেট-ই থাকে; "সেটিংসে যান" বোতাম দিয়ে ঠিক করা যাবে
    }

    private fun openAppSettings() {
        try {
            val intent = Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", packageName, null),
            )
            startActivity(intent)
        } catch (e: Exception) {
            startActivity(Intent(Settings.ACTION_SETTINGS))
        }
    }

    private fun openNotificationAccess() {
        try {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        } catch (e: Exception) {
            toast(getString(R.string.notification_settings_missing))
        }
    }

    /* ═══════════════ পেয়ারিং ═══════════════ */

    private fun pairDevice() {
        if (!hasSmsPermission()) {
            applyGate()
            toast(getString(R.string.gate_grant))
            return
        }

        val server = etServer.text.toString().trim().trimEnd('/')
        val code = etCode.text.toString().trim().uppercase()

        if (server.isEmpty()) {
            toast("সার্ভারের ঠিকানা দিন")
            return
        }
        if (!server.startsWith("http://") && !server.startsWith("https://")) {
            toast("সার্ভারের ঠিকানা অবশ্যই http:// বা https:// দিয়ে শুরু হতে হবে")
            return
        }
        if (code.isEmpty()) {
            toast("পেয়ারিং কোড দিন")
            return
        }

        tvStatus.text = getString(R.string.status_connecting)

        executor.execute {
            var conn: HttpURLConnection? = null
            try {
                val body = JSONObject()
                    .put("pairing_code", code)
                    .put("platform", "android")
                    .put("app_version", PairingStore.APP_VERSION)
                    .toString()

                conn = (URL("$server/api/devices/pair").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 15_000
                    readTimeout = 20_000
                    doOutput = true
                    setRequestProperty("content-type", "application/json")
                    setRequestProperty("accept", "application/json")
                }
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }

                val statusCode = conn.responseCode
                val stream = if (statusCode in 200..299) conn.inputStream else conn.errorStream
                val response = stream?.bufferedReader()?.use { it.readText() } ?: ""

                if (statusCode in 200..299) {
                    val credentials = JSONObject(response).getJSONObject("credentials")
                    store.serverUrl = server
                    store.deviceId = credentials.getString("device_id")
                    store.deviceKey = credentials.getString("device_key")
                    store.label = credentials.optString("label", "")

                    runOnUiThread {
                        render()
                        toast(getString(R.string.pair_success))
                    }
                    Uploader.schedule(this, 2)
                    Uploader.schedulePeriodic(this)
                } else {
                    val message = try {
                        JSONObject(response).getJSONObject("error").getString("message")
                    } catch (e: Exception) {
                        "ব্যর্থ হয়েছে (HTTP $statusCode)"
                    }
                    runOnUiThread {
                        tvStatus.text = getString(R.string.pair_failed)
                        toast(message)
                    }
                }
            } catch (e: Exception) {
                runOnUiThread {
                    tvStatus.text = getString(R.string.pair_failed)
                    toast(e.message ?: getString(R.string.network_error))
                }
            } finally {
                conn?.disconnect()
            }
        }
    }

    private fun syncNow() {
        if (!hasSmsPermission()) {
            applyGate()
            return
        }
        if (!store.isPaired) {
            toast(getString(R.string.pair_first))
            return
        }
        Uploader.schedule(this, 0)
        toast(getString(R.string.sync_queued))
    }

    /* ═══════════════ স্ক্রিন ═══════════════ */

    private fun render() {
        val pending = EventQueue.size(this)
        tvStatus.text = if (store.isPaired) {
            getString(
                R.string.status_paired,
                store.deviceId,
                store.serverUrl,
                pending.toString(),
                formatLastUpload(),
            )
        } else {
            getString(R.string.status_unpaired, pending.toString())
        }
    }

    private fun formatLastUpload(): String {
        val last = store.lastUploadAt
        if (last == 0L) return getString(R.string.never)
        val minutes = ((System.currentTimeMillis() - last) / 60_000).coerceAtLeast(0)
        return if (minutes < 1) getString(R.string.just_now) else "$minutes মিনিট আগে"
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }

    companion object {
        private const val REQUEST_PERMISSIONS = 1001
    }
}
