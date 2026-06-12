/*
 * MPU6050 → BLE Data Streamer  v4
 * XIAO ESP32-S3 — SafeBand Data Collection Firmware
 *
 * Wiring (XIAO ESP32-S3):
 *   MPU6050 VCC  → 3V3
 *   MPU6050 GND  → GND
 *   MPU6050 SDA  → D4  (GPIO 5)
 *   MPU6050 SCL  → D5  (GPIO 6)
 *   MPU6050 AD0  → GND  (I2C address 0x68)
 *
 * Improvements in v4:
 *   - Configured Accel range to ±16g and Gyro range to ±1000°/s to eliminate clipping.
 *   - Implemented real-time sampling in a dedicated high-priority FreeRTOS task on Core 0.
 *   - Replaced manual volatile ring buffer with thread-safe FreeRTOS Queue.
 *   - Decoupled BLE sending from sensor sampling to completely prevent timestamp gaps (>10ms).
 *   - Retained automatic minimum connection interval request (7.5ms) after BLE connection.
 *
 * Dependencies:
 *   - Adafruit MPU6050 + Adafruit Unified Sensor + Adafruit BusIO
 *   - ESP32 BLE Arduino (bundled with esp32 board package)
 */

#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ── Config ────────────────────────────────────────────────────────────────────
#define SDA_PIN           5           // D4 on XIAO ESP32-S3
#define SCL_PIN           6           // D5 on XIAO ESP32-S3
#define SAMPLE_RATE_HZ    100
#define SAMPLE_INTERVAL_MS (1000 / SAMPLE_RATE_HZ)  // 10 ms

// Batch: pack N samples into one BLE notify to reduce connection-interval impact.
// At 100 Hz, BATCH_SIZE=4 means one packet per 40ms.
#define BATCH_SIZE        4

// FreeRTOS Queue Capacity — depth of 128 holds up to 1.28 seconds of motion data
#define BUFFER_SIZE       128

// Set to 1 to enable Serial debug. Prints stats in loop() on Core 1.
#define SERIAL_DEBUG      1

// ── BLE UUIDs ─────────────────────────────────────────────────────────────────
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

// ── IMU sample struct ─────────────────────────────────────────────────────────
struct Sample {
  uint32_t ts_ms;         // ESP32 millis() at moment of sampling
  float ax, ay, az;
  float gx, gy, gz;
};

// ── Globals ───────────────────────────────────────────────────────────────────
Adafruit_MPU6050   mpu;
BLEServer*         pServer         = nullptr;
BLECharacteristic* pCharacteristic = nullptr;
bool               deviceConnected = false;
bool               oldConnected    = false;

// Shared FreeRTOS queue for buffering IMU samples between Core 0 and Core 1
QueueHandle_t      sampleQueue     = NULL;

// Statistics variables
volatile uint32_t  droppedSamples  = 0;
volatile uint32_t  sampleCounter   = 0;
volatile uint32_t  packetCounter   = 0;
volatile uint32_t  totalGenerated  = 0;
volatile uint32_t  totalSent       = 0;

uint32_t           lastDropped     = 0;
unsigned long      lastStatsTime   = 0;
static uint32_t    previousTs      = 0;

// ── Connection callbacks ──────────────────────────────────────────────────────
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pSrv) override {
    deviceConnected = true;
    sampleCounter = 0;
    packetCounter = 0;
    totalGenerated = 0;
    totalSent = 0;
    droppedSamples = 0;
    lastDropped = 0;
    lastStatsTime = millis();
    
    // Request short connection interval parameters from the phone
    pSrv->updateConnParams(
      pSrv->getConnId(),   // conn id
      6,                   // minInterval  (6 × 1.25ms = 7.5ms)
      12,                  // maxInterval  (12 × 1.25ms = 15ms)
      0,                   // latency      (0 = respond every interval)
      400                  // timeout      (400 × 10ms = 4s supervision)
    );

#if SERIAL_DEBUG
    Serial.println("[BLE] Phone connected — requested 7.5–15ms connection interval");
#endif
  }

  void onDisconnect(BLEServer* pSrv) override {
    deviceConnected = false;
#if SERIAL_DEBUG
    Serial.println("[BLE] Disconnected. Restarting advertising…");
#endif
  }
};

// ── FreeRTOS Real-Time Sampling Task (Core 0) ──────────────────────────────────
void samplingTask(void* parameter) {
  TickType_t xLastWakeTime = xTaskGetTickCount();
  const TickType_t xFrequency = pdMS_TO_TICKS(SAMPLE_INTERVAL_MS); // Strict 10 ms delay

#if SERIAL_DEBUG
  Serial.println("[SYSTEM] Real-time sampling task started on Core 0");
#endif

  for (;;) {
    // Suspend until next 10ms boundary
    vTaskDelayUntil(&xLastWakeTime, xFrequency);

    if (deviceConnected) {
      sensors_event_t accel, gyro, temp;
      mpu.getEvent(&accel, &gyro, &temp);

      uint32_t sampleTime = millis();

      // Monitor sample rate consistency
      if (previousTs != 0) {
        uint32_t dt = sampleTime - previousTs;
        if (dt > 12 || dt < 8) {
#if SERIAL_DEBUG
          Serial.printf("[WARN] Sample spacing abnormal: %lu ms\n", (unsigned long)dt);
#endif
        }
      }
      previousTs = sampleTime;

      // Pack sample data
      Sample s;
      s.ts_ms = sampleTime;
      s.ax = accel.acceleration.x;
      s.ay = accel.acceleration.y;
      s.az = accel.acceleration.z;
      s.gx = gyro.gyro.x * 57.2958f; // Rad/s to Deg/s
      s.gy = gyro.gyro.y * 57.2958f;
      s.gz = gyro.gyro.z * 57.2958f;

      totalGenerated++;
      sampleCounter++;

      // Send to the queue (non-blocking)
      if (sampleQueue != NULL) {
        if (xQueueSend(sampleQueue, &s, 0) != pdPASS) {
          droppedSamples++;
        }
      }
    } else {
      previousTs = 0; // Reset tracking timestamp when disconnected
    }
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
#if SERIAL_DEBUG
  Serial.begin(115200);
  delay(400);
  Serial.println("\n=== SafeBand IMU Streamer v4 (Multi-Tasking) ===");
#endif

  // ── MPU6050 ────────────────────────────────────────────────────────────────
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(400000);   // 400 kHz Fast I2C

  while (!mpu.begin()) {
#if SERIAL_DEBUG
    Serial.println("[ERROR] MPU6050 not found — check wiring");
#endif
    delay(500);
  }

  // Set ranges to prevent clipping under intense movements
  mpu.setAccelerometerRange(MPU6050_RANGE_16_G);    // ±16g range (approx ±156.9 m/s²)
  mpu.setGyroRange(MPU6050_RANGE_1000_DEG);        // ±1000 deg/s range (can increase to 2000 if needed)
  
  // Low pass filter bandwidth set to 44 Hz
  mpu.setFilterBandwidth(MPU6050_BAND_44_HZ);

#if SERIAL_DEBUG
  Serial.println("[IMU] MPU6050 ready: ±16g, ±1000°/s, LPF 44Hz");
#endif

  // Create thread-safe FreeRTOS Queue
  sampleQueue = xQueueCreate(BUFFER_SIZE, sizeof(Sample));
  if (sampleQueue == NULL) {
#if SERIAL_DEBUG
    Serial.println("[ERROR] Queue creation failed!");
#endif
    while (1) delay(10);
  }

  // ── BLE ────────────────────────────────────────────────────────────────────
  BLEDevice::init("SafeBand-IMU");
  BLEDevice::setPower(ESP_PWR_LVL_P9); // Maximum Tx Power

  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService* pService = pServer->createService(SERVICE_UUID);
  pCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_UUID,
    BLECharacteristic::PROPERTY_NOTIFY
  );
  pCharacteristic->addDescriptor(new BLE2902());
  pService->start();

  BLEAdvertising* pAdv = BLEDevice::getAdvertising();
  pAdv->addServiceUUID(SERVICE_UUID);
  pAdv->setScanResponse(true);
  pAdv->setMinPreferred(0x06);
  BLEDevice::startAdvertising();

#if SERIAL_DEBUG
  Serial.println("[BLE] Advertising as 'SafeBand-IMU'");
#endif

  // ── Start Real-Time Sampling Task on Core 0 ────────────────────────────────
  xTaskCreatePinnedToCore(
    samplingTask,         // Task function
    "SamplingTask",       // Name
    4096,                 // Stack size
    NULL,                 // Parameters
    10,                   // High priority (preempts loopTask)
    NULL,                 // Task handle
    0                     // Core 0 (isolated from Arduino loop & BLE notifications)
  );
}

// ── Main loop (Core 1) ────────────────────────────────────────────────────────
void loop() {
  static unsigned long lastRecon = 0;

  // ── Reconnect handling ────────────────────────────────────────────────────
  if (!deviceConnected && oldConnected) {
    unsigned long now = millis();
    if (now - lastRecon > 200) {
      lastRecon = now;
      pServer->startAdvertising();
      oldConnected = false;
      
      // Clear stale buffers on disconnect
      if (sampleQueue != NULL) {
        xQueueReset(sampleQueue);
      }
    }
  }
  if (deviceConnected && !oldConnected) {
    oldConnected = true;
  }

  // ── Drain queue → BLE notification (batched) ──────────────────────────────
  if (deviceConnected && sampleQueue != NULL && uxQueueMessagesWaiting(sampleQueue) >= BATCH_SIZE) {
    char packet[256];
    int  offset = 0;
    bool success = true;

    for (uint8_t i = 0; i < BATCH_SIZE; i++) {
      Sample s;
      if (xQueueReceive(sampleQueue, &s, 0) == pdPASS) {
        offset += snprintf(packet + offset, sizeof(packet) - offset,
          "%lu,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f\n",
          (unsigned long)s.ts_ms, s.ax, s.ay, s.az, s.gx, s.gy, s.gz);
      } else {
        success = false;
        break;
      }
    }

    if (success && offset > 0) {
      pCharacteristic->setValue((uint8_t*)packet, offset);
      pCharacteristic->notify();
      packetCounter++;
      totalSent += BATCH_SIZE;
    }
  }

  // ── Print stats once per second ───────────────────────────────────────────
#if SERIAL_DEBUG
  if (millis() - lastStatsTime >= 1000) {
    lastStatsTime = millis();

    Serial.printf(
        "[STATS] Samples/s=%lu Packets/s=%lu BufferUsed=%u\n"
        "         Generated=%lu Sent=%lu Dropped=%lu DeltaDrop=%lu\n",
        sampleCounter,
        packetCounter,
        (sampleQueue != NULL) ? uxQueueMessagesWaiting(sampleQueue) : 0,
        totalGenerated,
        totalSent,
        droppedSamples,
        droppedSamples - lastDropped
    );

    lastDropped = droppedSamples;
    sampleCounter = 0;
    packetCounter = 0;
  }
#endif
  
  // Yield to avoid starving IDLE tasks on Core 1
  delay(2);
}