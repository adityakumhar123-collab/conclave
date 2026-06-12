#include "IMUSensor.h"
#include "Config.h"
#include <Wire.h>
#include <math.h>

IMUSensor& IMUSensor::getInstance() {
    static IMUSensor instance;
    return instance;
}

IMUSensor::IMUSensor() 
    : mockState(MOCK_MOTION_RESTING)
    , mockSampleIndex(0)
    , isInitialized(false) {}

bool IMUSensor::begin() {
#if USE_MOCK_IMU
    Serial.println("[IMU] Initializing in MOCK mode.");
    isInitialized = true;
    mockSampleIndex = 0;
    return true;
#else
    Serial.println("[IMU] Initializing MPU-6050 via I2C.");
    Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
    
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
#endif
}

bool IMUSensor::readSample(IMUData& data) {
    if (!isInitialized) {
        return false;
    }

#if USE_MOCK_IMU
    generateMockSample(data);
    mockSampleIndex++;
#else
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
#endif

    // Convert accelerometer from g to m/s^2 to match training dataset scale (ax_ms2)
    data.ax *= 9.80665f;
    data.ay *= 9.80665f;
    data.az *= 9.80665f;

    return true;
}

void IMUSensor::setMockState(MockMotionState state) {
    if (mockState != state) {
        mockState = state;
        mockSampleIndex = 0;
        Serial.print("[IMU] Mock state changed to: ");
        Serial.println(state);
    }
}

void IMUSensor::generateMockSample(IMUData& data) {
    // Generate small pseudo-random noise (-0.02 to 0.02)
    float noiseA_x = (static_cast<float>(rand() % 2000) - 1000.0f) / 50000.0f;
    float noiseA_y = (static_cast<float>(rand() % 2000) - 1000.0f) / 50000.0f;
    float noiseA_z = (static_cast<float>(rand() % 2000) - 1000.0f) / 50000.0f;
    
    float noiseG_x = (static_cast<float>(rand() % 2000) - 1000.0f) / 20000.0f; // -0.05 to 0.05 dps
    float noiseG_y = (static_cast<float>(rand() % 2000) - 1000.0f) / 20000.0f;
    float noiseG_z = (static_cast<float>(rand() % 2000) - 1000.0f) / 20000.0f;

    switch (mockState) {
        case MOCK_MOTION_RESTING:
            // Device is flat face-up on a table. Z axis experiences +1.0g gravity.
            data.ax = 0.0f + noiseA_x;
            data.ay = 0.0f + noiseA_y;
            data.az = 1.0f + noiseA_z;
            data.gx = 0.0f + noiseG_x;
            data.gy = 0.0f + noiseG_y;
            data.gz = 0.0f + noiseG_z;
            break;
            
        case MOCK_MOTION_WALKING: {
            // Rhythmic motion at 1.5 Hz (period of 67 samples at 100Hz)
            float freq = 1.5f;
            float t = static_cast<float>(mockSampleIndex) / SAMPLE_RATE_HZ;
            float omega = 2.0f * M_PI * freq * t;
            
            data.ax = 0.15f * sin(omega) + noiseA_x;
            data.ay = 0.10f * cos(omega) + noiseA_y;
            data.az = 1.0f + 0.25f * sin(omega * 2.0f) + noiseA_z; // Double freq bounce for gravity
            data.gx = 40.0f * sin(omega) + noiseG_x;
            data.gy = 25.0f * cos(omega) + noiseG_y;
            data.gz = 15.0f * sin(omega) + noiseG_z;
            break;
        }
            
        case MOCK_MOTION_STRUGGLE: {
            // High intensity chaotic motion
            data.ax = ((rand() % 3000) - 1500.0f) / 1000.0f + noiseA_x; // -1.5g to 1.5g
            data.ay = ((rand() % 3000) - 1500.0f) / 1000.0f + noiseA_y;
            data.az = ((rand() % 3000) - 1500.0f) / 1000.0f + noiseA_z;
            
            data.gx = ((rand() % 6000) - 3000.0f) / 10.0f + noiseG_x;   // -300 to 300 dps
            data.gy = ((rand() % 6000) - 3000.0f) / 10.0f + noiseG_y;
            data.gz = ((rand() % 6000) - 3000.0f) / 10.0f + noiseG_z;
            break;
        }
            
        case MOCK_MOTION_FALL: {
            // A fall scenario sequence repeated every 500 samples
            uint32_t stage = mockSampleIndex % 500;
            
            if (stage < 150) {
                // Phase 1: Walking before fall (1.5 seconds)
                float freq = 1.5f;
                float omega = 2.0f * M_PI * freq * (static_cast<float>(stage) / SAMPLE_RATE_HZ);
                data.ax = 0.15f * sin(omega) + noiseA_x;
                data.ay = 0.10f * cos(omega) + noiseA_y;
                data.az = 1.0f + 0.25f * sin(omega * 2.0f) + noiseA_z;
                data.gx = 40.0f * sin(omega) + noiseG_x;
                data.gy = 25.0f * cos(omega) + noiseG_y;
                data.gz = 15.0f * sin(omega) + noiseG_z;
            } 
            else if (stage >= 150 && stage < 180) {
                // Phase 2: Free fall (0.3 seconds) — acceleration goes near 0
                data.ax = 0.05f + noiseA_x * 0.1f;
                data.ay = 0.05f + noiseA_y * 0.1f;
                data.az = 0.05f + noiseA_z * 0.1f;
                data.gx = noiseG_x * 5.0f;
                data.gy = noiseG_y * 5.0f;
                data.gz = noiseG_z * 5.0f;
            } 
            else if (stage >= 180 && stage < 195) {
                // Phase 3: Impact (0.15 seconds) — huge acceleration spikes (resultant ~5.5g)
                data.ax = 4.0f + noiseA_x * 5.0f;
                data.ay = -3.0f + noiseA_y * 5.0f;
                data.az = 2.5f + noiseA_z * 5.0f;
                data.gx = 450.0f + noiseG_x * 50.0f;
                data.gy = -300.0f + noiseG_y * 50.0f;
                data.gz = 200.0f + noiseG_z * 50.0f;
            } 
            else {
                // Phase 4: Lying still on side (3 seconds) — Ax has 1.0g gravity, others still
                data.ax = 1.0f + noiseA_x;
                data.ay = 0.0f + noiseA_y;
                data.az = 0.0f + noiseA_z;
                data.gx = 0.0f + noiseG_x;
                data.gy = 0.0f + noiseG_y;
                data.gz = 0.0f + noiseG_z;
            }
            break;
        }
    }
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
