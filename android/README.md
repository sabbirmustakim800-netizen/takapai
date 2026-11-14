# টাকাম্যাচ রিডার — Android অ্যাপ

ফোনে আসা **বিকাশ (16247)**, **রকেট (16216)**, **নগদ (16167)** এর পেমেন্ট এসএমএস ও
অ্যাপের নোটিফিকেশন পড়ে সার্ভারে পাঠায়।

## তৈরি করা APK

দুই জায়গায় একই ফাইল:

```
artifacts/takamatch-reader-1.0.0.apk          (৩.৪ MB)
android/app/build/outputs/apk/debug/app-debug.apk
```

* প্যাকেজ: `bd.takamatch.reader` · versionName `1.0.0` · minSdk 24 (Android 7.0) · targetSdk 34
* সাইন: Android **debug** কী — ফোনে ইনস্টল করে ব্যবহার করা যায়; Play-এ দিতে হলে নিচের
  রিলিজ সাইনিং অংশ দেখুন
* ইনস্টল: ফাইলটি ফোনে নিয়ে "Unknown sources" চালু করে ট্যাপ করুন,
  অথবা `adb install -r artifacts/takamatch-reader-1.0.0.apk`

### অ্যাপ আইকন

লঞ্চার আইকন প্রজেক্টের ভেতরেই আছে (মিন্ট রঙের কয়েনে টিক চিহ্ন):

* `res/mipmap-anydpi-v26/ic_launcher.xml` — Android 8+ এর অ্যাডাপ্টিভ আইকন
* `res/mipmap-anydpi/ic_launcher.xml` — Android 7.x এর ফলব্যাক
* `res/drawable/ic_launcher_foreground.xml` — মূল আকৃতি (ভেক্টর, তাই সব স্ক্রিনে ঝকঝকে)

বদলাতে চাইলে শুধু ওই ভেক্টর ফাইলগুলোর রঙ/পাথ বদলান — কোনো PNG লাগবে না।

### "App not installed" হলে

১. **Unknown sources**: Settings → Apps → (ব্রাউজার/ফাইল ম্যানেজার) → Install unknown apps → Allow
২. **Play Protect** বন্ধ/উপেক্ষা করুন (debug-সাইনড APK-তে সতর্কতা দেখায়)
৩. পুরোনো কোনো বিল্ড থাকলে আগে আনইনস্টল করুন
৪. ফাইলটা পুরোপুরি ডাউনলোড হয়েছে কি না দেখুন (৩.৫ MB)
৫. `adb install -r` দিয়ে চেষ্টা করুন — সেখানে আসল এরর মেসেজ দেখা যাবে

### পারমিশন গেট (গুরুত্বপূর্ণ)

অ্যাপ খোলার সঙ্গে সঙ্গে সিস্টেমের **SMS পারমিশন পপ-আপ** আসে।
**অনুমতি না দেওয়া পর্যন্ত অ্যাপে ঢোকা যায় না** — পুরো স্ক্রিন ঢেকে একটা গেট দেখায়:

* **এসএমএস পড়ার অনুমতি দিন** → সিস্টেম ডায়লগ
* পপ-আপ না এলে (একবার "Deny" করলে আর আসে না) → **সেটিংসে গিয়ে অনুমতি দিন**
  → Permissions → SMS → Allow
* নোটিফিকেশন অ্যাক্সেস ঐচ্ছিক (শুধু অ্যাপের পুশ নোটিফিকেশন ধরতে লাগে)

অনুমতি দেওয়ার সঙ্গে সঙ্গে গেট সরে যায়, কনটেন্ট ও পেয়ারিং স্ক্রিন দেখা যায়।

এই APK-টি JDK 17 + Android SDK 34 + Gradle 8.6 দিয়ে `assembleDebug` চালিয়ে তৈরি
এবং `aapt`/`apksigner` দিয়ে যাচাই করা হয়েছে।

---

## নিজে বিল্ড করা

```bash
cd android
./gradlew assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
```

Gradle wrapper (`gradlew`) প্রজেক্টেই আছে — আলাদা করে Gradle ইনস্টল করতে হয় না।
অথবা **Android Studio** → *Open* → `android/` ফোল্ডার → Run।

* Kotlin 1.9.22 · AGP 8.2.2 · compileSdk 34 · minSdk 24 · JDK 17
* নির্ভরতা: `core-ktx`, `appcompat`, `work-runtime-ktx` — আর কিছু নেই

---

## Play Store-এর জন্য রিলিজ বিল্ড

রিলিজ সাইনিং `app/build.gradle.kts`-এ **আগেই বসানো আছে** — আপনাকে শুধু নিজের কী ও পাসওয়ার্ড দিতে হবে।

### ১) নিজের কী তৈরি করুন (একবারই)

```bash
cd android
keytool -genkeypair -v \
  -keystore release.keystore -alias takamatch \
  -keyalg RSA -keysize 2048 -validity 10000
```

> 🔐 `release.keystore` নিরাপদ জায়গায় **ব্যাকআপ** রাখুন। এটি হারালে Play Store-এ আর কখনো আপডেট দিতে পারবেন না। ফাইলটি `.gitignore`-এ আছে।

### ২) পাসওয়ার্ড দিন — দুইটির যেকোনো একটি

**ক) এনভায়রনমেন্ট ভ্যারিয়েবল** (ফাইলে কিছু লিখতে হয় না):

```bash
export KEYSTORE_FILE=release.keystore      # android/ সাপেক্ষে, বা absolute path
export KEYSTORE_PASSWORD='...'
export KEY_ALIAS=takamatch
export KEY_PASSWORD='...'
```

**খ) `android/keystore.properties`** (টেমপ্লেট: `keystore.properties.example`):

```properties
storeFile=release.keystore
storePassword=...
keyAlias=takamatch
keyPassword=...
```

এনভায়রনমেন্ট ভ্যারিয়েবল থাকলে সেটিই আগে ব্যবহার হয়। কিছু না দিলে বিল্ড বন্ধ হয় না — শুধু `⚠ unsigned` বার্তা দেখায় এবং আউটপুটের নাম হয় `app-release-unsigned.apk` (ইনস্টল হবে না)।

### ৩) বিল্ড

```bash
./gradlew bundleRelease     # Play-এ এটিই আপলোড করবেন (App Bundle)
./gradlew assembleRelease   # সরাসরি ইনস্টলের জন্য APK
```

* AAB → `app/build/outputs/bundle/release/app-release.aab`
* APK → `app/build/outputs/apk/release/app-release.apk`

### ৪) সাইন ঠিক আছে কিনা যাচাই

```bash
$ANDROID_HOME/build-tools/34.0.0/apksigner verify --print-certs \
  app/build/outputs/apk/release/app-release.apk
```

ফিঙ্গারপ্রিন্টে আপনার কী-এর তথ্য দেখা উচিত (ডিবাগ বিল্ডে "Android Debug" লেখা থাকে)।

### ৫) Play Console-এ

* **`.aab` ফাইল** আপলোড করুন (APK নয় — Google এখন App Bundle বাধ্যতামূলক করেছে)
* প্রথম আপলোডে **Play App Signing** চালু রাখুন — Google নিজের কী দিয়ে অ্যাপ সাইন করবে, আপনার কী শুধু "upload key"
* প্রতিটি নতুন সংস্করণে `versionCode` বাড়ান (`defaultConfig`)
* `RECEIVE_SMS` অনুমতির ব্যাখ্যা Data safety ফর্মে দিন

### মিনিফিকেশন (R8)

রিলিজ বিল্ডে ডিফল্টে **বন্ধ** (নিরাপত্তা-সম্পর্কিত অ্যাপ, রানটাইম এখানে পরীক্ষা করা যায়নি)। চালু করতে চাইলে `proguard-rules.pro`-এ দরকারি keep নিয়ম আগেই আছে।



কീস্টোর ও পাসওয়ার্ড **কখনো** রিপোতে কমিট করবেন না।

---

## চালু করার ধাপ

1. ড্যাশবোর্ডে লগইন → **ডিভাইস** → *পেয়ারিং কোড তৈরি করুন*।
2. অ্যাপ খুলুন → সার্ভারের ঠিকানা দিন (`https://pay.example.com`, শেষে `/` ছাড়া)।
3. আট-অক্ষরের কোড বসিয়ে **ডিভাইস সংযুক্ত করুন**।
   → অ্যাপটি এই মুহূর্তে নিজের **ইউনিক ডিভাইস আইডি ও API কী** পায় এবং ফোনে সংরক্ষণ করে।
   কোডটি এক-বারই কাজ করে, তাই অন্য কেউ আপনার কী পাবে না।
4. **এসএমএস অনুমতি দিন** → `RECEIVE_SMS`।
5. **নোটিফিকেশন অ্যাক্সেস চালু করুন** → Settings → Notification access → *টাকাম্যাচ রিডার*।
6. ফোনটি চালু রাখুন (ব্যাটারি অপটিমাইজেশন থেকে অ্যাপটি বাদ দিন)।

সংযুক্ত হওয়ার পর স্থিতি স্ক্রিনে ডিভাইস আইডি, সার্ভার, অপেক্ষমাণ ইভেন্ট ও
সর্বশেষ পাঠানোর সময় দেখা যায়।

---

## ভেতরে কী আছে

| ফাইল | কাজ |
|---|---|
| `MainActivity.kt` | পেয়ারিং, অনুমতি, স্থিতি, ম্যানুয়াল সিঙ্ক |
| `SmsReceiver.kt` | `SMS_RECEIVED` ব্রডকাস্ট; মাল্টি-পার্ট এসএমএস জোড়া লাগায় |
| `MfsNotificationListener.kt` | MFS অ্যাপের পুশ নোটিফিকেশন পড়ে |
| `Mfs.kt` | শর্টকোড/ব্র্যান্ড ফিল্টার (ব্যক্তিগত এসএমএস আটকে দেয়) |
| `EventQueue.kt` | ডিস্কে JSONL সারি — নেট ছাড়াও হারায় না |
| `Uploader.kt` | WorkManager + exponential backoff, `client_event_id` দিয়ে idempotent |
| `BootReceiver.kt` | রিবুটের পর কাজ আবার চালু |
| `PairingStore.kt` | ডিভাইস আইডি/কী (অ্যাপ-প্রাইভেট স্টোরেজ) |

### স্থায়িত্ব (durability)

* মেসেজ প্রথমে **ডিস্কে** লেখা হয়, তারপর পাঠানো হয় → অ্যাপ মেরে ফেললেও হারায় না।
* সার্ভার 2xx দিলে তবেই সারি থেকে মোছে; ব্যর্থ হলে WorkManager পরে আবার চেষ্টা করে।
* প্রতিটি ইভেন্টে `client_event_id` (UUID) — রিট্রাই হলেও সার্ভারে ডুপ্লিকেট ম্যাচ হয় না।
* সারি ৫০০টির বেশি হলে সবচেয়ে পুরনোটি বাদ যায় (ফোন ফুলে না ওঠার জন্য)।

---

## সাধারণ সমস্যা

| লক্ষণ | কারণ / সমাধান |
|---|---|
| `সংযোগ ব্যর্থ` | সার্ভার URL ভুল বা HTTP ব্লকড; `https://` ব্যবহার করুন |
| `সংযোগ ব্যর্থ (HTTP 409)` | পেয়ারিং কোড আগেই ব্যবহার হয়েছে — নতুন কোড নিন |
| `(HTTP 410)` | কোডের ১৫ মিনিট মেয়াদ শেষ |
| এসএমএস যাচ্ছে না | `RECEIVE_SMS` অনুমতি নেই, বা ব্যাটারি অপটিমাইজেশন অ্যাপটি ঘুম পাড়াচ্ছে |
| নোটিফিকেশন পড়ছে না | Notification access চালু হয়নি |
| `401 / 403` | ডিভাইস বাতিল হয়েছে — ড্যাশবোর্ড থেকে নতুন পেয়ারিং কোড নিন |

---

## গোপনীয়তা

অ্যাপ শুধু ১৬২৪৭ / ১৬২১৬ / ১৬১৬৭ এবং ব্র্যান্ড-নামযুক্ত মেসেজ ফরওয়ার্ড করে।
বাকি সব এসএমএস ফোনেই থাকে। সার্ভারে কাঁচা টেক্সট সংরক্ষিত থাকে অডিটের জন্য —
নিজের নিয়ন্ত্রণাধীন সার্ভারেই রাখুন।
