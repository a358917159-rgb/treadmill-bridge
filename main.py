import asyncio
from bleak import BleakClient, BleakScanner

TARGET_NAME = "USpbj-5610S"

def notification_handler(sender, data):
    # 实时捕获 0xFFB0 串口透传的原始数据
    hex_data = data.hex().upper()
    print(f"[收到跑步机数据] HEX: {hex_data}")

async def main():
    print(f"正在搜索跑步机: {TARGET_NAME} ...")
    device = await BleakScanner.find_device_by_name(TARGET_NAME, timeout=15.0)
    
    if not device:
        print("未找到跑步机，请确认已通电。")
        return

    print(f"找到设备 {device.address}，正在连接...")
    async with BleakClient(device) as client:
        print("连接成功！正在监听 0xFFB0 通道...")
        for service in client.services:
            if "ffb0" in service.uuid.lower():
                for char in service.characteristics:
                    if "notify" in char.properties:
                        await client.start_notify(char.uuid, notification_handler)
                        print(f"成功绑定特征值: {char.uuid}")
                        
        while True:
            await asyncio.sleep(1)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"异常: {e}")