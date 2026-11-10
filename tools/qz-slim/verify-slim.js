#!/usr/bin/env node
/* Structural verification of the slim patch (no compiler needed).
 * Checks: brace balance (C++/QML/XML), idempotence marks, broadcast service
 * whitelist, discovery whitelist, and that every patched file has a backup.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'treadmill-re', 'qz'));
let pass = true;
function chk(n, c, x) { if (!c) pass = false; console.log((c ? 'PASS  ' : 'FAIL  ') + n + (x ? ' :: ' + x : '')); }
function read(f) { const p = path.join(REPO, f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : null; }

// Strip // and /* */ comments and string literals before counting braces.
function braceBalance(src) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  s = s.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''");
  let n = 0, min = 0;
  for (const c of s) { if (c === '{') n++; else if (c === '}') { n--; if (n < min) min = n; } }
  return { net: n, min };
}

const qml = read('src/settings.qml');
chk('settings.qml 存在', !!qml);
if (qml) {
  // A naive stripper mis-reads QML JS template literals / regexes, so the
  // absolute count is not meaningful. Compare against the untouched backup:
  // what matters is that the patch did not change the balance at all.
  const bakPath = path.join(REPO, 'src/settings.qml.qzslim.bak');
  const base = fs.existsSync(bakPath) ? fs.readFileSync(bakPath, 'utf8').replace(/\r\n/g, '\n') : null;
  const b = braceBalance(qml), bb = base ? braceBalance(base) : null;
  chk('QML 花括号平衡未因补丁改变', !!bb && b.net === bb.net && b.min === bb.min,
      'orig=' + (bb ? bb.net + '/' + bb.min : '?') + ' patched=' + b.net + '/' + b.min);
  chk('隐藏了 16 个无关设置组', (qml.match(/visible: false  \/\/ QZ-SLIM hidden/g) || []).length === 16,
      'count=' + (qml.match(/visible: false  \/\/ QZ-SLIM hidden/g) || []).length);
  chk('顶部醒目横幅已注入', qml.includes('qzSlimVirtualDeviceSwitch') && qml.includes('UOK E6Pro / USpbj-5610s'));
  chk('虚拟设备主开关绑定正确', qml.includes('checked: settings.virtual_device_enabled') &&
      qml.includes('onToggled: settings.virtual_device_enabled = checked'));
  chk('保留 General/Treadmill/HR/Advanced/Experimental',
      !/General Options"\)[\s\S]{0,200}visible: false  \/\/ QZ-SLIM hidden/.test(qml));
  chk('虚拟设备开关未被隐藏', (() => {
    const i = qml.indexOf('title: qsTr("Experimental Features")');
    return i > 0 && !qml.slice(i - 200, i).includes('visible: false  // QZ-SLIM hidden');
  })());
}

const pri = read('src/qdomyos-zwift.pri');
chk('.pri 注册驱动', !!pri && pri.includes('devices/henortektreadmill/henortektreadmill.cpp') &&
    pri.includes('devices/henortektreadmill/henortektreadmill.h'));
chk('.pri 未破坏 VERSION', !!pri && pri.includes('VERSION = 2.22.0'));

const bh = read('src/devices/bluetooth.h');
chk('bluetooth.h include + 成员', !!bh && bh.includes('henortektreadmill.h" // QZ-SLIM') &&
    bh.includes('henortektreadmill *henortekTreadmill = nullptr; // QZ-SLIM'));
if (bh) { const b = braceBalance(bh); chk('bluetooth.h 花括号平衡', b.net === 0 && b.min === 0, 'net=' + b.net); }

const bc = read('src/devices/bluetooth.cpp');
chk('发现白名单只留 USPBJ', !!bc && bc.includes('!device.name().toUpper().startsWith(QLatin1String("USPBJ"))'));
chk('henortek 分支已注册', !!bc && bc.includes('new henortektreadmill('));
if (bc) { const b = braceBalance(bc); chk('bluetooth.cpp 花括号平衡', b.net === 0 && b.min === 0, 'net=' + b.net + ' min=' + b.min); }

const vt = read('src/virtualdevices/virtualtreadmill.cpp');
chk('FTMS/RSC/HR 服务保留', !!vt && vt.includes('0x1826') && vt.includes('RunningSpeedAndCadence') && vt.includes('serviceHR'));
// Two registration paths (initial setup + reconnect) x 3 legacy services = 6.
chk('Wahoo/Echelon/DFU 广播已禁用（6 处调用）', !!vt &&
    (vt.match(/#if 0 \/\/ QZ-SLIM non-Apple service/g) || []).length === 6,
    'count=' + (vt.match(/#if 0 \/\/ QZ-SLIM non-Apple service/g) || []).length);
// Preprocessor nesting must return to the original level (0/0). The upstream
// file has #else/#elif branches, so counting raw #endif lines is misleading.
function ppNet(t) {
  let d = 0, min = 0;
  for (const l of t.split(/\r?\n/)) {
    if (/^\s*#\s*(if|ifdef|ifndef)\b/.test(l)) d++;
    else if (/^\s*#\s*endif\b/.test(l)) { d--; if (d < min) min = d; }
  }
  return d + '/' + min;
}
const vtBak = path.join(REPO, 'src/virtualdevices/virtualtreadmill.cpp.qzslim.bak');
const ppBase = fs.existsSync(vtBak) ? ppNet(fs.readFileSync(vtBak, 'utf8')) : null;
chk('预处理指令嵌套平衡未改变', !!vt && ppNet(vt) === ppBase,
    'orig=' + ppBase + ' patched=' + (vt ? ppNet(vt) : '?'));
chk('echelon 强制关闭', !!vt && vt.includes('echelon = false; // QZ-SLIM'));
chk('DIS 厂商改为 UOK E6Pro', !!vt && vt.includes('QByteArray("UOK E6Pro")'));
if (vt) { const b = braceBalance(vt); chk('virtualtreadmill.cpp 花括号平衡', b.net === 0 && b.min === 0, 'net=' + b.net + ' min=' + b.min); }

const man = read('src/android/AndroidManifest.xml');
chk('AndroidManifest 保留 BLE 权限', !!man && man.includes('BLUETOOTH_SCAN') &&
    man.includes('BLUETOOTH_CONNECT') && man.includes('BLUETOOTH_ADVERTISE'));
chk('移除内购/悬浮窗等无关权限', !!man && !man.includes('com.android.vending.BILLING') &&
    !man.includes('SYSTEM_ALERT_WINDOW'));
chk('AndroidManifest XML 标签平衡', !!man && (man.match(/<manifest/g) || []).length === (man.match(/<\/manifest>/g) || []).length);

const drv = read('src/devices/henortektreadmill/henortektreadmill.cpp');
chk('驱动按定稿协议订阅 FEC8', !!drv && drv.includes('0xFEE7') && drv.includes('CMD_SUMMARY'));
chk('驱动零 BLE 写入（无 writeCharacteristic 调用）', !!drv &&
    !/writeCharacteristic\s*\(\s*gattWriteCharacteristic/.test(drv) &&
    !/gattCommunicationChannelService->writeCharacteristic/.test(drv));
chk('驱动无 0x11 心跳逻辑（仅注释提及）', !!drv &&
    !/heartbeat\s*=/i.test(drv) && !/sendControl\(/.test(drv));
chk('驱动含上行同步状态机', !!drv && drv.includes('beginSessionIfNeeded') && drv.includes('pauseSessionIfNeeded'));
if (drv) { const b = braceBalance(drv); chk('驱动花括号平衡', b.net === 0 && b.min === 0, 'net=' + b.net + ' min=' + b.min); }

const backups = ['src/settings.qml', 'src/qdomyos-zwift.pri', 'src/devices/bluetooth.h',
                 'src/devices/bluetooth.cpp', 'src/virtualdevices/virtualtreadmill.cpp',
                 'src/android/AndroidManifest.xml'];
chk('6 个被改文件均有备份', backups.every(f => fs.existsSync(path.join(REPO, f + '.qzslim.bak'))));

console.log(pass ? 'SLIM_VERIFY_PASS=True' : 'SLIM_VERIFY_PASS=False');
process.exitCode = pass ? 0 : 1;
