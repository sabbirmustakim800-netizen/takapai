package bd.takamatch.reader

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * নেটওয়ার্ক না থাকলেও মেসেজ হারায় না — ডিস্কে লাইন-বাই-লাইন JSON হিসেবে জমা থাকে,
 * সার্ভার 200 ফেরত দিলে তবেই সারি মুছে যায়।
 *
 * প্রতিটি ইভেন্টে client_event_id আছে, তাই রিট্রাই হলেও সার্ভারে ডুপ্লিকেট তৈরি হয় না।
 */
object EventQueue {

    private const val FILE_NAME = "pending_events.jsonl"
    private const val MAX_EVENTS = 500

    private fun file(context: Context) = File(context.filesDir, FILE_NAME)

    @Synchronized
    fun enqueue(context: Context, event: JSONObject) {
        val f = file(context)
        val items = readAll(f)
        if (items.size >= MAX_EVENTS) items.removeAt(0) // পুরনো ফেলে দিই, অ্যাপ যেন ফুলে না যায়
        items.add(event)
        writeAll(f, items)
    }

    @Synchronized
    fun peek(context: Context, max: Int): List<JSONObject> =
        readAll(file(context)).take(max)

    @Synchronized
    fun removeFirst(context: Context, count: Int) {
        val f = file(context)
        val items = readAll(f)
        if (count >= items.size) {
            f.delete()
            return
        }
        writeAll(f, items.drop(count))
    }

    @Synchronized
    fun size(context: Context): Int = readAll(file(context)).size

    @Synchronized
    fun clear(context: Context) {
        file(context).delete()
    }

    private fun readAll(f: File): MutableList<JSONObject> {
        if (!f.exists()) return mutableListOf()
        return try {
            f.readLines()
                .filter { it.isNotBlank() }
                .mapNotNull { line ->
                    try {
                        JSONObject(line)
                    } catch (e: Exception) {
                        null
                    }
                }
                .toMutableList()
        } catch (e: Exception) {
            mutableListOf()
        }
    }

    private fun writeAll(f: File, items: List<JSONObject>) {
        val tmp = File(f.parentFile, "$FILE_NAME.tmp")
        tmp.writeText(items.joinToString("\n") { it.toString() })
        if (!tmp.renameTo(f)) {
            f.delete()
            tmp.renameTo(f)
        }
    }
}
