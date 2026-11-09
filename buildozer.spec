[app]
title = TreadmillBridge
package.name = treadmillbridge
package.domain = org.bridge
source.include_exts = py,png,jpg,kv,atlas
source.dir = .
version = 0.1
requirements = python3,kivy,pyjnius,bleak
android.permissions = BLUETOOTH,BLUETOOTH_ADMIN,BLUETOOTH_CONNECT,BLUETOOTH_SCAN,ACCESS_FINE_LOCATION,ACCESS_COARSE_LOCATION
android.api = 33
android.minapi = 21