package com.bridge.treadmill

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

class TreadmillService : Service() {
    private val TAG = "TreadmillBridge"
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        // 获取电源锁，防止手机休眠切断蓝牙
        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Treadmill::WakeLock").apply {
            acquire(10 * 60 * 60 * 1000L) // 最多保持 10 小时
        }
        startForeground(1, createNotification())
        Log.i(TAG, "前台桥接服务已启动，CPU 唤醒锁已生效")
    }

    private fun createNotification(): Notification {
        val channelId = "treadmill_bridge_channel"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(channelId, "跑步机桥接服务", NotificationManager.IMPORTANCE_LOW)
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }

        return NotificationCompat.Builder(this, channelId)
            .setContentTitle("UOK E6Pro 蓝牙桥接中")
            .setContentText("后台持续监听 0xFFB0 通道，防杀进程中...")
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .build()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 在这里执行你的蓝牙扫描、连接 USpbj-5610S 及 0xFFB0 数据解析逻辑
        // 原生 Kotlin 可以直接调用 Android 原生 BluetoothGatt 进行高性能、低功耗通信
        return START_STICKY // 如果被系统意外杀死，自动重启服务
    }

    override fun onDestroy() {
        super.onDestroy()
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
