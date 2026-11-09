[app]

# (str) Title of your application
title = TreadmillBridge

# (str) Package name
package.name = treadmillbridge

# (str) Package domain (needed for android packaging)
package.domain = org.bridge

# (list) Source files to include (let it include python files)
source.include_exts = py,png,jpg,kv,atlas

# (list) Source directory
source.dir = .

# (str) Application versioning
version = 0.1

# (list) Application requirements
# 必须包含 python3, kivy, pyjnius, async-timeout 和 bleak
requirements = python3,kivy,pyjnius,async-timeout,bleak

# (list) Supported orientations
orientation = portrait

# (list) Permissions
# 蓝牙扫描、连接及精确定位权限（Android 12+ 蓝牙扫描必需）
android.permissions = BLUETOOTH,BLUETOOTH_ADMIN,BLUETOOTH_CONNECT,BLUETOOTH_SCAN,ACCESS_FINE_LOCATION,ACCESS_COARSE_LOCATION

# (int) Target Android API, should be as high as possible.
android.api = 33

# (int) Minimum API your APK will support.
android.minapi = 21

# (bool) Indicate if the application should be fullscreen or not
fullscreen = 0

# (string) Presplash background color
# android.presplash_color = #FFFFFF

[buildozer]

# (int) Log level (0 = error, 1 = info, 2 = debug (with command output))
log_level = 2

# (int) Display warning if buildozer is run as root (0 = False, 1 = True)
warn_on_root = 1
