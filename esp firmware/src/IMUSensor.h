#ifndef IMU_SENSOR_H
#define IMU_SENSOR_H

#include <Arduino.h>

struct IMUData {
    float ax; // in g
    float ay; // in g
    float az; // in g
    float gx; // in dps
    float gy; // in dps
    float gz; // in dps
};

enum MockMotionState {
    MOCK_MOTION_RESTING = 0,
    MOCK_MOTION_WALKING = 1,
    MOCK_MOTION_STRUGGLE = 2,
    MOCK_MOTION_FALL = 3
};

class IMUSensor {
public:
    static IMUSensor& getInstance();

    // Initialize sensor or mock generator
    bool begin();

    // Read latest sample
    bool readSample(IMUData& data);

    // Set mock motion state
    void setMockState(MockMotionState state);
    MockMotionState getMockState() const { return mockState; }

private:
    IMUSensor();
    ~IMUSensor() = default;

    IMUSensor(const IMUSensor&) = delete;
    IMUSensor& operator=(const IMUSensor&) = delete;

    // Registers
    static const uint8_t MPU6050_ADDR = 0x68;
    static const uint8_t REG_SMPLRT_DIV = 0x19;
    static const uint8_t REG_CONFIG = 0x1A;
    static const uint8_t REG_GYRO_CONFIG = 0x1B;
    static const uint8_t REG_ACCEL_CONFIG = 0x1C;
    static const uint8_t REG_PWR_MGMT_1 = 0x6B;
    static const uint8_t REG_WHO_AM_I = 0x75;
    static const uint8_t REG_DATA_START = 0x3B;

    MockMotionState mockState;
    uint32_t mockSampleIndex;
    bool isInitialized;

    bool writeRegister(uint8_t reg, uint8_t value);
    bool readRegisters(uint8_t reg, uint8_t* buffer, uint8_t length);

    // Mock generation helpers
    void generateMockSample(IMUData& data);
};

#endif // IMU_SENSOR_H
