package bd.takamatch.reader

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * বিকাশ/রকেট/নগদ অ্যাপ নিজে পুশ নোটিফিকেশন দিলে সেটিও পড়ে।
 * (কিছু ক্ষেত্রে অ্যাপের নোটিফিকেশন এসএমএসের চেয়ে আগে আসে।)
 *
 * ব্যবহারকারীকে Settings → Notification access থেকে এই সার্ভিস চালু করতে হয়।
 */
class MfsNotificationListener : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val notification = sbn?.notification ?: return
        @Suppress("DEPRECATION")
        val extras = notification.extras ?: return

        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim()
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim()
        @Suppress("DEPRECATION")
        val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim()

        val body = listOfNotNull(title, bigText ?: text)
            .filter { it.isNotEmpty() }
            .joinToString(" ")
            .trim()

        if (body.isEmpty()) return

        val packageName = sbn.packageName ?: ""
        if (!Mfs.isKnownMfsPackage(packageName) && !Mfs.looksLikePayment(title, body)) {
            return
        }

        val event = JSONObject()
            .put("client_event_id", UUID.randomUUID().toString())
            .put("source", "notification")
            .put("sender", title ?: packageName)
            .put("text", body)
            .put("received_at", isoUtc(if (sbn.postTime > 0) sbn.postTime else System.currentTimeMillis()))

        EventQueue.enqueue(this, event)
        Uploader.schedule(this)
    }

    private fun isoUtc(millis: Long): String {
        val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        format.timeZone = TimeZone.getTimeZone("UTC")
        return format.format(Date(millis))
    }
}
