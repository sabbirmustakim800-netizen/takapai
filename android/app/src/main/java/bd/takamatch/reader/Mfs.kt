package bd.takamatch.reader

/**
 * কোন মেসেজটি বিকাশ/রকেট/নগদের — সেটি ফোনেই প্রাথমিকভাবে ছেঁকে নিই।
 * এতে ব্যবহারকারীর অন্য ব্যক্তিগত এসএমএস সার্ভারে যায় না।
 *
 * চূড়ান্ত সিদ্ধান্ত সার্ভারই নেয় (server/parser.js) — এখানে শুধু ফিল্টার।
 */
object Mfs {

    private val SHORTCODES = mapOf(
        "16247" to "bkash",
        "16216" to "rocket",
        "16167" to "nagad",
    )

    private val KEYWORDS = listOf(
        "bkash", "bikash", "বিকাশ",
        "rocket", "dbbl", "ডাচ-বাংলা",
        "nagad", "নগদ",
    )

    private val PACKAGE_HINTS = listOf("bkash", "rocket", "nagad", "dbbl")

    fun shortcodeProvider(source: String?): String? {
        val digits = (source ?: "").filter { it.isDigit() }
        return SHORTCODES[digits]
    }

    /** প্রেরক শর্টকোড/ব্র্যান্ড নাম, অথবা টেক্সটে ব্র্যান্ড নাম থাকলে true */
    fun looksLikePayment(source: String?, text: String?): Boolean {
        if (shortcodeProvider(source) != null) return true
        val haystack = "${(source ?: "").lowercase()} ${(text ?: "").lowercase()}"
        return KEYWORDS.any { haystack.contains(it) }
    }

    fun isKnownMfsPackage(packageName: String?): Boolean {
        val pkg = (packageName ?: "").lowercase()
        return PACKAGE_HINTS.any { pkg.contains(it) }
    }
}
