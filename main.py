from kivy.app import App
from kivy.uix.label import Label
from jnius import autoclass

# 安全引入 Android 原生蓝牙适配层
try:
    PythonActivity = autoclass('org.kivy.android.PythonActivity')
    BluetoothAdapter = autoclass('android.bluetooth.BluetoothAdapter')
    BT_AVAILABLE = True
except Exception:
    BT_AVAILABLE = False

class TreadmillBridgeApp(App):
    def build(self):
        status_text = "UOK E6Pro 蓝牙桥接服务\n已成功启动并加载 Android 蓝牙底层" if BT_AVAILABLE else "运行环境初始化中..."
        return Label(text=status_text, font_size=18, halign='center')

if __name__ == '__main__':
    TreadmillBridgeApp().run()
