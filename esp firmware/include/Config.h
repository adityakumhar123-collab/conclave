#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>


// ==========================================
// Sensor and Windowing Settings
// ==========================================
#define SAMPLE_RATE_HZ 100
#define SAMPLE_INTERVAL_MS (1000 / SAMPLE_RATE_HZ)
#define WINDOW_SIZE 200
#define STRIDE_SIZE 50

// Feature Extraction Constants
#define FFT_SIZE 256
#define NUM_CHANNELS 9    // Ax, Ay, Az, Gx, Gy, Gz, ResultantA, Jerk, SMA
#define TIER1_FEATURES 90 // 10 features x 9 channels
#define TIER2_FEATURES 42 // 7 features x 6 primary channels
#define TIER3_FEATURES 12 // 12 structural features
#define SUB_WINDOW_SIZE 20
#define NUM_SUB_WINDOWS 10
#define SEQ_FEATURES                                                           \
  (NUM_SUB_WINDOWS * (TIER1_FEATURES + TIER2_FEATURES)) // 1320
#define TOTAL_FEATURES (SEQ_FEATURES + TIER3_FEATURES)  // 1332

// ==========================================
// Anomaly Detection Constants
// ==========================================
#define DEFAULT_THRESHOLD 1.01309f // Calculated threshold (mu + 3*sigma) for Model v2 20-epoch
#define HYSTERESIS_WINDOWS 5 // Must exceed threshold for this many windows

// ==========================================
// Hardware Pin Mappings (Seeed Studio XIAO ESP32S3)
// ==========================================
#define I2C_SDA_PIN 5 // Default SDA on XIAO ESP32S3 (D4)
#define I2C_SCL_PIN 6 // Default SCL on XIAO ESP32S3 (D5)

// Battery read control pins for XIAO ESP32S3:
// GPIO14 (D3) controls the voltage divider power. Must be LOW to read VBAT.
// GPIO1 (A0) is VBAT_READ.
#define VBAT_CTRL_PIN 14
#define VBAT_READ_PIN 1

// Battery parameters
#define ADC_MAX_VALUE 4095
#define ADC_REFERENCE_V 3.3f
#define VBAT_DIVIDER_RATIO 2.0f // 100k / 100k voltage divider on board

// ==========================================
// BLE Specification
// ==========================================
#define BLE_DEVICE_NAME "SafeBand-ESP32"
#define SERVICE_UUID "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHAR_UUID_COMMAND "c083bcf3-4c9b-44c0-9943-228ae92e8fa4"     // Write (Commands)
#define CHAR_UUID_DEVICE_INFO "d2b781e9-4e78-43e9-92c1-d2a84e92a2a0" // Read (Device Info)
#define CHAR_UUID_STATUS "8f1f7e34-bb52-4467-b5cc-fb5a8e03e5c9"      // Notify (Heartbeat Status)
#define CHAR_UUID_SENSOR "c9298492-95b6-455f-8c3a-bb5a8e03e5ca"      // Notify (25Hz Raw IMU)
#define CHAR_UUID_FEATURE "e2e0a294-814d-45db-9c3f-bb5a8e03e5cb"     // Notify (2Hz TinyML features)


#endif // CONFIG_H
