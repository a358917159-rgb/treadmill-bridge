[app]

title = TreadmillBridge
package.name = treadmillbridge
package.domain = org.bridge
source.include_exts = py,png,jpg,kv,atlas
source.dir = .
version = 0.1

# 移除无法编译的 bleak，保留核心 kivy 和底层蓝牙桥接库 pyjnius
requirements = python3,kivy,pyjnius

orientation = portrait

android.permissions = BLUETOOTH,BLUETOOTH_ADMIN,BLUETOOTH_CONNECT,BLUETOOTH_SCAN,ACCESS_FINE_LOCATION,ACCESS_COARSE_LOCATION

android.api = 33
android.minapi = 21
fullscreen = 0

[buildozer]
log_level = 2
warn_on_root = 1
