package bd.takamatch.reader

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * 16247 / 16216 / 16167 (অথবা bKash / Rocket / Nagad) থেকে আসা এসএমএস ধরে
 * সারিতে জমা করে। অ্যাপ বন্ধ থাকলেও এটি কাজ করে — কারণ ব্রডকাস্ট রিসিভার
 * ম্যানিফেস্টে নিবন্ধিত।
 */
class SmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val messages = try {
            Telephony.Sms.Intents.getMessagesFromIntent(intent)
        } catch (e: Exception) {
            return
        } ?: return

        // দীর্ঘ এসএমএস কয়েক টুকরো হয়ে আসে — প্রেরক অনুযায়ী জোড়া লাগাই
        val grouped = LinkedHashMap<String, StringBuilder>()
        var timestamp = System.currentTimeMillis()

        for (msg in messages) {
            val sender = msg.originatingAddress ?: continue
            grouped.getOrPut(sender) { StringBuilder() }.append(msg.messageBody ?: "")
            if (msg.timestampMillis > 0) timestamp = msg.timestampMillis
        }

        var queued = 0
        for ((sender, builder) in grouped) {
            val text = builder.toString()
            if (!Mfs.looksLikePayment(sender, text)) continue

            val event = JSONObject()
                .put("client_event_id", UUID.randomUUID().toString())
                .put("source", "sms")
                .put("sender", sender)
                .put("text", text)
                .put("received_at", isoUtc(timestamp))

            EventQueue.enqueue(context, event)
            queued++
        }

        if (queued > 0) Uploader.schedule(context)
    }

    private fun isoUtc(millis: Long): String {
        val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        format.timeZone = TimeZone.getTimeZone("UTC")
        return format.format(Date(millis))
    }
}
