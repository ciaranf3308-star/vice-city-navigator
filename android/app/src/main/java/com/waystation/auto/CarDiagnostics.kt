package com.waystation.auto

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * File-based diagnostics for the car path.
 *
 * Play vitals can never see the failures that matter here: template
 * exceptions are marshalled back to the car host over Binder, so the app
 * process survives and no crash report is generated. The app therefore
 * keeps its own log: timestamped events plus full stack traces, capped at
 * 512KB with a single .bak rotation.
 *
 * Retrieve: on the phone, Files app -> Internal storage -> Android -> data
 * -> com.waystation.auto -> files -> waystation-diagnostics.log, then share
 * it (Drive, mail, …). Never throws — logging must not break the thing it
 * observes.
 */
object CarDiagnostics {
    private const val TAG = "WayStationDiag"
    private const val FILE_NAME = "waystation-diagnostics.log"
    private const val MAX_BYTES = 512L * 1024L
    private val dateFmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)

    private fun logFile(context: Context): File? {
        return try {
            val dir = context.getExternalFilesDir(null) ?: context.filesDir
            File(dir, FILE_NAME)
        } catch (e: Exception) {
            null
        }
    }

    @Synchronized
    fun log(context: Context, event: String, t: Throwable? = null) {
        try {
            val file = logFile(context) ?: return
            rotateIfNeeded(file)
            val sb = StringBuilder()
            sb.append('[').append(dateFmt.format(Date())).append("] ")
                .append(event).append('\n')
            if (t != null) {
                sb.append(Log.getStackTraceString(t).trimEnd()).append('\n')
            }
            file.appendText(sb.toString())
        } catch (e: Exception) {
            // diagnostics must never break the app
        }
    }

    /** One-line build/device header, written once per process start. */
    @Synchronized
    fun header(context: Context) {
        try {
            val pm = context.packageManager
            val pkg = context.packageName
            val info = if (Build.VERSION.SDK_INT >= 33) {
                pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(pkg, 0)
            }
            @Suppress("DEPRECATION")
            val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode
            else info.versionCode.toLong()
            log(
                context,
                "=== WayStation diagnostics start: v${info.versionName} " +
                    "($code), Android ${Build.VERSION.RELEASE} " +
                    "(SDK ${Build.VERSION.SDK_INT}), " +
                    "${Build.MANUFACTURER} ${Build.MODEL} ==="
            )
        } catch (e: Exception) {
            // best effort
        }
    }

    private fun rotateIfNeeded(file: File) {
        try {
            if (file.exists() && file.length() > MAX_BYTES) {
                val bak = File(file.parent, "$FILE_NAME.bak")
                if (bak.exists()) bak.delete()
                file.renameTo(bak)
            }
        } catch (e: Exception) {
            // best effort
        }
    }
}
