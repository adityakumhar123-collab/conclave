#include "PowerManager.h"
#include "Config.h"

PowerManager& PowerManager::getInstance() {
    static PowerManager instance;
    return instance;
}

void PowerManager::begin() {
    // Configure control pin for voltage divider power switch
    #if defined(VBAT_CTRL_PIN) && VBAT_CTRL_PIN >= 0
    pinMode(VBAT_CTRL_PIN, OUTPUT);
    digitalWrite(VBAT_CTRL_PIN, HIGH); // Turn off by default (HIGH turns off the MOSFET/divider path in XIAO)
    #endif
    
    // Set up ADC parameters
    analogReadResolution(12); // ESP32 supports 12-bit resolution (0-4095)
}

float PowerManager::readBatteryVoltage() {
    #if defined(VBAT_CTRL_PIN) && VBAT_CTRL_PIN >= 0 && defined(VBAT_READ_PIN) && VBAT_READ_PIN >= 0
    // To read the battery voltage, the control pin must be pulled LOW to turn on the divider
    digitalWrite(VBAT_CTRL_PIN, LOW);
    delay(5); // Allow voltage to settle
    
    // Read the ADC
    int rawAdc = analogRead(VBAT_READ_PIN);
    
    // Turn the divider back off to prevent battery drain
    digitalWrite(VBAT_CTRL_PIN, HIGH);
    
    // Convert ADC reading to actual battery voltage
    // XIAO ESP32S3 divider ratio is 2.0 (100k / 100k)
    // We calibrate with the reference voltage. We also apply a small correction factor if needed.
    float pinVoltage = (static_cast<float>(rawAdc) / ADC_MAX_VALUE) * ADC_REFERENCE_V;
    float batteryVoltage = pinVoltage * VBAT_DIVIDER_RATIO;
    
    return batteryVoltage;
    #else
    // Generic ESP32 fallback (no VBAT hardware divider)
    return 4.0f; // Return a nominal voltage representing a healthy state (~80%)
    #endif
}

uint8_t PowerManager::readBatteryPercentage() {
    float voltage = readBatteryVoltage();
    
    // Standard LiPo battery curve limits
    const float VBAT_MAX = 4.20f;
    const float VBAT_MIN = 3.20f;
    
    if (voltage >= VBAT_MAX) {
        return 100;
    } else if (voltage <= VBAT_MIN) {
        return 0;
    } else {
        // Simple linear interpolation
        return static_cast<uint8_t>(((voltage - VBAT_MIN) / (VBAT_MAX - VBAT_MIN)) * 100.0f);
    }
}
