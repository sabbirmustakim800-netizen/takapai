# WorkManager
-keep class androidx.work.** { *; }
-keepclassmembers class * extends androidx.work.ListenableWorker { *; }

# BroadcastReceiver / NotificationListenerService গুলো manifest থেকে ইনস্ট্যানশিয়েট হয়
-keep class bd.takamatch.reader.SmsReceiver { *; }
-keep class bd.takamatch.reader.BootReceiver { *; }
-keep class bd.takamatch.reader.MfsNotificationListener { *; }

-keepattributes *Annotation*
