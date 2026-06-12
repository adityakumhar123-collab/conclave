#ifndef BLE_MANAGER_H
#define BLE_MANAGER_H

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "IMUSensor.h"

class BLEManagerCallbacks;

class BLEManager {
public:
    static BLEManager& getInstance();

    // Initialize BLE Server, Services, and Characteristics
    void begin();

    // Send Status Packet (Type 0x02)
    void sendStatusPacket(uint8_t batteryPct, uint8_t wearConfidence, uint8_t systemFlags, uint16_t uptimeMinutes, uint8_t avgAnomaly, uint8_t inferenceRate);

    // Send Event Packet (Type 0x01)
    void sendEventPacket(uint16_t secSinceBoot, uint8_t anomalyScore, uint8_t confidence, uint8_t motionState, uint8_t duration100ms, uint16_t peakResultantAccelMg, uint8_t dominantFreqHz, uint8_t zcr, uint8_t spectralEntropy, uint16_t eigenvalueRatioScaled, uint8_t batteryPct, uint8_t wearConfidence);

    // Send Sensor Packet (Type 0x03)
    void sendSensorPacket(uint16_t msSinceBoot, const IMUData& imu, float resultantAccel, float jerk, uint8_t anomalyScore);

    // Send Feature Packet (Type 0x04)
    void sendFeaturePacket(uint8_t seq, uint8_t anomalyScore, uint8_t motionState, uint8_t dominantFreqHz, uint8_t zcr, uint8_t spectralEntropy, uint16_t eigenvalueRatioScaled, uint8_t wearConfidence, uint16_t peakResultantAccelMg, uint16_t durationUnits);

    // Handle connection changes in main thread if needed
    void handleConnectionStatus();


    // Streaming state accessor
    bool isStreamingEnabled() const { return isStreaming; }
    void setStreamingEnabled(bool enabled) { isStreaming = enabled; }

    // Check if client is connected
    bool isConnected() const { return deviceConnected; }
    void setConnected(bool connected) { deviceConnected = connected; }

    // Event Acknowledgment state
    bool isEventAcknowledged() const { return eventAck; }
    void setEventAcknowledged(bool ack) { eventAck = ack; }

    // Calibration request trigger
    bool isCalibrationRequested() const { return calibrationRequest; }
    void clearCalibrationRequest() { calibrationRequest = false; }
    void setCalibrationRequest() { calibrationRequest = true; }

    // Deferred command processing
    bool hasPendingCommand() const { return pendingCommand != 0; }
    uint8_t getPendingCommand() {
        uint8_t cmd = pendingCommand;
        pendingCommand = 0;
        return cmd;
    }
    void setPendingCommand(uint8_t cmd) { pendingCommand = cmd; }
    void processCommand(uint8_t command);

private:
    BLEManager();
    ~BLEManager() = default;

    BLEManager(const BLEManager&) = delete;
    BLEManager& operator=(const BLEManager&) = delete;

    BLEServer* pServer;
    BLECharacteristic* pCharEvent; // Notify characteristic (Emergency alerts)
    BLECharacteristic* pCharCommand; // Write characteristic
    BLECharacteristic* pCharDeviceInfo; // Read characteristic
    BLECharacteristic* pCharStatus; // Notify characteristic (Heartbeat status)
    BLECharacteristic* pCharSensor; // Notify characteristic (Raw sensor stream)
    BLECharacteristic* pCharFeature; // Notify characteristic (TinyML features stream)

    bool deviceConnected;
    bool oldDeviceConnected;
    bool isStreaming;
    bool eventAck;
    bool calibrationRequest;
    volatile uint8_t pendingCommand;

    uint8_t eventSequenceId;
    uint8_t sensorSequenceId;
    uint8_t featureSequenceId;


    uint8_t calculateChecksum(const uint8_t* buffer, size_t length);
};

#endif // BLE_MANAGER_H
