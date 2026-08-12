#include "IMUSensor.h"
#include "Config.h"
#include <Wire.h>
#include <math.h>

IMUSensor& IMUSensor::getInstance() {
    static IMUSensor instance;
    return instance;
}

IMUSensor::IMUSensor() 
    : isInitialized(false) {}

bool IMUSensor::begin() {
    Serial.println("[IMU] Initializing MPU-6050 via I2C.");
    Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
    Wire.setTimeOut(100); // 100ms timeout prevents I2C bus lockups during high-G shakes and vibrations
    
    // Test connection by reading WHO_AM_I
    uint8_t whoAmI = 0;
    if (!readRegisters(REG_WHO_AM_I, &whoAmI, 1)) {
        Serial.println("[IMU] Error: Failed to read WHO_AM_I register.");
        return false;
    }
    
    Serial.print("[IMU] WHO_AM_I: 0x");
    Serial.println(whoAmI, HEX);
    
    if (whoAmI != 0x68 && whoAmI != 0x72 && whoAmI != 0x70) {
        Serial.println("[IMU] Error: MPU-6050 device signature not recognized.");
        return false;
    }
    
    // Wake up MPU-6050 (clears SLEEP bit)
    if (!writeRegister(REG_PWR_MGMT_1, 0x00)) {
        Serial.println("[IMU] Error: Failed to wake up sensor.");
        return false;
    }
    
    // Configure Digital Low Pass Filter (DLPF) to ~44Hz bandwidth
    if (!writeRegister(REG_CONFIG, 0x03)) {
        Serial.println("[IMU] Error: Failed to set DLPF.");
        return false;
    }
    
    // Configure Accelerometer to +/- 8g range (4096 LSB/g)
    if (!writeRegister(REG_ACCEL_CONFIG, 0x10)) {
        Serial.println("[IMU] Error: Failed to configure accelerometer range.");
        return false;
    }
    
    // Configure Gyroscope to +/- 500 dps range (65.5 LSB/dps)
    if (!writeRegister(REG_GYRO_CONFIG, 0x08)) {
        Serial.println("[IMU] Error: Failed to configure gyroscope range.");
        return false;
    }
    
    // Set Sample Rate Divider to 0 (gives 1 kHz sample rate, which we downsample to 100 Hz by polling at 10ms)
    if (!writeRegister(REG_SMPLRT_DIV, 0x00)) {
        Serial.println("[IMU] Error: Failed to set sample rate divider.");
        return false;
    }
    
    isInitialized = true;
    Serial.println("[IMU] MPU-6050 initialized successfully.");
    return true;
}

bool IMUSensor::readSample(IMUData& data) {
    if (!isInitialized) {
        return false;
    }

    uint8_t buffer[14];
    if (!readRegisters(REG_DATA_START, buffer, 14)) {
        return false;
    }
    
    // Reconstruct raw values (big-endian from I2C registers)
    int16_t rawAx = (buffer[0] << 8) | buffer[1];
    int16_t rawAy = (buffer[2] << 8) | buffer[3];
    int16_t rawAz = (buffer[4] << 8) | buffer[5];
    // bytes 6-7 contain temperature (unused here)
    int16_t rawGx = (buffer[8] << 8) | buffer[9];
    int16_t rawGy = (buffer[10] << 8) | buffer[11];
    int16_t rawGz = (buffer[12] << 8) | buffer[13];
    
    // Convert to target units using +/- 8g (4096 LSB/g) and +/- 500 dps (65.5 LSB/dps)
    // Coordinates match: X longitudinal, Y lateral, Z normal
    data.ax = static_cast<float>(rawAx) / 4096.0f;
    data.ay = static_cast<float>(rawAy) / 4096.0f;
    data.az = static_cast<float>(rawAz) / 4096.0f;
    
    data.gx = static_cast<float>(rawGx) / 65.5f;
    data.gy = static_cast<float>(rawGy) / 65.5f;
    data.gz = static_cast<float>(rawGz) / 65.5f;

    // Check if the sensor has gone into sleep mode or locked up (resultant gravity vector is close to 0)
    float resultant = sqrtf(data.ax*data.ax + data.ay*data.ay + data.az*data.az);
    if (resultant < 0.1f) {
        static uint32_t lastWakeAttempt = 0;
        uint32_t now = millis();
        if (now - lastWakeAttempt > 1000) {
            lastWakeAttempt = now;
            Serial.println("[IMU] Warning: Sleep/Glitch detected (resultant < 0.1g). Attempting auto-wake...");
            writeRegister(REG_PWR_MGMT_1, 0x00); // Wake up MPU-6050
            writeRegister(REG_CONFIG, 0x03);      // DLPF
            writeRegister(REG_ACCEL_CONFIG, 0x10);// 8g range
            writeRegister(REG_GYRO_CONFIG, 0x08); // 500 dps
            writeRegister(REG_SMPLRT_DIV, 0x00);  // Sample divider
        }
    }

    // Convert accelerometer from g to m/s^2 to match training dataset scale (ax_ms2)
    data.ax *= 9.80665f;
    data.ay *= 9.80665f;
    data.az *= 9.80665f;

    return true;
}

bool IMUSensor::writeRegister(uint8_t reg, uint8_t value) {
    Wire.beginTransmission(MPU6050_ADDR);
    Wire.write(reg);
    Wire.write(value);
    return (Wire.endTransmission() == 0);
}

bool IMUSensor::readRegisters(uint8_t reg, uint8_t* buffer, uint8_t length) {
    Wire.beginTransmission(MPU6050_ADDR);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) {
        return false;
    }
    
    uint8_t bytesRead = Wire.requestFrom(MPU6050_ADDR, length);
    if (bytesRead != length) {
        return false;
    }
    
    for (uint8_t i = 0; i < length; i++) {
        buffer[i] = Wire.read();
    }
    
    return true;
}
