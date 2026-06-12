#ifndef POWER_MANAGER_H
#define POWER_MANAGER_H

#include <Arduino.h>

class PowerManager {
public:
    static PowerManager& getInstance();

    // Initialize ADC and battery read control pin
    void begin();

    // Read battery voltage (in Volts)
    float readBatteryVoltage();

    // Read battery percentage (0 to 100)
    uint8_t readBatteryPercentage();

private:
    PowerManager() = default;
    ~PowerManager() = default;

    PowerManager(const PowerManager&) = delete;
    PowerManager& operator=(const PowerManager&) = delete;
};

#endif // POWER_MANAGER_H
