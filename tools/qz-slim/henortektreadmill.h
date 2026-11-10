// henortektreadmill.h — UOK E6Pro / USpbj-5610s driver for QZ (qdomyos-zwift)
//
// v2 (2026-11-11): rewritten against PROTOCOL-FINAL.md, verified by FIVE real
// captures (1,264 frames, 0 checksum failures). The previous qz-driver/ version
// was based on static APK reverse engineering and subscribed to the WRONG
// characteristic (FFB1 / 0x95). The real 1 Hz data source is FEC8 (FEE7 service).
//
// License: GPL-3.0 (same as QZ). NOT yet compiled: this machine has no Qt/Android
// toolchain. See BUILD-SLIM.md.
//
// Wiring summary (verified GATT table, 5th capture):
//   FFB0 / FFB1 : NOTIFY       (secondary: 0x90 / 0x92 / 0x95)
//   FFB0 / FFB2 : WRITE-NR     (control frames 0x11)
//   FFB0 / FFB3 : READ
//   FEE7 / FEC7 : WRITE
//   FEE7 / FEC8 : INDICATE     (PRIMARY: 0x21 / 0x23 / 0x22 / 0x20)
//   FEE7 / FEC9 : READ
//   180A / 2Axx : READ
//   NOTE: there is NO FEE1 characteristic on this unit.

#ifndef HENORTEKTREADMILL_H
#define HENORTEKTREADMILL_H

#include <QBluetoothDeviceInfo>
#include <QDateTime>
#include <QList>
#include <QLowEnergyCharacteristic>
#include <QLowEnergyController>
#include <QLowEnergyService>
#include <QObject>
#include <QTimer>

#include "treadmill.h"

class henortektreadmill : public treadmill {
    Q_OBJECT
  public:
    henortektreadmill(uint32_t pollDeviceTime = 200, bool noConsole = false, bool noHeartService = false,
                      double forceInitSpeed = 0.0, double forceInitInclination = 0.0);

    bool connected() override;
    double minStepInclination() override { return 1.0; } // inclination is a 0..25 gear, not percent
    double minStepSpeed() override { return 0.1; }       // speed unit = 0.1 km/h

    // Uplink sync contract (PROTOCOL-FINAL.md 15.5): the ONLY pause command is the
    // machine's physical button. QZ must auto-start when speed > 0 and auto-pause
    // (keeping the session open) when speed drops to 0.
    bool autoPauseWhenSpeedIsZero() override { return true; }
    bool autoStartWhenSpeedIsGreaterThenZero() override { return true; }
    // SLIM BUILD = ZERO BLE WRITES. Writing 0x11/F4 would END the workout and
    // clear the machine's counters (C1). The only pause control is the physical
    // button, so QZ stays a pure listener and follows the uplink state machine.
    bool canStartStop() override { return false; }
    bool canHandleSpeedChange() override { return false; }
    bool canHandleInclineChange() override { return false; }

    // 9-byte BT->MCU control frame. Public for unit tests.
    static QByteArray controlFrame(double speedKmh, int incline, uint8_t status);

  private:
    void parseFrame(const QByteArray &frame);
    void publishSnapshot();
    void createVirtualDevice();
    void writeControl(double speedKmh, int incline, uint8_t status, const QString &why);
    void beginSessionIfNeeded();
    void pauseSessionIfNeeded();

    bool noConsole = false;
    bool noHeartService = false;
    uint32_t pollDeviceTime = 200;
    bool initDone = false;
    bool firstInit = false;
    bool sessionOpen = false;

    QByteArray rxBuffer;
    QDateTime lastPacketTime;
    QDateTime lastSampleTime;
    QTimer *refresh = nullptr;

    // Both services must be subscribed: FEC8 is the primary data source.
    QList<QLowEnergyService *> gattServices;
    QLowEnergyService *gattWriteService = nullptr;
    QLowEnergyCharacteristic gattWriteCharacteristic; // FFB2
    QList<QLowEnergyCharacteristic> gattNotifyCharacteristics;

    // --- session accumulator (PROTOCOL-FINAL.md 15.5) ---
    // The device clears its counters on remote F4 and does not backfill over BLE
    // disconnects, so QZ owns a monotonic session value.
    double sessionDistanceKm = 0.0;
    double sessionKcal = 0.0;
    int sessionSeconds = 0;
    double lastDeviceDistanceKm = -1.0;
    double lastDeviceKcal = -1.0;
    int lastDeviceSeconds = -1;
    double lockedSpeed = 0.0;   // latched before leaving 0x10
    double lockedDistance = 0.0;
    int lockedIncline = 0;
    uint8_t lastState = 0x00;

  Q_SIGNALS:
    void disconnected();
    void debug(QString string);
    void speedChanged(double speed);
    void packetReceived();

  public slots:
    void deviceDiscovered(const QBluetoothDeviceInfo &device);

  private slots:
    void characteristicChanged(const QLowEnergyCharacteristic &characteristic, const QByteArray &newValue);
    void characteristicWritten(const QLowEnergyCharacteristic &characteristic, const QByteArray &newValue);
    void descriptorWritten(const QLowEnergyDescriptor &descriptor, const QByteArray &newValue);
    void stateChanged(QLowEnergyService::ServiceState state);
    void controllerStateChanged(QLowEnergyController::ControllerState state);
    void serviceDiscovered(const QBluetoothUuid &gatt);
    void serviceScanDone();
    void update();
    void error(QLowEnergyController::Error err);
    void errorService(QLowEnergyService::ServiceError err);
    void changeInclinationRequested(double grade, double percentage);
};

#endif // HENORTEKTREADMILL_H
