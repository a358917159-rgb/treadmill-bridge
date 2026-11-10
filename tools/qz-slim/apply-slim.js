#!/usr/bin/env node
/* QZ slim-build patcher for UOK E6Pro / USpbj-5610s
 *
 * Usage:
 *   node apply-slim.js --repo <qz repo dir> [--apply | --revert | --check]
 *
 * Default is --check (dry run). --apply makes backups (*.qzslim.bak) first,
 * so --revert restores byte-for-byte. All edits are idempotent.
 *
 * Design decision: DO NOT physically delete settings groups or device drivers.
 *   - settings.qml is 1.1 MB with 104 nested AccordionElements; deleting blocks
 *     risks unbalanced braces and breaks settings-catalog.json / allsettingscount.
 *   - Removing .pri entries would leave dangling symbols because bluetooth.cpp
 *     references all 166 drivers.
 * Instead we HIDE irrelevant UI groups (visual result is identical to deletion),
 * gate the BLE discovery to a whitelist, and disable non-Apple broadcast services.
 * This keeps the tree compilable and the patch reversible.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
function arg(name, def) { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; }
const REPO = path.resolve(arg('--repo', path.join(__dirname, '..', '..', 'treadmill-re', 'qz')));
const MODE = argv.includes('--apply') ? 'apply' : argv.includes('--revert') ? 'revert' : 'check';
const SLIM_DIR = __dirname;
const MARK = 'QZ-SLIM';
const BAK = '.qzslim.bak';

const report = [];
const log = s => { report.push(s); console.log(s); };
let changed = 0, errors = 0;
function fail(s) { errors++; log('  ERROR ' + s); }

function rel(p) { return path.relative(REPO, p).replace(/\\/g, '/'); }
function ensure(p) { if (!fs.existsSync(p)) { fail('missing file ' + rel(p)); return false; } return true; }
/* QZ sources are CRLF throughout. Normalise to LF for patching, then restore
 * the original style on write so the diff stays minimal and byte-predictable. */
function readTxt(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }
function writeTxt(p, txt) {
  const original = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const crlf = original.includes('\r\n');
  fs.writeFileSync(p, crlf ? txt.replace(/\n/g, '\r\n') : txt, 'utf8');
}
function backup(p) {
  const b = p + BAK;
  if (!fs.existsSync(b)) fs.writeFileSync(b, fs.readFileSync(p));
}
function restore(p) {
  const b = p + BAK;
  if (fs.existsSync(b)) { fs.writeFileSync(p, fs.readFileSync(b)); return true; }
  return false;
}

// ---------------------------------------------------------------------------
// 0. Driver files: copy verified v2 driver into the QZ tree
// ---------------------------------------------------------------------------
const DRIVER_DST = path.join(REPO, 'src', 'devices', 'henortektreadmill');
function driver() {
  const files = ['henortektreadmill.h', 'henortektreadmill.cpp'];
  if (MODE === 'revert') {
    for (const f of files) {
      const d = path.join(DRIVER_DST, f);
      if (fs.existsSync(d)) { fs.unlinkSync(d); log('  reverted (removed) ' + rel(d)); }
    }
    return;
  }
  if (MODE === 'apply') fs.mkdirSync(DRIVER_DST, { recursive: true });
  for (const f of files) {
    const s = path.join(SLIM_DIR, f), d = path.join(DRIVER_DST, f);
    if (!fs.existsSync(s)) { fail('slim driver source missing ' + f); continue; }
    const src = fs.readFileSync(s);
    const cur = fs.existsSync(d) ? fs.readFileSync(d) : null;
    if (cur && cur.equals(src)) { log('  up-to-date ' + rel(d)); continue; }
    changed++;
    log('  ' + (MODE === 'apply' ? 'WROTE  ' : 'would write  ') + rel(d) + '  (' + src.length + ' B)');
    if (MODE === 'apply') fs.writeFileSync(d, src);
  }
}

// ---------------------------------------------------------------------------
// Generic idempotent multi-edit helper
// ---------------------------------------------------------------------------
function edit(file, edits) {
  const p = path.join(REPO, file);
  if (!ensure(p)) return;
  if (MODE === 'revert') {
    if (restore(p)) { changed++; log('  reverted ' + file); }
    else log('  no backup for ' + file + ' (untouched)');
    return;
  }
  let txt = readTxt(p);
  let local = 0;
  for (const e of edits) {
    if (txt.includes(e.mark)) { log('  already applied: ' + e.name); continue; }
    if (!txt.includes(e.find)) { fail('anchor not found: ' + e.name + ' in ' + file); continue; }
    txt = txt.replace(e.find, e.replace);
    local++;
    log('  ' + (MODE === 'apply' ? 'patched ' : 'would patch ') + e.name);
  }
  if (local && MODE === 'apply') { backup(p); writeTxt(p, txt); }
  changed += local;
}

// ---------------------------------------------------------------------------
// 1. .pri — add driver to build lists (append a self-contained block at end)
// ---------------------------------------------------------------------------
const PRI_BLOCK = `
# ${MARK} BEGIN — UOK E6Pro / USpbj-5610s slim build
# Only the verified driver is added; all upstream drivers stay in the build so
# that bluetooth.cpp keeps resolving its symbols.
SOURCES += \\
    $$PWD/devices/henortektreadmill/henortektreadmill.cpp
HEADERS += \\
    $$PWD/devices/henortektreadmill/henortektreadmill.h
# ${MARK} END
`;
function pri() {
  const p = path.join(REPO, 'src', 'qdomyos-zwift.pri');
  if (!ensure(p)) return;
  if (MODE === 'revert') { if (restore(p)) { changed++; log('  reverted src/qdomyos-zwift.pri'); } return; }
  let txt = readTxt(p);
  const mark = MARK + ' BEGIN';
  if (txt.includes(mark)) { log('  already applied: pri: register henortektreadmill'); return; }
  // Append at end of file: version-number agnostic (upstream VERSION changes
  // between releases, so anchoring on "VERSION = x.y.z" is fragile on a fork).
  txt = txt.replace(/\s*$/, '\n' + PRI_BLOCK);
  changed++;
  log('  ' + (MODE === 'apply' ? 'patched ' : 'would patch ') + 'pri: register henortektreadmill (EOF append)');
  if (MODE === 'apply') { backup(p); writeTxt(p, txt); }
}

// ---------------------------------------------------------------------------
// 2. bluetooth.h — include + device pointer
// ---------------------------------------------------------------------------
function bluetoothH() {
  const p = path.join(REPO, 'src', 'devices', 'bluetooth.h');
  if (!ensure(p)) return;
  if (MODE === 'revert') { if (restore(p)) { changed++; log('  reverted src/devices/bluetooth.h'); } return; }
  let txt = readTxt(p);
  let local = 0;
  const incMark = '#include "devices/henortektreadmill/henortektreadmill.h" // ' + MARK;
  if (!txt.includes(incMark)) {
    const anchor = /#include "devices\/bluetoothdevice\.h"/;
    if (!anchor.test(txt)) fail('bluetooth.h include anchor');
    else { txt = txt.replace(anchor, m => m + '\n' + incMark); local++; log('  patched bluetooth.h include'); }
  } else log('  already applied: bluetooth.h include');
  const memMark = 'henortektreadmill *henortekTreadmill = nullptr; // ' + MARK;
  if (!txt.includes(memMark)) {
    // Insert in the private member area, right before the first 'private:' or
    // after the class opening. Use a conservative anchor.
    const m = txt.match(/(public slots:|private slots:|signals:|Q_SIGNALS:)/);
    if (!m) fail('bluetooth.h member anchor');
    else { txt = txt.replace(m[1], memMark + '\n' + m[1]); local++; log('  patched bluetooth.h member'); }
  } else log('  already applied: bluetooth.h member');
  if (local && MODE === 'apply') { backup(p); writeTxt(p, txt); }
  changed += local;
}

// ---------------------------------------------------------------------------
// 3. bluetooth.cpp — whitelist discovery: ignore every device except USPBJ
// ---------------------------------------------------------------------------
function bluetoothCpp() {
  const p = path.join(REPO, 'src', 'devices', 'bluetooth.cpp');
  if (!ensure(p)) return;
  if (MODE === 'revert') { if (restore(p)) { changed++; log('  reverted src/devices/bluetooth.cpp'); } return; }
  let txt = readTxt(p);
  let local = 0;
  const mark = MARK + ' discovery whitelist';
  if (txt.includes(mark)) { log('  already applied: bluetooth.cpp whitelist'); }
  else {
    const fn = 'void bluetooth::deviceDiscovered(const QBluetoothDeviceInfo &device) {';
    if (!txt.includes(fn)) fail('deviceDiscovered anchor');
    else {
      const gate = fn + `\n    // ${mark}\n` +
        `    // Slim build: only the UOK E6Pro / USpbj-5610s is relevant.\n` +
        `    // Skipping everything else removes the "too many devices" noise\n` +
        `    // without touching upstream driver code.\n` +
        `    if (!device.name().toUpper().startsWith(QLatin1String("USPBJ"))) {\n` +
        `        return;\n` +
        `    }\n`;
      txt = txt.replace(fn, gate);
      local++;
      log('  patched bluetooth.cpp discovery whitelist (only USPBJ)');
    }
  }
  // Register the driver branch: insert right after the whitelist gate finds a device.
  const branchMark = MARK + ' henortek branch';
  if (txt.includes(branchMark)) log('  already applied: bluetooth.cpp henortek branch');
  else {
    const anchor = '    if (!device.name().toUpper().startsWith(QLatin1String("USPBJ"))) {\n        return;\n    }\n';
    const branch = anchor +
      `    // ${branchMark}\n` +
      `    if (!henortekTreadmill) {\n` +
      `        this->setLastBluetoothDevice(device);\n` +
      `        this->stopDiscovery();\n` +
      `        henortekTreadmill = new henortektreadmill(this->pollDeviceTime, noConsole, noHeartService);\n` +
      `        emit deviceConnected(device);\n` +
      `        connect(henortekTreadmill, &bluetoothdevice::connectedAndDiscovered, this,\n` +
      `                &bluetooth::connectedAndDiscovered);\n` +
      `        connect(henortekTreadmill, &henortektreadmill::debug, this, &bluetooth::debug);\n` +
      `        connect(henortekTreadmill, &henortektreadmill::speedChanged, this, &bluetooth::speedChanged);\n` +
      `        henortekTreadmill->deviceDiscovered(device);\n` +
      `        this->signalBluetoothDeviceConnected(henortekTreadmill);\n` +
      `        return;\n` +
      `    }\n`;
    if (!txt.includes(anchor)) fail('whitelist anchor for branch');
    else { txt = txt.replace(anchor, branch); local++; log('  patched bluetooth.cpp henortek branch'); }
  }
  // Disconnect cleanup: without this, a reconnect would keep a stale pointer
  // and the whitelist branch would silently skip connecting.
  const cleanMark = MARK + ' cleanup';
  if (txt.includes(cleanMark)) log('  already applied: bluetooth.cpp cleanup');
  else {
    const cleanAnchor = '    if (speraXTreadmill) {\n\n        delete speraXTreadmill;\n        speraXTreadmill = nullptr;\n    }';
    if (!txt.includes(cleanAnchor)) fail('bluetooth.cpp cleanup anchor');
    else {
      txt = txt.replace(cleanAnchor, cleanAnchor + `\n\n    // ${cleanMark}\n    if (henortekTreadmill) {\n        delete henortekTreadmill;\n        henortekTreadmill = nullptr;\n    }`);
      local++;
      log('  patched bluetooth.cpp disconnect cleanup');
    }
  }
  if (local && MODE === 'apply') { backup(p); writeTxt(p, txt); }
  changed += local;
}

// ---------------------------------------------------------------------------
// 4. settings.qml — hide all groups except a short whitelist, add a clear
//    "UOK E6Pro" banner group at the top so the remaining settings are obvious.
// ---------------------------------------------------------------------------
const KEEP_TITLES = [
  'General Options',           // units, language, auto start/pause
  'Treadmill Options',         // treadmill-wide options
  'Heart Rate Options',        // Apple Watch HR source
  'Advanced Settings',         // virtual device name / Apple-specific
  'Experimental Features'      // contains the "Enable Virtual Device" switch
];
function settingsQml() {
  const p = path.join(REPO, 'src', 'settings.qml');
  if (!ensure(p)) return;
  if (MODE === 'revert') { if (restore(p)) { changed++; log('  reverted src/settings.qml'); } return; }
  let txt = readTxt(p);
  let local = 0;
  const mark = '// ' + MARK + ' hidden';
  // Top-level AccordionElements are indented with exactly 12 spaces; nested ones
  // (16/20/28/36) follow their parent's visibility. An `id:` line may sit between
  // the opening brace and `title:`, so we locate blocks first and then look for a
  // title within a bounded window instead of assuming adjacency.
  // Top-level blocks use exactly 12 spaces and can be AccordionElement,
  // StaticAccordionElement (holds the virtual-device switch) or NewPageElement.
  const starts = [];
  const blockRe = /^ {12}(?:AccordionElement|StaticAccordionElement|NewPageElement) \{\n/gm;
  let m;
  while ((m = blockRe.exec(txt)) !== null) starts.push({ at: m.index, insertAt: blockRe.lastIndex });
  log('  top-level groups found: ' + starts.length);
  if (starts.length < 10) fail('too few top-level groups — QML layout changed, aborting');

  const hidden = [];
  const kept = [];
  const inserts = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const end = (i + 1 < starts.length) ? starts[i + 1].at : Math.min(txt.length, s.at + 20000);
    const window = txt.slice(s.at, Math.min(end, s.at + 1200));
    const tm = window.match(/title:\s*qsTr\("([^"]*)"\)/);
    const title = tm ? tm[1] : '(untitled)';
    if (txt.slice(s.insertAt, s.insertAt + 120).includes(mark)) { kept.push(title + ' [already]'); continue; }
    if (KEEP_TITLES.some(k => title === k || title.startsWith(k))) { kept.push(title); continue; }
    inserts.push(s.insertAt);
    hidden.push(title);
  }
  // Insert from the end so earlier offsets stay valid.
  for (let i = inserts.length - 1; i >= 0; i--) {
    const pos = inserts[i];
    txt = txt.slice(0, pos) + '                visible: false  ' + mark + '\n' + txt.slice(pos);
    local++;
  }
  log('  ' + (MODE === 'apply' ? 'hidden  ' : 'would hide ') + hidden.length + ' irrelevant setting groups');
  log('  kept visible (' + kept.length + '): ' + kept.join(' | '));

  // Add an obvious banner at the top of the settings column.
  const bannerMark = '// ' + MARK + ' banner';
  if (txt.includes(bannerMark)) log('  already applied: slim banner');
  else {
    const anchor = '        ColumnLayout {\n                id: settingsContent\n';
    if (!txt.includes(anchor)) fail('settingsContent anchor');
    else {
      const banner = `            // ${bannerMark}
            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 132
                color: Material.color(Material.BlueGrey, Material.Shade800)
                radius: 6
                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: 12
                    spacing: 4
                    Label {
                        text: qsTr("UOK E6Pro / USpbj-5610s")
                        color: "white"
                        font.bold: true
                        font.pixelSize: 18
                        Layout.fillWidth: true
                    }
                    Label {
                        text: qsTr("Apple Watch / iPhone build — irrelevant device settings removed")
                        color: "white"
                        font.pixelSize: 12
                        wrapMode: Text.WordWrap
                        Layout.fillWidth: true
                    }
                    // Direct, obvious master switch for the FTMS/RSC broadcast.
                    Switch {
                        id: qzSlimVirtualDeviceSwitch
                        text: qsTr("Broadcast to Apple Watch / iPhone (FTMS + RSC)")
                        checked: settings.virtual_device_enabled
                        onToggled: settings.virtual_device_enabled = checked
                        Layout.fillWidth: true
                        contentItem: Label {
                            text: qzSlimVirtualDeviceSwitch.text
                            color: "white"
                            font.pixelSize: 13
                            wrapMode: Text.WordWrap
                            verticalAlignment: Text.AlignVCenter
                            leftPadding: qzSlimVirtualDeviceSwitch.indicator.width + 8
                        }
                    }
                }
            }

`;
      txt = txt.replace(anchor, anchor + banner);
      local++;
      log('  patched settings.qml banner');
    }
  }
  if (local && MODE === 'apply') { backup(p); writeTxt(p, txt); }
  changed += local;
}

// ---------------------------------------------------------------------------
// 5. virtualtreadmill.cpp — Apple-only broadcast services
//    KEEP: FTMS 0x1826, RSC 0x1814, Heart Rate 0x180D, Device Info 0x180A
//    DROP: Wahoo A026EE0E, Echelon 0bf669f*, Nordic DFU 0xFE59
// ---------------------------------------------------------------------------
function virtualTreadmill() {
  const p = path.join(REPO, 'src', 'virtualdevices', 'virtualtreadmill.cpp');
  if (!ensure(p)) return;
  if (MODE === 'revert') { if (restore(p)) { changed++; log('  reverted src/virtualdevices/virtualtreadmill.cpp'); } return; }
  let txt = readTxt(p);
  let local = 0;

  // (a) Force echelon mode off so no Echelon/Wahoo services are built.
  const echelonMark = MARK + ' force echelon off';
  if (txt.includes(echelonMark)) log('  already applied: echelon off');
  else {
    const anchor = '    bool echelon = settings.value(QZSettings::virtual_device_echelon, QZSettings::default_virtual_device_echelon).toBool();';
    if (!txt.includes(anchor)) fail('echelon anchor');
    else {
      txt = txt.replace(anchor, anchor + '\n    echelon = false; // ' + echelonMark);
      local++; log('  patched echelon off');
    }
  }

  // (b) Gate Wahoo / Echelon / DFU service registration with a compile-time flag.
  //     We wrap each addService call site in #if 0 blocks (safe, no symbol removal).
  const calls = [
    'serviceWahoo = leController->addService(serviceDataWahoo);',
    'serviceEchelon = leController->addService(serviceDataEchelon);',
    'serviceEchelonDFU = leController->addService(serviceDataEchelonDFU);'
  ];
  const wrapStart = '#if 0 // ' + MARK + ' non-Apple service';
  for (const c of calls) {
    if (!txt.includes(c)) {
      if (txt.includes('#endif') && txt.includes(wrapStart)) { log('  already applied: ' + c.split(' =')[0]); continue; }
      fail('addService anchor not found: ' + c); continue;
    }
    // There are TWO registration paths (initial setup + reconnect); wrap every
    // bare occurrence, preserving each line's own indentation.
    const lines = txt.split('\n');
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(c)) continue;
      if (i > 0 && lines[i - 1].includes(wrapStart)) continue; // already wrapped
      const indent = (lines[i].match(/^\s*/) || [''])[0];
      lines[i] = indent + wrapStart + '\n' + lines[i] + '\n' + indent + '#endif';
      n++;
    }
    txt = lines.join('\n');
    local += n;
    log('  disabled broadcast ' + c.split(' =')[0] + ' at ' + n + ' call site(s)');
  }

  // (c) Advertising data: drop the Echelon custom service UUID from the payload.
  const advMark = MARK + ' adv';
  if (txt.includes(advMark)) log('  already applied: advertising filter');
  else {
    const adv = '        if (echelon) {\n            services << QBluetoothUuid(QStringLiteral("0bf669f0-45f2-11e7-9598-0800200c9a66"));\n        }';
    if (txt.includes(adv)) {
      txt = txt.replace(adv, '        // ' + advMark + ': Echelon UUID removed (Apple-only build)\n        // ' + adv.replace(/\n/g, '\n        // '));
      local++; log('  patched advertising UUID list');
    } else log('  advertising UUID block not present (ok)');
  }

  // (d) Device Information: report the real treadmill instead of Wahoo Fitness.
  const disMark = MARK + ' DIS';
  if (txt.includes(disMark)) log('  already applied: DIS manufacturer');
  else {
    const man = 'manufacturerNameChar.setValue(echelon ? QByteArray("Echelon") : QByteArray("Wahoo Fitness"));';
    if (txt.includes(man)) {
      txt = txt.replace(man, 'manufacturerNameChar.setValue(QByteArray("UOK E6Pro")); // ' + disMark);
      local++; log('  patched DIS manufacturer -> UOK E6Pro');
    }
  }

  if (local && MODE === 'apply') { backup(p); writeTxt(p, txt); }
  changed += local;
}

// ---------------------------------------------------------------------------
// 6. AndroidManifest — strip permissions unrelated to BLE + Health
// ---------------------------------------------------------------------------
function manifest() {
  const p = path.join(REPO, 'src', 'android', 'AndroidManifest.xml');
  if (!ensure(p)) return;
  if (MODE === 'revert') { if (restore(p)) { changed++; log('  reverted AndroidManifest.xml'); } return; }
  let txt = readTxt(p);
  const mark = '<!-- ' + MARK + ' -->';
  if (txt.includes(mark)) { log('  already applied: manifest'); return; }
  const drop = [
    'com.android.vending.BILLING',
    'android.permission.SYSTEM_ALERT_WINDOW',
    'com.google.android.things.permission.USE_PERIPHERAL_IO',
    'android.permission.GET_TASKS',
    'android.permission.PACKAGE_USAGE_STATS',
    'android.permission.ACCESS_CHECKIN_PROPERTIES',
    'android.permission.MODIFY_AUDIO_SETTINGS'
  ];
  let local = 0;
  for (const d of drop) {
    const re = new RegExp('^\\s*<uses-permission[^>]*' + d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^>]*/>\\s*\\r?\\n', 'm');
    if (re.test(txt)) { txt = txt.replace(re, ''); local++; log('  removed permission ' + d); }
  }
  if (local) {
    txt = txt.replace('<manifest', mark + '\n<manifest');
    changed += local;
    if (MODE === 'apply') { backup(p); writeTxt(p, txt); }
  }
  if (!local) log('  no manifest permissions matched (ok)');
}

// ---------------------------------------------------------------------------
function main() {
  log('# QZ slim patcher — mode=' + MODE + '  repo=' + REPO);
  if (!fs.existsSync(REPO)) { console.error('repo not found: ' + REPO); process.exit(2); }
  driver();
  pri();
  bluetoothH();
  bluetoothCpp();
  settingsQml();
  virtualTreadmill();
  manifest();
  log('');
  log('CHANGES=' + changed + '  ERRORS=' + errors);
  if (MODE === 'check') log('Dry run only. Re-run with --apply to write (backups created), --revert to undo.');
  if (MODE === 'apply' && errors === 0) log('Patch applied. Backups are *' + BAK + ' files next to each source.');
  process.exitCode = errors ? 1 : 0;
}
main();
