# SafeBand Model & Firmware — Technical Guide
## Edge Computing, Signal Processing, & TinyML

---

## 1. Firmware Task Architecture (FreeRTOS)
The SafeBand firmware runs on an **ESP32-S3** microcontroller (dual-core Tensilica Xtensa, 240 MHz, with vectors/AI acceleration instructions). The firmware uses **FreeRTOS** to schedule three concurrent execution threads:

```
        +-------------------------------------------------------+
        |                  IMU Sampler Task                     | <-- Core 1, Priority 10
        |  Read 6-axis data @ 100 Hz (every 10ms)               |
        |  Optional: Push SENSOR packets @ 25 Hz to BLE        |
        +---------------------------+---------------------------+
                                    |
                                    | (Pushes to FreeRTOS Queue)
                                    v
        +-------------------------------------------------------+
        |                 Processing Task                       | <-- Core 1, Priority 5
        |  Pulls samples from Queue. Builds 200-sample window.  |
        |  Extracts 1326 features every 50-sample stride (0.5s).|
        |  Runs TFLite Micro Autoencoder inference (2 Hz).      |
        |  Calculates motion state & wear confidence.           |
        |  Pushes FEATURE (2 Hz) or EVENT packets to BLE.      |
        +-------------------------------------------------------+

        +-------------------------------------------------------+
        |                 Heartbeat Task                        | <-- Core 0, Priority 2
        |  Checks BLE connection state & handles advertising.   |
        |  Every 30 seconds: Sends STATUS packet to BLE         |
        |  (Battery %, uptime, system flags, rolling avg MAE).  |
        +-------------------------------------------------------+
```

### A. IMU Sampler Task (100 Hz, Core 1, Priority 10)
* Runs exactly once every 10ms using `vTaskDelayUntil`.
* Queries the LSM6DSOX IMU via I2C to read acceleration ($a_x, a_y, a_z$ in g-force units) and angular velocity ($g_x, g_y, g_z$ in dps).
* Pushes raw `IMUData` objects into a FreeRTOS thread-safe queue.
* If sensor streaming is enabled by the mobile app, it down-samples the stream to **25 Hz** and transmits raw IMU data as `SENSOR` packets (Type `0x03`).

### B. Feature Processing Task (2 Hz, Core 1, Priority 5)
* Blocks on the IMU sample queue waiting for data.
* Feeds samples into the sliding window pipeline.
* When 50 new samples arrive (representing 0.5s of time = 2 Hz tick rate), it process a **200-sample sliding window** (2.0 seconds of physical data).
* Performs Feature Engineering to compute a **1326-dimensional float vector**.
* Runs TFLite Micro inference on the 1326-dimensional vector to determine anomaly scores and motion embeddings.
* Transmits telemetry to the phone as `FEATURE` packets (Type `0x04`).

### C. Heartbeat Task (Every 30s, Core 0, Priority 2)
* Handles BLE advertising and connection loss events.
* Every 30 seconds, it measures battery charge voltage (ADC reading via the PowerManager) and uptime (minutes since boot).
* Computes the rolling average anomaly score over the last 30s.
* Transmits telemetry to the phone as a `STATUS` packet (Type `0x02`).

---

## 2. Signal Preprocessing & Feature Engineering

The `FeatureExtractor` module calculates a 1326-dimensional vector from each 200-sample window of 6-axis IMU data. This includes:
1. **Resultant Acceleration:** Calculates $R = \sqrt{a_x^2 + a_y^2 + a_z^2}$ to make signal analysis orientation-invariant.
2. **Frequency Domain Features (FFT):** Calculates the Fast Fourier Transform (FFT) on the acceleration signals to extract:
   - Dominant frequency component (rhythmic movements like walking/running vs. chaotic movements)
   - Spectral entropy (measures signal order vs. chaos)
   - Zero-Crossing Rate (ZCR)
3. **Statistical Features:** Computes standard deviations, means, and peak-to-peak ranges.
4. **Covariance Matrix:** Evaluates signal variance and cross-correlations.

---

## 3. TinyML Model Architecture (TFLite Micro Autoencoder)

The core anomaly detection engine is a **Convolutional Autoencoder** running on Google's `TensorFlow Lite for Microcontrollers` runtime.

```
                  +--------------------------------+
                  |  Input: 1326 Features Float    |
                  +---------------+----------------+
                                  |
                                  v  (Encoder layers)
                  +---------------+----------------+
                  |  16-Dimensional Bottleneck     | <-- "Motion Embedding"
                  +---------------+----------------+
                                  |
                                  v  (Decoder layers)
                  +---------------+----------------+
                  |  Output: 1326 Features Float   |
                  +---------------+----------------+
                                  |
                                  +---> Reconstruction Error (MAE)
```

* **Operating Principle:** The autoencoder is trained exclusively on **normal human motion** (walking, sitting, standing, typing, sleeping). It learns to compress this normal behavior into a compact 16-dimensional bottleneck space and reconstruct it perfectly at the output layer.
* **Anomaly Index:** When the user performs an **abnormal/anomalous movement** (e.g., a fall, struggle, or seizure), the compression-reconstruction link breaks. The reconstructed output deviates significantly from the input. The Mean Absolute Error (MAE) between the input and output is calculated as the **Anomaly Score**.
* **Calibrated Threshold:** The MAE threshold is set to **`1.01309`** (calibrated over 20 training epochs). Any score above this is treated as anomalous.

---

## 4. Edge-Level Safety Systems & Logic

### A. Wear Confidence & Idle Decay
To prevent alarms when the band is sitting on a table, the device monitors the trace of the IMU covariance matrix (total signal variance).
* **Stillness Check:** If variance $< 100$ (representing no physical movement), the device increment a still counter.
* **Confidence Decay:** If the device is still for longer than 5 minutes, wear confidence decays linearly from 100% to 0% over the next 5 minutes.
* **Suppression:** Anomaly scores are ignored, and alert events are suppressed, if the wear confidence drops below **40%**.
* **Reset:** Wear confidence resets to 100% immediately when motion variance exceeds 100.

### B. Hysteresis Alarm Filter
To avoid false triggers from transient acceleration spikes (e.g., slamming a door or clapping hands), the firmware uses a temporal accumulator:
* **Hysteresis Windows:** The anomaly score must exceed `1.01309` for **5 consecutive windows** (2.5 seconds) to trigger an alarm.
* **Event Dispatch:** Once triggered, it sends an `EVENT` packet (Type `0x01`) to the phone. The device continues to transmit events until the mobile app sends an Acknowledge command (`0x04`) or Cancel command (`0xFF`).

---

## 5. Integer Quantization & Scaling

The autoencoder model runs in **int8 integer-quantized mode** on the microcontroller to optimize memory consumption and utilize the ESP32-S3's vector instructions.

### Quantization Formulas:
The firmware quantizes the inputs and dequantizes the outputs using parameters saved in `model_data.h`:

$$\text{Reconstruction Error (MAE):} \quad \text{Value}_{\text{float}} = (\text{Value}_{\text{int8}} - (-128)) \times 0.00441764$$
$$\text{Motion Embedding (16D):} \quad \text{Value}_{\text{float}} = (\text{Value}_{\text{int8}} - (-93)) \times 0.01699736$$

On BLE transmission, raw `int8` values are sent directly over the air to save bandwidth. The mobile application applies these formulas in `BleService.js` to reconstruct the float values.

---

## 6. Critical Micro-Runtime Fixes

During integration of the convergent 20-epoch model, three runtime modifications were implemented:

1. **Static Arena Allocation:** 
   Dynamic heap allocations for the TFLite tensor arena were causing fragmentation and crashes. The arena was refactored into a static BSS memory pool:
   ```cpp
   alignas(16) static uint8_t tensor_arena[140 * 1024]; // 140 KB static allocation
   ```
2. **Reshape Operator Flash-Override Fix:**
   TFLite Micro's `RESHAPE` operator tries to write shape data directly to the dimensions array. Because the model structure was loaded in Read-Only Flash (`model_data.h`), the write caused a hardware exception. The runtime was modified to copy shape dimensions to RAM (`CreateWritableTensorDimsWithCopy`) before executing the reshape.
3. **Gather Operator Int32 Refactoring:**
   The `GATHER` operator was configured to support only Float32 and Int8 tensors. The newer model introduced an Int32 shape/index tensor. The operator was refactored to support Int32 lookups.
