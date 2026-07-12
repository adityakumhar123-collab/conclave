#include "BLEManager.h"
#include "Config.h"
#include "ModelRunner.h"
#include <esp_system.h>

// Connection callbacks
class BLEServerCallbacksImpl : public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) override {
        BLEManager::getInstance().setConnected(true);
    }

    void onConnect(BLEServer* pServer, esp_ble_gatts_cb_param_t *param) override {
        BLEManager::getInstance().setConnected(true);
        // Commented out to let phone's OS manage stable defaults, preventing early disconnects
        /*
        pServer->updateConnParams(
            param->connect.remote_bda,
            24,   // minInterval = 30ms
            40,   // maxInterval = 50ms
            0,    // latency = 0
            400   // timeout = 4s supervision timeout
        );
        */
    }

    void onDisconnect(BLEServer* pServer) override {
        BLEManager::getInstance().setConnected(false);
    }
};

// Command character callbacks
class BLECharacteristicCallbacksImpl : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic* pCharacteristic) override {
        std::string value = pCharacteristic->getValue();
        if (value.length() == 0) return;
        uint8_t cmd = static_cast<uint8_t>(value[0]);
        BLEManager::getInstance().processCommand(cmd);
    }
};

BLEManager& BLEManager::getInstance() {
    static BLEManager instance;
    return instance;
}

BLEManager::BLEManager() 
    : pServer(nullptr)
    , pCharEvent(nullptr)
    , pCharCommand(nullptr)
    , pCharDeviceInfo(nullptr)
    , pCharStatus(nullptr)
    , pCharSensor(nullptr)
    , pCharFeature(nullptr)
    , deviceConnected(false)
    , oldDeviceConnected(false)
    , isStreaming(false)
    , eventAck(false)
    , calibrationRequest(false)
    , pendingCommand(0)
    , eventSequenceId(0)
    , sensorSequenceId(0)
    , featureSequenceId(0) {}

void BLEManager::begin() {
    Serial.println("[BLE] Initializing BLE stack.");
    
    // Change base MAC address to bypass Android BLE GATT cache corruption.
    // Incremented to 0x40 (BLE addr ends in 0x41) to force a full cache rebuild
    // after FEATURE characteristic was not found at 0x30.
    uint8_t customMac[6] = {0x90, 0x70, 0x69, 0x11, 0x69, 0x40};
    esp_base_mac_addr_set(customMac);
    
    // Set MTU before init to avoid packet fragmentation.
    // Default ATT payload is 20 bytes; Sensor packets are 22 bytes, which
    // causes BLE fragmentation and corrupts the XOR checksum on the app side.
    BLEDevice::setMTU(64);

    // Initialize BLE Device
    BLEDevice::init(BLE_DEVICE_NAME);
    
    // Increase TX power to maximum (+9dBm) for better range and connection stability
    BLEDevice::setPower(ESP_PWR_LVL_P9);

    // Create BLE Server
    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new BLEServerCallbacksImpl());

    // Create primary SafeBand Service
    BLEService* pService = pServer->createService(BLEUUID(SERVICE_UUID), 30);

    // Create Event Notification Characteristic (Notify)
    pCharEvent = pService->createCharacteristic(
        CHAR_UUID_EVENT,
        BLECharacteristic::PROPERTY_NOTIFY
    );
    pCharEvent->addDescriptor(new BLE2902()); // Standard descriptor for notifications

    // Create Command Input Characteristic (Write)
    pCharCommand = pService->createCharacteristic(
        CHAR_UUID_COMMAND,
        BLECharacteristic::PROPERTY_WRITE
    );
    pCharCommand->setCallbacks(new BLECharacteristicCallbacksImpl());

    // Create Device Info Characteristic (Read)
    pCharDeviceInfo = pService->createCharacteristic(
        CHAR_UUID_DEVICE_INFO,
        BLECharacteristic::PROPERTY_READ
    );
    pCharDeviceInfo->setValue("SafeBand-XIAO-ESP32S3 v1.0.0");

    // Create Status Notification Characteristic (Notify)
    pCharStatus = pService->createCharacteristic(
        CHAR_UUID_STATUS,
        BLECharacteristic::PROPERTY_NOTIFY
    );
    pCharStatus->addDescriptor(new BLE2902());

    // Create Sensor Notification Characteristic (Notify)
    pCharSensor = pService->createCharacteristic(
        CHAR_UUID_SENSOR,
        BLECharacteristic::PROPERTY_NOTIFY
    );
    pCharSensor->addDescriptor(new BLE2902());

    // Create Feature Notification Characteristic (Notify)
    pCharFeature = pService->createCharacteristic(
        CHAR_UUID_FEATURE,
        BLECharacteristic::PROPERTY_NOTIFY
    );
    pCharFeature->addDescriptor(new BLE2902());

    // Start Service
    pService->start();


    // Start Advertising
    BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->setScanResponse(true);
    BLEDevice::startAdvertising();
    
    Serial.println("[BLE] Service started. Advertising active.");
}

void BLEManager::setDeviceInfo(const char* info) {
    if (pCharDeviceInfo != nullptr && info != nullptr && strlen(info) > 0) {
        pCharDeviceInfo->setValue(info);
    }
}

void BLEManager::sendStatusPacket(uint8_t batteryPct, uint8_t wearConfidence, uint8_t systemFlags, uint16_t uptimeMinutes, uint8_t avgAnomaly, uint8_t inferenceRate) {
    if (!deviceConnected) return;

    uint8_t packet[10];
    packet[0] = 0x02; // Packet Type
    packet[1] = batteryPct;
    packet[2] = wearConfidence;
    packet[3] = 0x01; // Model Version (Firmware ML model version)
    packet[4] = systemFlags;
    
    // Little-endian uptimeMinutes
    packet[5] = static_cast<uint8_t>(uptimeMinutes & 0xFF);
    packet[6] = static_cast<uint8_t>((uptimeMinutes >> 8) & 0xFF);
    
    packet[7] = avgAnomaly;
    packet[8] = inferenceRate;
    
    // Checksum
    packet[9] = calculateChecksum(packet, 9);

    pCharStatus->setValue(packet, 10);
    pCharStatus->notify();
}

void BLEManager::sendEventPacket(uint16_t secSinceBoot, uint8_t anomalyScore, uint8_t confidence, uint8_t motionState, uint8_t duration100ms, uint16_t peakResultantAccelMg, uint8_t dominantFreqHz, uint8_t zcr, uint8_t spectralEntropy, uint16_t eigenvalueRatioScaled, uint8_t batteryPct, uint8_t wearConfidence, const int8_t* motionEmbedding) {
    if (!deviceConnected) return;

    uint8_t packet[34];
    packet[0] = 0x01; // Packet Type
    packet[1] = eventSequenceId++;
    
    // Little-endian timestamp (seconds since boot)
    packet[2] = static_cast<uint8_t>(secSinceBoot & 0xFF);
    packet[3] = static_cast<uint8_t>((secSinceBoot >> 8) & 0xFF);
    
    packet[4] = anomalyScore;
    packet[5] = confidence;
    packet[6] = motionState;
    packet[7] = duration100ms;
    
    // Little-endian peak accel
    packet[8] = static_cast<uint8_t>(peakResultantAccelMg & 0xFF);
    packet[9] = static_cast<uint8_t>((peakResultantAccelMg >> 8) & 0xFF);
    
    packet[10] = dominantFreqHz;
    packet[11] = zcr;
    packet[12] = spectralEntropy;
    
    // Little-endian eigenvalue ratio
    packet[13] = static_cast<uint8_t>(eigenvalueRatioScaled & 0xFF);
    packet[14] = static_cast<uint8_t>((eigenvalueRatioScaled >> 8) & 0xFF);
    
    packet[15] = batteryPct;
    packet[16] = wearConfidence;
    
    // Copy the 16-byte motion embedding
    if (motionEmbedding != nullptr) {
        memcpy(&packet[17], motionEmbedding, 16);
    } else {
        memset(&packet[17], 0, 16);
    }
    
    // Checksum
    packet[33] = calculateChecksum(packet, 33);

    pCharEvent->setValue(packet, 34);
    pCharEvent->notify();
}

void BLEManager::sendSensorPacket(uint16_t msSinceBoot, const IMUData& imu, float resultantAccel, float jerk, uint8_t anomalyScore) {
    if (!deviceConnected || !isStreaming) return;

    uint8_t packet[22];
    packet[0] = 0x03; // Packet Type
    packet[1] = sensorSequenceId++;
    
    // Little-endian msSinceBoot
    packet[2] = static_cast<uint8_t>(msSinceBoot & 0xFF);
    packet[3] = static_cast<uint8_t>((msSinceBoot >> 8) & 0xFF);
    
    // Convert float m/s^2 to milli-Gs (int16_t, where 1g = 9.80665 m/s^2 = 1000 mg)
    int16_t axMg = static_cast<int16_t>(imu.ax * 101.97162f);
    int16_t ayMg = static_cast<int16_t>(imu.ay * 101.97162f);
    int16_t azMg = static_cast<int16_t>(imu.az * 101.97162f);
    
    // Convert float dps to 0.1 dps units (int16_t)
    int16_t gxUnits = static_cast<int16_t>(imu.gx * 10.0f);
    int16_t gyUnits = static_cast<int16_t>(imu.gy * 10.0f);
    int16_t gzUnits = static_cast<int16_t>(imu.gz * 10.0f);
    
    uint16_t resMg = static_cast<uint16_t>(resultantAccel * 101.97162f);
    int16_t jerkMgS = static_cast<int16_t>(jerk * 101.97162f);

    // Accel X, Y, Z
    packet[4] = static_cast<uint8_t>(axMg & 0xFF);
    packet[5] = static_cast<uint8_t>((axMg >> 8) & 0xFF);
    packet[6] = static_cast<uint8_t>(ayMg & 0xFF);
    packet[7] = static_cast<uint8_t>((ayMg >> 8) & 0xFF);
    packet[8] = static_cast<uint8_t>(azMg & 0xFF);
    packet[9] = static_cast<uint8_t>((azMg >> 8) & 0xFF);
    
    // Gyro X, Y, Z
    packet[10] = static_cast<uint8_t>(gxUnits & 0xFF);
    packet[11] = static_cast<uint8_t>((gxUnits >> 8) & 0xFF);
    packet[12] = static_cast<uint8_t>(gyUnits & 0xFF);
    packet[13] = static_cast<uint8_t>((gyUnits >> 8) & 0xFF);
    packet[14] = static_cast<uint8_t>(gzUnits & 0xFF);
    packet[15] = static_cast<uint8_t>((gzUnits >> 8) & 0xFF);
    
    // Resultant Accel
    packet[16] = static_cast<uint8_t>(resMg & 0xFF);
    packet[17] = static_cast<uint8_t>((resMg >> 8) & 0xFF);
    
    // Jerk
    packet[18] = static_cast<uint8_t>(jerkMgS & 0xFF);
    packet[19] = static_cast<uint8_t>((jerkMgS >> 8) & 0xFF);
    
    packet[20] = anomalyScore;
    packet[21] = calculateChecksum(packet, 21);

    pCharSensor->setValue(packet, 22);
    pCharSensor->notify();
}

void BLEManager::sendFeaturePacket(uint8_t seq, uint8_t anomalyScore, uint8_t motionState, uint8_t dominantFreqHz, uint8_t zcr, uint8_t spectralEntropy, uint16_t eigenvalueRatioScaled, uint8_t wearConfidence, uint16_t peakResultantAccelMg, uint16_t durationUnits, const int8_t* motionEmbedding) {
    if (!deviceConnected) return;

    uint8_t packet[32];
    packet[0] = 0x04; // Packet Type
    packet[1] = featureSequenceId++;
    packet[2] = anomalyScore;
    packet[3] = motionState;
    packet[4] = dominantFreqHz;
    packet[5] = zcr;
    packet[6] = spectralEntropy;
    
    // Little-endian eigenvalue ratio
    packet[7] = static_cast<uint8_t>(eigenvalueRatioScaled & 0xFF);
    packet[8] = static_cast<uint8_t>((eigenvalueRatioScaled >> 8) & 0xFF);
    
    packet[9] = wearConfidence;
    
    // Little-endian peak accel
    packet[10] = static_cast<uint8_t>(peakResultantAccelMg & 0xFF);
    packet[11] = static_cast<uint8_t>((peakResultantAccelMg >> 8) & 0xFF);
    
    // Little-endian duration
    packet[12] = static_cast<uint8_t>(durationUnits & 0xFF);
    packet[13] = static_cast<uint8_t>((durationUnits >> 8) & 0xFF);
    
    // Copy the 16-byte motion embedding
    if (motionEmbedding != nullptr) {
        memcpy(&packet[14], motionEmbedding, 16);
    } else {
        memset(&packet[14], 0, 16);
    }
    
    packet[30] = 0x00; // Reserved
    
    // Checksum
    packet[31] = calculateChecksum(packet, 31);

    pCharFeature->setValue(packet, 32);
    pCharFeature->notify();
}


void BLEManager::handleConnectionStatus() {
    // If connection status has changed
    if (deviceConnected && !oldDeviceConnected) {
        oldDeviceConnected = deviceConnected;
        Serial.println("[BLE] Client connected.");
    }
    if (!deviceConnected && oldDeviceConnected) {
        oldDeviceConnected = deviceConnected;
        isStreaming = false;
        Serial.println("[BLE] Client disconnected. Restarting advertising.");
        BLEDevice::startAdvertising();
    }
}

uint8_t BLEManager::calculateChecksum(const uint8_t* buffer, size_t length) {
    uint8_t checksum = 0;
    for (size_t i = 0; i < length; i++) {
        checksum ^= buffer[i];
    }
    return checksum;
}

void BLEManager::processCommand(uint8_t command) {
    Serial.printf("[BLE] Processing command: 0x%02X\n", command);

    switch (command) {
        case 0x01: // Start sensor streaming
            isStreaming = true;
            Serial.println("[BLE] Command: Start streaming.");
            break;
        case 0x02: // Stop sensor streaming
            isStreaming = false;
            Serial.println("[BLE] Command: Stop streaming.");
            break;
        case 0x03: // Request immediate Status Packet
            Serial.println("[BLE] Command: Status packet requested.");
            break;
        case 0x04: // Acknowledge event
            eventAck = true;
            Serial.println("[BLE] Command: Event acknowledged.");
            break;
        case 0x05: // Enter calibration mode
            calibrationRequest = true;
            Serial.println("[BLE] Command: Calibration requested.");
            break;

        case 0xFF: // Emergency cancel (user confirmed safe)
            eventAck = true;
            Serial.println("[BLE] Command: Emergency cancel.");
            break;
        default:
            Serial.printf("[BLE] Error: Unknown command 0x%02X\n", command);
            break;
    }
}
