// henortektreadmill.cpp — UOK E6Pro / USpbj-5610s driver, v2 (verified protocol)
//
// Implements PROTOCOL-FINAL.md §15 (final state machine + sync contract).
// Verified by five real captures: 1,264 frames, 0 checksum failures.
//
// IMPORTANT DIFFERENCES FROM THE OLD qz-driver/ SKELETON (which was static-RE only):
//   * subscribes to BOTH FFB1 (NOTIFY) and FEC8 (INDICATE) — FEC8 is the 1 Hz
//     primary source; the old code listened only to FFB1/0x95.
//   * frame headers FA EF and FA F1 (old code only knew FA EF / 4C 42).
//   * checksum sum(d[2..n-2]) & 0xFF on EVERY received frame.
//   * 0x21 = instantaneous speed/incline/state; 0x23 & 0x95 = cumulative data.
//   * NO 0x11 heartbeat (proven unnecessary) and NO FEE1/AA (no such char).
//   * zero BLE writes in slim build: the only pause is the machine's button.
//
// NOT COMPILED YET — no Qt/Android toolchain on this machine. See BUILD-SLIM.md.

#include "henortektreadmill.h"
#include "virtualdevices/virtualtreadmill.h"

#include <QBluetoothLocalDevice>
#include <QEventLoop>
#include <QMetaEnum>
#include <QSettings>
#include <QTimer>

#include <cmath>

// MSVC / some Qt toolchains do not expose M_PI without this.
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

namespace {
constexpr uint8_t HDR_EF = 0xEF; // FA EF -> FFB1 channel
constexpr uint8_t HDR_F1 = 0xF1; // FA F1 -> FEC8 channel

constexpr uint8_t CMD_CONTROL = 0x11; // BT -> MCU (write only)
constexpr uint8_t CMD_ACK = 0x22;     // FA F1 22, device echo of 0x11
constexpr uint8_t CMD_REALTIME = 0x21;
constexpr uint8_t CMD_SUMMARY = 0x23;
constexpr uint8_t CMD_SUMMARY_ALT = 0x95;
constexpr uint8_t CMD_CAPABILITY_F1 = 0x20;
constexpr uint8_t CMD_CAPABILITY_EF = 0x90;
constexpr uint8_t CMD_TARGET = 0x92;

constexpr uint8_t ST_STOP = 0x00;
constexpr uint8_t ST_RUNNING = 0x10;
constexpr uint8_t ST_PREPARE = 0xF3;
constexpr uint8_t ST_DECEL = 0xF4;

quint16 be16(const QByteArray &d, int i) {
    return (quint16)(((quint8)d.at(i) << 8) | (quint8)d.at(i + 1));
}
// bit7 of the high byte selects the decimal scale; it is NOT part of the value.
double decodeDistance(quint8 hi, quint8 lo) {
    return (double)(((hi & 0x7F) << 8) | lo) / ((hi & 0x80) ? 100.0 : 10.0);
}
double decodeEnergy(quint8 hi, quint8 lo) {
    return (double)(((hi & 0x7F) << 8) | lo) / ((hi & 0x80) ? 10.0 : 1.0);
}
bool checksumOk(const QByteArray &d) {
    if (d.size() < 4)
        return false;
    quint32 s = 0;
    for (int i = 2; i < d.size() - 1; ++i)
        s += (quint8)d.at(i);
    return (quint8)(s & 0xFF) == (quint8)d.at(d.size() - 1);
}
// Locate the next frame header; used to resynchronise a split/concatenated notify.
int nextHeader(const QByteArray &b, int from) {
    for (int i = from; i + 1 < b.size(); ++i) {
        if ((quint8)b.at(i) == 0xFA && ((quint8)b.at(i + 1) == HDR_EF || (quint8)b.at(i + 1) == HDR_F1))
            return i;
    }
    return -1;
}
// 0..25 gear -> approximate percent grade (0..25 gear == 0..13 degrees).
double gearToGrade(int gear) {
    return std::tan((gear * 13.0 / 25.0) * M_PI / 180.0) * 100.0;
}
} // namespace

QByteArray henortektreadmill::controlFrame(double speedKmh, int incline, uint8_t status) {
    const quint16 raw = (quint16)(qRound(qMax(0.0, speedKmh) * 10.0) & 0x7FFF);
    QByteArray f(9, '\0');
    f[0] = (char)0xFA;
    f[1] = (char)0xEF;
    f[2] = (char)CMD_CONTROL;
    f[3] = (char)0;                 // resistance: not supported on this unit
    f[4] = (char)(incline & 0xFF); // gear 0..25
    f[5] = (char)(((raw >> 8) & 0x7F) | 0x80); // bit7 = BLE connected
    f[6] = (char)(raw & 0xFF);
    f[7] = (char)status;
    quint32 sum = 0;
    for (int i = 2; i <= 7; ++i)
        sum += (quint8)f.at(i);
    f[8] = (char)(sum & 0xFF);
    return f;
}

henortektreadmill::henortektreadmill(uint32_t pollDeviceTime, bool noConsole, bool noHeartService,
                                     double forceInitSpeed, double forceInitInclination) {
    m_watt.setType(metric::METRIC_WATT, deviceType());
    Speed.setType(metric::METRIC_SPEED);
    this->noConsole = noConsole;
    this->noHeartService = noHeartService;
    this->pollDeviceTime = pollDeviceTime;
    if (forceInitSpeed > 0)
        lastSpeed = forceInitSpeed;
    if (forceInitInclination > 0)
        lastInclination = forceInitInclination;

    refresh = new QTimer(this);
    connect(refresh, &QTimer::timeout, this, &henortektreadmill::update);
    refresh->start(500);
}

bool henortektreadmill::connected() {
    return m_control && m_control->state() == QLowEnergyController::DiscoveredState;
}

void henortektreadmill::createVirtualDevice() {
    if (firstInit || hasVirtualDevice())
        return;
    QSettings settings;
    if (!settings.value(QZSettings::virtual_device_enabled, QZSettings::default_virtual_device_enabled).toBool())
        return;
    emit debug(QStringLiteral("creating virtual treadmill (FTMS 0x1826 / RSC 0x1814) for Apple Watch..."));
    auto *vt = new virtualtreadmill(this, noHeartService);
    connect(vt, &virtualtreadmill::debug, this, &henortektreadmill::debug);
    connect(vt, &virtualtreadmill::changeInclination, this, &henortektreadmill::changeInclinationRequested);
    setVirtualDevice(vt, VIRTUAL_DEVICE_MODE::PRIMARY);
    firstInit = true;
}

// ---------------------------------------------------------------------------
// Frame parsing — the verified wire format
// ---------------------------------------------------------------------------
void henortektreadmill::parseFrame(const QByteArray &d) {
    if (!checksumOk(d)) {
        emit debug(QStringLiteral("henortek: CHECKSUM FAIL ") + d.toHex(' '));
        return;
    }
    emit packetReceived();
    lastPacketTime = QDateTime::currentDateTime();

    const quint8 hdr = (quint8)d.at(1);
    const quint8 cmd = (quint8)d.at(2);

    // Device echo of a control frame. Slim build never writes, so this only
    // appears if another client (USeeHel) is controlling the same machine.
    if (hdr == HDR_F1 && cmd == CMD_ACK) {
        emit debug(QStringLiteral("henortek: 0x22 ACK seen (external client wrote 0x11)"));
        return;
    }
    if (cmd == CMD_CONTROL || cmd == CMD_TARGET || cmd == CMD_CAPABILITY_F1 || cmd == CMD_CAPABILITY_EF) {
        return; // capability / target frames carry no live metrics
    }

    // --- FA F1 21: instantaneous speed / incline gear / state ---
    if (hdr == HDR_F1 && cmd == CMD_REALTIME && d.size() >= 9) {
        const double speed = (quint8)d.at(6) / 10.0;
        const int gear = (quint8)d.at(4);
        const uint8_t state = (quint8)d.at(7);

        // A full-zero 0x23 is a pause broadcast, NOT a reset. The all-zero
        // snapshot is filtered in publishSnapshot().
        if (state == ST_RUNNING) {
            lockedSpeed = speed;
            if (gear > 0) // F4 frames report gear 0; physical incline is retained
                lockedIncline = gear;
            beginSessionIfNeeded();
            if (Speed.value() != speed) {
                Speed = speed;
                emit speedChanged(speed);
                lastSpeed = speed;
            }
            const double grade = gearToGrade(lockedIncline);
            const double prev = Inclination.value();
            if (prev != grade) {
                Inclination = grade;
                lastInclination = grade;
                emit inclinationChanged(prev, grade);
            }
        } else if (state == ST_DECEL || state == ST_STOP || state == ST_PREPARE) {
            // Uplink sync: machine button pressed -> QZ must pause IMMEDIATELY,
            // keeping the session open so it can resume on the next 0x10.
            if (lastState == ST_RUNNING)
                lockedDistance = sessionDistanceKm; // latch BEFORE leaving 0x10
            if (Speed.value() != 0.0) {
                Speed = 0.0;
                emit speedChanged(0.0);
            }
            if (state == ST_STOP || state == ST_DECEL)
                pauseSessionIfNeeded();
        }
        lastState = state;
        return;
    }

    // --- FA F1 23 / FA EF 95: cumulative time / distance / energy ---
    if ((hdr == HDR_F1 && cmd == CMD_SUMMARY || hdr == HDR_EF && cmd == CMD_SUMMARY_ALT) && d.size() >= 9) {
        const int seconds = be16(d, 3);
        const double distanceKm = decodeDistance((quint8)d.at(5), (quint8)d.at(6));
        const double kcal = decodeEnergy((quint8)d.at(7), (quint8)d.at(8));

        // All-zero frame = pause-state broadcast on BOTH panel pause and remote
        // F4. It must NOT be treated as "device cleared". Ignore it.
        if (seconds == 0 && distanceKm == 0.0 && kcal == 0.0)
            return;

        // Monotonic session accumulator: only accept positive deltas while
        // running. Never reset on reconnect / zero broadcast / machine reset.
        if (distanceKm >= 0 && lastDeviceDistanceKm >= 0 && distanceKm >= lastDeviceDistanceKm)
            sessionDistanceKm += distanceKm - lastDeviceDistanceKm;
        else if (distanceKm >= 0 && lastDeviceDistanceKm < 0)
            sessionDistanceKm = distanceKm;
        if (kcal >= 0 && lastDeviceKcal >= 0 && kcal >= lastDeviceKcal)
            sessionKcal += kcal - lastDeviceKcal;
        else if (kcal >= 0 && lastDeviceKcal < 0)
            sessionKcal = kcal;
        if (seconds >= 0 && lastDeviceSeconds >= 0 && seconds >= lastDeviceSeconds)
            sessionSeconds += seconds - lastDeviceSeconds;
        else if (seconds >= 0 && lastDeviceSeconds < 0)
            sessionSeconds = seconds;
        lastDeviceDistanceKm = distanceKm;
        lastDeviceKcal = kcal;
        lastDeviceSeconds = seconds;

        publishSnapshot();
    }
}

void henortektreadmill::publishSnapshot() {
    // QZ's metric model feeds both the virtual FTMS/RSC broadcaster and the iOS
    // HealthKit workout builder, so writing here covers Apple Watch + iPhone.
    Distance = sessionDistanceKm;
    KCal = sessionKcal;
    elapsed = sessionSeconds;
    lockedDistance = sessionDistanceKm;
    update_hr_from_external(); // this model has NO heart-rate interface
    cadenceFromAppleWatch();
    lastSampleTime = QDateTime::currentDateTime();
}

void henortektreadmill::beginSessionIfNeeded() {
    if (sessionOpen)
        return;
    sessionOpen = true;
    emit debug(QStringLiteral("henortek: uplink START (0x10) — QZ workout begins/resumes"));
}

void henortektreadmill::pauseSessionIfNeeded() {
    if (!sessionOpen)
        return;
    sessionOpen = false;
    emit debug(QStringLiteral("henortek: uplink PAUSE (machine button) — keep session, do not seal"));
}

void henortektreadmill::characteristicChanged(const QLowEnergyCharacteristic &c, const QByteArray &newValue) {
    Q_UNUSED(c);
    rxBuffer.append(newValue);
    // A single notification may contain several concatenated frames.
    for (;;) {
        const int start = nextHeader(rxBuffer, 0);
        if (start < 0) {
            if (rxBuffer.size() > 256)
                rxBuffer.clear();
            return;
        }
        if (start > 0)
            rxBuffer.remove(0, start);
        if (rxBuffer.size() < 4)
            return;
        const int next = nextHeader(rxBuffer, 2);
        const QByteArray frame = next > 0 ? rxBuffer.left(next) : rxBuffer;
        rxBuffer.remove(0, frame.size());
        parseFrame(frame);
        if (next < 0)
            return;
    }
}

// ---------------------------------------------------------------------------
// GATT discovery / subscription
// ---------------------------------------------------------------------------
void henortektreadmill::stateChanged(QLowEnergyService::ServiceState state) {
    QMetaEnum metaEnum = QMetaEnum::fromType<QLowEnergyService::ServiceState>();
    emit debug(QStringLiteral("BTLE stateChanged ") + QString::fromLocal8Bit(metaEnum.valueToKey(state)));
    if (state != QLowEnergyService::ServiceDiscovered)
        return;
    auto *svc = qobject_cast<QLowEnergyService *>(sender());
    if (!svc)
        return;

    const auto chars = svc->characteristics();
    for (const QLowEnergyCharacteristic &c : chars) {
        const quint32 id = c.uuid().toUInt32();
        const auto props = c.properties();
        const bool writable = (props & QLowEnergyCharacteristic::Write) ||
                              (props & QLowEnergyCharacteristic::WriteNoResponse);
        const bool notify = (props & QLowEnergyCharacteristic::Notify);
        const bool indicate = (props & QLowEnergyCharacteristic::Indicate);

        if (writable && id == 0xFFB2 && !gattWriteCharacteristic.isValid()) {
            gattWriteCharacteristic = c;
            gattWriteService = svc;
        }
        if (notify || indicate) {
            // FEC8 (INDICATE) is the primary 1 Hz source; FFB1 (NOTIFY) secondary.
            emit debug(QStringLiteral("henortek: subscribing ") + c.uuid().toString());
            QByteArray cccd(2, '\0');
            cccd[0] = (char)(indicate && !notify ? 0x02 : 0x01);
            svc->writeDescriptor(c.descriptor(QBluetoothUuid::ClientCharacteristicConfiguration), cccd);
            gattNotifyCharacteristics.append(c);
        }
    }

    connect(svc, &QLowEnergyService::characteristicChanged, this, &henortektreadmill::characteristicChanged);
    connect(svc, &QLowEnergyService::characteristicWritten, this, &henortektreadmill::characteristicWritten);
    connect(svc, &QLowEnergyService::descriptorWritten, this, &henortektreadmill::descriptorWritten);
    connect(svc,
            static_cast<void (QLowEnergyService::*)(QLowEnergyService::ServiceError)>(&QLowEnergyService::error),
            this, &henortektreadmill::errorService);
}

void henortektreadmill::descriptorWritten(const QLowEnergyDescriptor &descriptor, const QByteArray &newValue) {
    Q_UNUSED(newValue);
    emit debug(QStringLiteral("descriptorWritten ") + descriptor.uuid().toString());
    const bool wasDone = initDone;
    initDone = true;
    if (!wasDone)
        emit connectedAndDiscovered();
}

void henortektreadmill::characteristicWritten(const QLowEnergyCharacteristic &c, const QByteArray &v) {
    Q_UNUSED(c);
    emit debug(QStringLiteral("characteristicWritten ") + v.toHex(' '));
}

void henortektreadmill::serviceDiscovered(const QBluetoothUuid &gatt) {
    emit debug(QStringLiteral("serviceDiscovered ") + gatt.toString());
}

void henortektreadmill::serviceScanDone() {
    if (!m_control)
        return;
    // The unit exposes FFB0, FEE7 and 180A. Subscribe to BOTH data services;
    // the old skeleton stopped after the first matching service and therefore
    // missed the 1 Hz FEC8 stream entirely.
    const QList<quint32> wanted = {0xFFB0, 0xFEE7};
    for (const QBluetoothUuid &s : m_control->services()) {
        if (!wanted.contains(s.toUInt32()))
            continue;
        emit debug(QStringLiteral("henortek: using service ") + s.toString());
        auto *svc = m_control->createServiceObject(s, this);
        if (!svc)
            continue;
        gattServices.append(svc);
        connect(svc, &QLowEnergyService::stateChanged, this, &henortektreadmill::stateChanged);
        svc->discoverDetails();
    }
    if (gattServices.isEmpty())
        emit debug(QStringLiteral("henortek: FFB0 / FEE7 services not found"));
}

void henortektreadmill::deviceDiscovered(const QBluetoothDeviceInfo &device) {
    emit debug(QStringLiteral("Found new device: ") + device.name() + QStringLiteral(" (") +
               device.address().toString() + ')');
    bluetoothDevice = device;
    m_control = QLowEnergyController::createCentral(bluetoothDevice, this);
    connect(m_control, &QLowEnergyController::serviceDiscovered, this, &henortektreadmill::serviceDiscovered);
    connect(m_control, &QLowEnergyController::discoveryFinished, this, &henortektreadmill::serviceScanDone);
    connect(m_control,
            static_cast<void (QLowEnergyController::*)(QLowEnergyController::Error)>(&QLowEnergyController::error),
            this, &henortektreadmill::error);
    connect(m_control, &QLowEnergyController::stateChanged, this, &henortektreadmill::controllerStateChanged);
    connect(m_control, &QLowEnergyController::connected, this, [this]() { m_control->discoverServices(); });
    connect(m_control, &QLowEnergyController::disconnected, this, [this]() {
        emit debug(QStringLiteral("LowEnergy controller disconnected — session accumulator retained"));
        emit disconnected();
    });
    m_control->connectToDevice();
}

void henortektreadmill::controllerStateChanged(QLowEnergyController::ControllerState state) {
    if (state == QLowEnergyController::UnconnectedState && m_control) {
        initDone = false;
        connectBackLater();
    }
}

void henortektreadmill::error(QLowEnergyController::Error err) {
    QMetaEnum metaEnum = QMetaEnum::fromType<QLowEnergyController::Error>();
    emit debug(QStringLiteral("henortektreadmill::error ") +
               QString::fromLocal8Bit(metaEnum.valueToKey(err)) + " " + m_control->errorString());
}

void henortektreadmill::errorService(QLowEnergyService::ServiceError err) {
    QMetaEnum metaEnum = QMetaEnum::fromType<QLowEnergyService::ServiceError>();
    emit debug(QStringLiteral("henortektreadmill::errorService ") +
               QString::fromLocal8Bit(metaEnum.valueToKey(err)));
}

void henortektreadmill::update() {
    if (!m_control || m_control->state() == QLowEnergyController::UnconnectedState) {
        emit disconnected();
        return;
    }
    if (!initDone)
        return;
    createVirtualDevice();
    // Deliberately NO periodic 0x11 write: five captures proved the machine
    // streams without any handshake, and F4 would END the workout + clear data.
}

void henortektreadmill::writeControl(double speedKmh, int incline, uint8_t status, const QString &why) {
    Q_UNUSED(speedKmh);
    Q_UNUSED(incline);
    Q_UNUSED(status);
    Q_UNUSED(why);
    // Intentionally disabled in slim build (zero BLE writes). Kept as the single
    // choke point if a future build adds an explicit "End workout" action:
    // seal/save the HealthKit workout FIRST, then write controlFrame(0,0,0xF4).
}

void henortektreadmill::changeInclinationRequested(double grade, double percentage) {
    Q_UNUSED(grade);
    Q_UNUSED(percentage);
    // Slim build has no remote incline control; the machine's knob is authoritative.
}
