import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/* ═══════════════════════ রিলিজ সাইনিং ═══════════════════════
 * কী ও পাসওয়ার্ড দেওয়ার দুইটি পথ (যেটা সুবিধা সেটাই):
 *
 *   ১) এনভায়রনমেন্ট ভ্যারিয়েবল — ফাইলে কিছু লিখতে হয় না:
 *        KEYSTORE_FILE   (android/ ফোল্ডারের সাপেক্ষে, বা absolute path)
 *        KEYSTORE_PASSWORD
 *        KEY_ALIAS
 *        KEY_PASSWORD
 *
 *   ২) android/keystore.properties (gitignore করা):
 *        storeFile=release.keystore
 *        storePassword=...
 *        keyAlias=takamatch
 *        keyPassword=...
 *
 * কোনোটাই দেওয়া না থাকলে release বিল্ড unsigned হবে — debug বিল্ড
 * সবসময়ের মতোই কাজ করবে। পাসওয়ার্ড কখনো এই ফাইলে হার্ডকোড করবেন না।
 */
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        keystorePropertiesFile.inputStream().use { load(it) }
    }
}

fun signingValue(propertyKey: String, envKey: String): String? =
    System.getenv(envKey)?.takeIf { it.isNotBlank() }
        ?: keystoreProperties.getProperty(propertyKey)?.takeIf { it.isNotBlank() }

val releaseStoreFile = signingValue("storeFile", "KEYSTORE_FILE")
val releaseStorePassword = signingValue("storePassword", "KEYSTORE_PASSWORD")
val releaseKeyAlias = signingValue("keyAlias", "KEY_ALIAS")
val releaseKeyPassword = signingValue("keyPassword", "KEY_PASSWORD")

val hasReleaseSigning = listOf(
    releaseStoreFile,
    releaseStorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { !it.isNullOrBlank() }

val wantsReleaseBuild = gradle.startParameter.taskNames
    .joinToString(" ")
    .contains("Release", ignoreCase = true)

if (wantsReleaseBuild) {
    if (hasReleaseSigning) {
        println("[TakaMatch] ✓ রিলিজ সাইনিং সক্রিয় (alias=${releaseKeyAlias})")
    } else {
        println("[TakaMatch] ⚠ রিলিজ সাইনিং কনফিগার করা নেই — APK/AAB unsigned হবে, ইনস্টল হবে না।")
        println("[TakaMatch]   KEYSTORE_FILE / KEYSTORE_PASSWORD / KEY_ALIAS / KEY_PASSWORD সেট করুন")
        println("[TakaMatch]   অথবা android/keystore.properties তৈরি করুন (android/README.md দেখুন)।")
    }
}

android {
    namespace = "bd.takamatch.reader"
    compileSdk = 34

    defaultConfig {
        applicationId = "bd.takamatch.reader"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = rootProject.file(releaseStoreFile!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            // পেমেন্ট-সংক্রান্ত অ্যাপ, আর R8-এর রানটাইম আচরণ এখানে পরীক্ষা করা যায় না —
            // তাই মিনিফিকেশন ডিফল্টে বন্ধ। চাইলে true করে নিন (proguard-rules.pro আছে)।
            isMinifyEnabled = false
            isShrinkResources = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        debug {
            // আলাদা suffix রাখা হয়নি — যাতে একই ফোনে একবারই ইনস্টল হয়
            // এবং পরে রিলিজ বিল্ডেও একই প্যাকেজ নাম থাকে।
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.work:work-runtime-ktx:2.9.0")
}
