[app]

title = TreadmillBridge
package.name = treadmillbridge
package.domain = org.bridge
source.include_exts = py,png,jpg,kv,atlas
source.dir = .
version = 0.1

requirements = python3,kivy,pyjnius

orientation = portrait

android.permissions = BLUETOOTH,BLUETOOTH_ADMIN,BLUETOOTH_CONNECT,BLUETOOTH_SCAN,ACCESS_FINE_LOCATION,ACCESS_COARSE_LOCATION

android.api = 33
android.minapi = 21

# 关键：允许云端自动接受 Android SDK 协议，防止编译被强制中止
android.accept_sdk_license = True

fullscreen = 0

[buildozer]
log_level = 2
warn_on_root = 1
