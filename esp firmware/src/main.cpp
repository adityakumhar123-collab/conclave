#include <Arduino.h>
#include "Config.h"
#include "IMUSensor.h"
#include "FeatureExtractor.h"
#include "ModelRunner.h"
#include "BLEManager.h"
#include "PowerManager.h"

// FreeRTOS Task Handles and Queues
TaskHandle_t samplerTaskHandle = nullptr;
TaskHandle_t processingTaskHandle = nullptr;
TaskHandle_t heartbeatTaskHandle = nullptr;
QueueHandle_t sampleQueue = nullptr;

// Shared state for system health
uint8_t systemFlags = 0;
float runningAnomalySum = 0.0f;
uint32_t runningAnomalyCount = 0;
float currentAnomalyScore = 0.0f;

// Wear confidence tracking
volatile uint8_t g_wearConfidence = 0;
volatile uint32_t g_stillWindowCount = 0;

// Calibration variables
bool isCalibrating = false;
uint32_t calibrationSamplesCollected = 0;
float calibAccelSum[3] = {0.0f};

// Task function declarations
void IMUSamplerTask(void* pvParameters);
void ProcessingTask(void* pvParameters);
void HeartbeatTask(void* pvParameters);

void setup() {
    Serial.begin(115200);
    // Wait up to 4 seconds for Serial connection on USB boards
    unsigned long start_time = millis();
    while (!Serial && (millis() - start_time < 4000)) {
        delay(10);
    }
    Serial.println("\n===========================================");
    Serial.println("         SafeBand Firmware Starting        ");
    Serial.println("===========================================");

    // 1. Initialize Power/Battery Manager
    PowerManager::getInstance().begin();
    systemFlags |= (1 << 2); // Set Flash/power subsystem OK

    // 2. Initialize IMU Sensor
    if (IMUSensor::getInstance().begin()) {
        systemFlags |= (1 << 0); // Set IMU OK
    } else {
        Serial.println("[Setup] Warning: IMU initialization failed!");
    }

    // 3. Initialize Model Runner (autoencoder placeholder)
    if (ModelRunner::getInstance().begin()) {
        systemFlags |= (1 << 3); // Set Inference running
    }

    // 4. Initialize BLE Stack
    BLEManager::getInstance().begin();
    if (!(systemFlags & (1 << 3))) {
        BLEManager::getInstance().setDeviceInfo(ModelRunner::getInstance().getLastError());
    }
    systemFlags |= (1 << 1); // Set BLE OK

    // 5. Create FreeRTOS Queue (capacity: 100 samples)
    sampleQueue = xQueueCreate(100, sizeof(IMUData));
    if (sampleQueue == nullptr) {
        Serial.println("[Setup] Error: Failed to create sample queue.");
        while (1) { delay(1000); }
    }

    // 6. Spawn FreeRTOS Tasks
    Serial.printf("[Setup] Pre-task spawn free heap: %d bytes, Max block: %d bytes\n", 
                  ESP.getFreeHeap(), ESP.getMaxAllocHeap());

    // Sampler task: High priority (10), runs on Core 1 (default Arduino core)
    BaseType_t r1 = xTaskCreatePinnedToCore(
        IMUSamplerTask,
        "SamplerTask",
        3072,
        nullptr,
        10,
        &samplerTaskHandle,
        1
    );
    Serial.printf("[Setup] SamplerTask spawn result: %s\n", (r1 == pdPASS) ? "SUCCESS" : "FAILED");

    // Processing task: Medium priority (5), runs on Core 1 (handles heavy float/FFT maths)
    BaseType_t r2 = xTaskCreatePinnedToCore(
        ProcessingTask,
        "ProcessingTask",
        4096,
        nullptr,
        5,
        &processingTaskHandle,
        1
    );
    Serial.printf("[Setup] ProcessingTask spawn result: %s\n", (r2 == pdPASS) ? "SUCCESS" : "FAILED");

    // Heartbeat task: Low priority (2), runs on Core 0 (handles BLE state and slow ADC)
    BaseType_t r3 = xTaskCreatePinnedToCore(
        HeartbeatTask,
        "HeartbeatTask",
        3072,
        nullptr,
        2,
        &heartbeatTaskHandle,
        0
    );
    Serial.printf("[Setup] HeartbeatTask spawn result: %s\n", (r3 == pdPASS) ? "SUCCESS" : "FAILED");

    Serial.println("[Setup] FreeRTOS task scheduler started.");
}

void loop() {
    // Empty. FreeRTOS task scheduler manages the execution loops.
    vTaskDelete(nullptr);
}

// 1. Sensor Sampler Task (Runs at 100 Hz)
void IMUSamplerTask(void* pvParameters) {
    TickType_t xLastWakeTime = xTaskGetTickCount();
    const TickType_t xFrequency = pdMS_TO_TICKS(SAMPLE_INTERVAL_MS); // 10ms

    IMUData sample;
    uint32_t rawStreamDivider = 0;

    Serial.println("[Task] Sampler task active.");

    while (1) {
        // Precise 100 Hz sampling interval
        vTaskDelayUntil(&xLastWakeTime, xFrequency);

        // Read sample
        if (IMUSensor::getInstance().readSample(sample)) {
            // Push sample to processing queue
            if (xQueueSend(sampleQueue, &sample, 0) != pdTRUE) {
                // Queue full: processing task is lagging
                // Increment drop counters or ignore in normal use
            }

            // Stream raw data at 25 Hz if streaming is enabled
            if (BLEManager::getInstance().isStreamingEnabled()) {
                rawStreamDivider++;
                if (rawStreamDivider >= 10) { // 100 Hz / 10 = 10 Hz
                    rawStreamDivider = 0;
                    
                    uint16_t msSinceBoot = static_cast<uint16_t>(millis() & 0xFFFF);
                    float resultant = sqrtf(sample.ax*sample.ax + sample.ay*sample.ay + sample.az*sample.az);
                    
                    // Simple jerk estimate for stream (last value difference)
                    static float lastRes = 0.0f;
                    float jerk = (resultant - lastRes) * 100.0f;
                    lastRes = resultant;

                    BLEManager::getInstance().sendSensorPacket(
                        msSinceBoot,
                        sample,
                        resultant,
                        jerk,
                        static_cast<uint8_t>(fminf(fmaxf(roundf(currentAnomalyScore / 0.00441764f), 0.0f), 255.0f))
                    );
                }
            } else {
                rawStreamDivider = 0;
            }
        }
    }
}

// 2. Feature Extraction and Anomaly Detection Task
void ProcessingTask(void* pvParameters) {
    IMUData sample;
    static float features[TOTAL_FEATURES];
    uint32_t consecutiveAnomalyWindows = 0;
    
    Serial.println("[Task] Processing task active.");

    while (1) {
        // Read samples from queue (blocking until sample is available)
        if (xQueueReceive(sampleQueue, &sample, portMAX_DELAY) == pdTRUE) {
            // Check and process deferred BLE commands in thread-safe context
            if (BLEManager::getInstance().hasPendingCommand()) {
                uint8_t cmd = BLEManager::getInstance().getPendingCommand();
                BLEManager::getInstance().processCommand(cmd);
            }
            
            // Handle active calibration mode
            if (isCalibrating) {
                calibAccelSum[0] += sample.ax;
                calibAccelSum[1] += sample.ay;
                calibAccelSum[2] += sample.az;
                calibrationSamplesCollected++;
                
                if (calibrationSamplesCollected >= 1000) { // 10 seconds of data
                    isCalibrating = false;
                    float meanX = calibAccelSum[0] / 1000.0f;
                    float meanY = calibAccelSum[1] / 1000.0f;
                    float meanZ = calibAccelSum[2] / 1000.0f;
                    Serial.printf("[Calib] Completed! Baseline averages: Ax=%.3fg, Ay=%.3fg, Az=%.3fg\n", meanX, meanY, meanZ);
                }
                continue;
            }

            // Check if calibration was requested via BLE command
            if (BLEManager::getInstance().isCalibrationRequested()) {
                BLEManager::getInstance().clearCalibrationRequest();
                isCalibrating = true;
                calibrationSamplesCollected = 0;
                calibAccelSum[0] = calibAccelSum[1] = calibAccelSum[2] = 0.0f;
                Serial.println("[Calib] Starting 10-second baseline collection. Keep device still.");
                FeatureExtractor::getInstance().reset();
                continue;
            }

            // Add sample to the Feature Engineering sliding window
            if (FeatureExtractor::getInstance().addSample(sample, features)) {
                // A new window of 200 samples is ready (triggered every 50 sample stride)
                
                 // Monitor wear confidence: track motion variance (trace of covariance matrix at features[1325])
                 float totalVariance = features[1325];
                 if (totalVariance < 100.0f) {
                     g_stillWindowCount++;
                     if (g_stillWindowCount > 120) g_stillWindowCount = 120; // Cap at 1 minute of stillness
                 } else if (totalVariance > 1000.0f) {
                     g_stillWindowCount = 0;
                     g_wearConfidence = 100; // Active movement resets wear state immediately
                 } else {
                     // Moderate variance (100 to 1000): decrement still count to allow still hand to stay worn,
                     // but prevent single table bumps from resetting wear confidence.
                     if (g_stillWindowCount > 30) {
                         g_stillWindowCount -= 30; // 15 seconds credit per active window
                     } else {
                         g_stillWindowCount = 0;
                     }
                     if (g_stillWindowCount <= 60) {
                         g_wearConfidence = 100;
                     }
                 }

                 if (g_stillWindowCount > 60) { // 60 windows * 0.5s stride = 30 seconds
                     // Decay wear confidence from 100% to 0% over the next 30 seconds (total 1 minute to 0%)
                     float decayFraction = (g_stillWindowCount - 60) / 60.0f;
                     if (decayFraction > 1.0f) decayFraction = 1.0f;
                     g_wearConfidence = static_cast<uint8_t>((1.0f - decayFraction) * 100.0f);
                 }

                // Run anomaly detection inference
                int8_t motionEmbedding[16] = {0};
                float anomalyScore = ModelRunner::getInstance().runInference(features, motionEmbedding);

                 // Suppress false-positive anomalies when the device is completely still or unworn and not in an active alarm sequence
                 if ((totalVariance < 100.0f || g_wearConfidence < 40) && consecutiveAnomalyWindows == 0) {
                     anomalyScore = 0.0f;
                 }

                currentAnomalyScore = anomalyScore;

                // Accumulate statistics for the 30s heartbeat average
                runningAnomalySum += anomalyScore;
                runningAnomalyCount++;

                float twelveFeatures[12] = {
                    features[1203], // std
                    features[1212], // rms
                    features[1221], // skew
                    features[1230], // kurtosis
                    features[1239], // zcr
                    features[1278], // dom_freq
                    features[1284], // entropy
                    features[1290], // peak_ratio
                    features[1314], // band_energy
                    features[1323], // lambda1_ratio
                    features[1325], // total_variance
                    (fabsf(features[1327]) + fabsf(features[1328]) + fabsf(features[1329])) / 3.0f // coupling
                };

                // Correct feature indexing:
                // dominantFreq of Ax in last sub-window: index 1278
                float dominantFreq = features[1278]; 

                 // Motion State Bitmask calculation:
                 // Bit 0: Still, Bit 1: Periodic, Bit 2: Aperiodic, Bit 3: High-Impact, Bit 4: Restrained
                 uint8_t motionState = 0;
                 if (totalVariance < 100.0f) {
                     motionState |= (1 << 0); // Still
                } else if (totalVariance > 80000.0f || (features[1212] > 30.0f && totalVariance > 30000.0f)) {
                    motionState |= (1 << 3); // High-Impact
                } else if (dominantFreq >= 1.0f && dominantFreq <= 3.0f && features[1290] >= 0.35f) {
                    motionState |= (1 << 1); // Periodic (walking/running rhythm)
                } else {
                    motionState |= (1 << 2); // Aperiodic (struggle/random)
                }

                 // Check for post-impact restraint (low variance during alarm countdown)
                 if (consecutiveAnomalyWindows > 6 && totalVariance < 100.0f) {
                     motionState |= (1 << 4); // Restrained
                 }

                if (ModelRunner::getInstance().isTensorsAllocated()) {
                    motionState |= (1 << 7); // Bit 7: Model Allocated successfully
                }

                uint8_t scaledScore = static_cast<uint8_t>(fminf(fmaxf(roundf(anomalyScore / 0.00441764f), 0.0f), 255.0f));

                // Send live 2 Hz feature stream to the mobile app for dynamic gauges
                if (BLEManager::getInstance().isConnected()) {
                    BLEManager::getInstance().sendFeaturePacket(
                        0, // Will be set/incremented inside BLEManager
                        scaledScore,
                        motionState,
                        static_cast<uint8_t>(dominantFreq * 2.0f),
                        static_cast<uint8_t>(features[1239] * 255.0f), // ZCR of Resultant
                        static_cast<uint8_t>(features[1284] * 255.0f), // Spectral Entropy Ax
                        static_cast<uint16_t>(features[1323] * 1000.0f), // Eigenvalue linearity ratio
                        g_wearConfidence,
                        static_cast<uint16_t>(features[1212] * 1.5f * 101.97162f), // Peak accel proxy (Resultant RMS)
                        static_cast<uint16_t>(consecutiveAnomalyWindows * 5), // Duration in 100ms units
                        motionEmbedding,
                        0, // isThreat = 0 (Normal)
                        twelveFeatures
                    );
                }

                // Evaluate Hysteresis Anomaly Logic (Suppressed if unworn)
                if (anomalyScore > DEFAULT_THRESHOLD && g_wearConfidence >= 40) {
                    consecutiveAnomalyWindows++;
                    Serial.printf("[Inference] Alert! Score = %.3f (Consecutive: %d)\n", anomalyScore, consecutiveAnomalyWindows);
                    
                    if (consecutiveAnomalyWindows >= HYSTERESIS_WINDOWS) {
                        // Sustained anomaly detected! Trigger event notification
                        if (!BLEManager::getInstance().isEventAcknowledged()) {
                            
                            // Scale confidence based on persistence
                            uint8_t confidence = 33;
                            if (consecutiveAnomalyWindows >= 11) confidence = 99;
                            else if (consecutiveAnomalyWindows >= 8) confidence = 66;

                            uint8_t durationUnits = static_cast<uint8_t>(consecutiveAnomalyWindows * 5); // Stride 50 samples = 0.5s = 5 units

                            BLEManager::getInstance().sendFeaturePacket(
                                0, // seq
                                scaledScore,
                                motionState,
                                static_cast<uint8_t>(dominantFreq * 2.0f),
                                static_cast<uint8_t>(features[1239] * 255.0f), // ZCR of Resultant
                                static_cast<uint8_t>(features[1284] * 255.0f), // Spectral Entropy Ax
                                static_cast<uint16_t>(features[1323] * 1000.0f), // Eigenvalue linearity ratio
                                g_wearConfidence,
                                static_cast<uint16_t>(features[1212] * 1.5f * 101.97162f), // Peak accel proxy (Resultant RMS)
                                static_cast<uint16_t>(consecutiveAnomalyWindows * 5), // Duration in 100ms units
                                motionEmbedding,
                                1, // isThreat = 1 (Threat Alert Event!)
                                twelveFeatures
                            );
                        }
                    }
                } else {
                    // Reset consecutive window counter when score falls below threshold or device is unworn
                    if (consecutiveAnomalyWindows > 0) {
                        Serial.printf("[Inference] Normal/Unworn. Score = %.3f. Resetting alarm counter.\n", anomalyScore);
                        consecutiveAnomalyWindows = 0;
                        BLEManager::getInstance().setEventAcknowledged(false); // Reset ack for next event
                    }
                }
            }
        }
    }
}

// 3. Heartbeat and Status Monitoring Task (Runs checks every 500ms, sends status every 30s)
void HeartbeatTask(void* pvParameters) {
    TickType_t xLastWakeTime = xTaskGetTickCount();
    const TickType_t xFrequency = pdMS_TO_TICKS(500); // Check status every 500ms
    uint32_t statusCounter = 0;

    Serial.println("[Task] Heartbeat status task active.");

    while (1) {
        // Run every 500ms
        vTaskDelayUntil(&xLastWakeTime, xFrequency);

        // Manage connection events and re-advertising
        BLEManager::getInstance().handleConnectionStatus();

        statusCounter++;
        if (statusCounter >= 60) { // 60 * 500ms = 30 seconds
            statusCounter = 0;

            if (BLEManager::getInstance().isConnected()) {
                uint8_t batteryPct = PowerManager::getInstance().readBatteryPercentage();
                uint16_t uptimeMinutes = static_cast<uint16_t>(millis() / 60000);
                
                // Calculate 60s rolling average anomaly score
                uint8_t avgAnomaly = 0;
                if (runningAnomalyCount > 0) {
                    avgAnomaly = static_cast<uint8_t>(fminf(fmaxf(roundf((runningAnomalySum / runningAnomalyCount) / 0.00441764f), 0.0f), 255.0f));
                    // Reset rolling accumulations
                    runningAnomalySum = 0.0f;
                    runningAnomalyCount = 0;
                }

                // Wear confidence based on sensor activity monitoring over time
                uint8_t wearConfidence = g_wearConfidence; 

                // Send standard Status Packet (Type 0x02)
                BLEManager::getInstance().sendStatusPacket(
                    batteryPct,
                    wearConfidence,
                    systemFlags,
                    uptimeMinutes,
                    avgAnomaly,
                    20 // 2.0 Hz inference rate (multiplied by 10)
                );
                
                 Serial.printf("[Heartbeat] Status Packet Sent. Uptime: %d mins, Battery: %d%%, WearConfidence: %d%%\n", uptimeMinutes, batteryPct, wearConfidence);
            }
        }
    }
}