package bd.takamatch.reader

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** ফোন রিবুট হলেও সারি থেকে যায় — কাজ আবার চালু করি */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val store = PairingStore(context)
        if (!store.isPaired) return

        Uploader.schedule(context, 20)
        Uploader.schedulePeriodic(context)
    }
}
