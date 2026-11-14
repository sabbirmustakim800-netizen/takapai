package bd.takamatch.reader

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ListenableWorker.Result
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * সার্ভারে ইভেন্ট পাঠানোর কাজ।
 * - নেটওয়ার্ক ফিরলেই WorkManager নিজে থেকে আবার চেষ্টা করে (exponential backoff)
 * - 401/403 মানে কী বাতিল → রিট্রাই করে সময় নষ্ট করি না
 * - 400 মানে ওই একটি মেসেজই খারাপ → সেটি বাদ দিয়ে বাকিগুলো পাঠাই
 */
class UploadWorker(appContext: Context, params: WorkerParameters) : Worker(appContext, params) {
    override fun doWork(): Result = Uploader.uploadNow(applicationContext)
}

object Uploader {

    private const val MAX_BATCH = 40
    private const val UNIQUE_WORK = "takamatch-upload"
    private const val PERIODIC_WORK = "takamatch-periodic"

    fun schedule(context: Context, delaySeconds: Long = 0) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setConstraints(constraints)
            .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 20, TimeUnit.SECONDS)
            .build()

        WorkManager.getInstance(context).enqueueUniqueWork(
            UNIQUE_WORK,
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            request,
        )
    }

    /** ব্যাটারি বাঁচাতে ৩০ মিনিটে একবার নিরাপত্তা-জাল (যদি কোনো ইভেন্ট রয়ে যায়) */
    fun schedulePeriodic(context: Context) {
        val request = PeriodicWorkRequestBuilder<UploadWorker>(30, TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
            )
            .build()

        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            PERIODIC_WORK,
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }

    fun uploadNow(context: Context): Result {
        val store = PairingStore(context)
        if (!store.isPaired) return Result.success()

        val pending = EventQueue.peek(context, MAX_BATCH)
        if (pending.isEmpty()) return Result.success()

        val body = JSONObject().put("events", JSONArray(pending)).toString()
        var conn: HttpURLConnection? = null

        try {
            val url = URL(store.serverUrl + "/api/ingest")
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15_000
                readTimeout = 25_000
                doOutput = true
                setRequestProperty("content-type", "application/json")
                setRequestProperty("x-device-id", store.deviceId)
                setRequestProperty("x-device-key", store.deviceKey)
            }

            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }

            val code = conn.responseCode
            if (code in 200..299) {
                EventQueue.removeFirst(context, pending.size)
                store.lastUploadAt = System.currentTimeMillis()
                return Result.success()
            }
            if (code == 401 || code == 403) {
                // কী বাতিল হয়েছে — অ্যাপে নতুন করে পেয়ার করতে হবে
                return Result.failure()
            }
            if (code == 400) {
                // কোন ইভেন্টটি খারাপ জানা যায় না, তাই একটি বাদ দিয়ে আবার চেষ্টা
                EventQueue.removeFirst(context, 1)
                return Result.retry()
            }
            return Result.retry()
        } catch (e: Exception) {
            return Result.retry()
        } finally {
            conn?.disconnect()
        }
    }
}
