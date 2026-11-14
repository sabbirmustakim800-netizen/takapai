package bd.takamatch.reader

import android.content.Context
import android.content.SharedPreferences

/**
 * ডিভাইসের নিজের ইউনিক আইডি ও API কী এখানে থাকে।
 * পেয়ারিং একবারই লাগে — তারপর অ্যাপ সার্ভার রিস্টার্ট হলেও নিজে থেকেই কাজ করে।
 *
 * ফাইলটি অ্যাপ-প্রাইভেট স্টোরেজে থাকে; অন্য কোনো অ্যাপ পড়তে পারে না।
 */
class PairingStore(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER, "")?.trim()?.trimEnd('/') ?: ""
        set(value) {
            prefs.edit().putString(KEY_SERVER, value.trim().trimEnd('/')).apply()
        }

    var deviceId: String
        get() = prefs.getString(KEY_DEVICE_ID, "") ?: ""
        set(value) {
            prefs.edit().putString(KEY_DEVICE_ID, value).apply()
        }

    var deviceKey: String
        get() = prefs.getString(KEY_DEVICE_KEY, "") ?: ""
        set(value) {
            prefs.edit().putString(KEY_DEVICE_KEY, value).apply()
        }

    var label: String
        get() = prefs.getString(KEY_LABEL, "") ?: ""
        set(value) {
            prefs.edit().putString(KEY_LABEL, value).apply()
        }

    var lastUploadAt: Long
        get() = prefs.getLong(KEY_LAST_UPLOAD, 0L)
        set(value) {
            prefs.edit().putLong(KEY_LAST_UPLOAD, value).apply()
        }

    val isPaired: Boolean
        get() = deviceId.isNotEmpty() && deviceKey.isNotEmpty() && serverUrl.isNotEmpty()

    fun clear() {
        prefs.edit().clear().apply()
    }

    companion object {
        private const val PREFS = "takamatch"
        private const val KEY_SERVER = "server_url"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_KEY = "device_key"
        private const val KEY_LABEL = "label"
        private const val KEY_LAST_UPLOAD = "last_upload_at"

        /** অ্যাপের সংস্করণ — সার্ভারে রিপোর্ট করা হয় */
        const val APP_VERSION = "1.0.0"
    }
}
