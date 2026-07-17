# SafeBand — Edge-TinyML Anomaly Detection & Context-Aware Emergency Dispatch System

SafeBand is a hybrid IoT and mobile system designed for real-time human anomaly detection (e.g., falls, struggles, seizures) using low-latency, privacy-first edge computation. The system comprises an **ESP32-S3-powered smart wristband** running local TensorFlow Lite Micro inference, and a **React Native (Expo) mobile coordinator app** that applies temporal, spatial, and circadian context to evaluate threat levels and dispatch alerts to emergency contacts.

---

## 1. Problem Statement

Standard wearable safety and medical-alert devices face critical limitations that hinder their effectiveness and adoption:

1. **High Latency & Cloud Dependence**: Conventional wearables stream raw sensor waveforms to a remote cloud server for anomaly detection. This makes alerts dependent on stable cellular connections and introduces round-trip network latency, which can be life-threatening in time-sensitive emergency situations (e.g., fall with head injury or seizure).
2. **Severe Battery & Bandwidth Consumption**: Continuous streaming of raw 100 Hz multi-axis accelerometer and gyroscope signals rapidly exhausts wearable device battery life (often requiring daily charges) and consumes significant user data plans.
3. **Privacy Concerns**: Uploading raw, continuous biomechanical waveforms exposes the user's high-resolution behavioral profiles and habits, presenting a severe privacy risk.
4. **Frequent False Alarms**: Standard systems operate on static, global thresholds (e.g., simple acceleration thresholds). They do not adapt to individual baseline behaviors, resulting in excessive false triggers (e.g., clapping, slamming a door, high-intensity exercise) that lead to user fatigue and system deactivation.
5. **Coercion & Attacker Disabling (Duress)**: During personal safety threats, standard device alarms can be disabled easily by an attacker or the user under coercion. There is no discreet mechanism to signal danger when forced to cancel an alert.

---

## 2. The SafeBand Solution

SafeBand mitigates these issues through a split-inference edge-to-mobile architecture:

* **Edge Anomaly Detection (TinyML)**: Rather than streaming raw data, a Convolutional Autoencoder runs on the wristband via **TensorFlow Lite Micro (TFLM)**. It processes raw IMU signals locally to compute an anomaly score (based on Reconstruction Mean Absolute Error). Only low-rate, 16D behavioral vectors (embeddings) and threshold-breach events are transmitted.
* **Privacy by Design**: Raw inertial data never leaves the wristband. The user's biometric waveforms remain private, and the low-frequency BLE transmission saves significant battery.
* **Local Context Evaluation**: The mobile app aggregates local telemetry and matches it against learned spatial location nodes (LocationEngine) and historical behavior baselines (ContextEngine). It reduces false alarms by dampening alerts in highly familiar contexts (e.g., tripping at home) while escalating them in unfamiliar contexts (e.g., falling in a remote location).
* **Duress Cancel Safeguards**: To handle personal security threats, cancelling a countdown requires a 4-digit PIN. Entering a pre-configured **Fake (Duress) PIN** visually cancels the countdown on screen to satisfy an attacker, but silently triggers emergency dispatches in the background with a `[WARNING: DURESS COERCION]` flag.
* **Automated Parallel Dispatch**: In an emergency, the app automatically translates GPS coordinates into reverse-geocoded physical addresses and dispatches alerts concurrently through SMS (Twilio), Email (Resend), and WhatsApp.

---

## 3. End-to-End System Architecture

The following diagram illustrates how raw IMU signals measured on the wristband are converted into emergency alerts dispatched to contacts:

```mermaid
graph TD
    %% Hardware Layer
    subgraph WRISTBAND_HARDWARE [Wristband Hardware & RTOS]
        IMU["LSM6DSOX IMU (100 Hz Raw Accel/Gyro)"]
        QUEUE["FreeRTOS Sample Queue"]
        FE["Feature Extractor (200-sample window)"]
        TFLM["TFLite Micro (Autoencoder Model)"]
        WEAR["Wear Detection (Idle Variance check)"]
        HYS["Hysteresis Filter (5 windows check)"]
    end

    %% BLE Transmission
    subgraph BLE_CHANNEL [BLE Communication]
        FEATURE_PACKET["FEATURE packet (Type 0x04, 2 Hz)"]
        EVENT_PACKET["EVENT packet (Type 0x01, on alert)"]
        STATUS_PACKET["STATUS packet (Type 0x02, 30s)"]
    end

    %% Mobile App Processing
    subgraph MOBILE_APP [Mobile Application Layer]
        USE_BLE["useBle Hook (Negotiates MTU, monitors chars)"]
        MOTION_ENG["MotionEngine (Sliding window of 10, centroid clustering)"]
        EPISODE_ENG["EpisodeEngine (Continuous behavioral segmentation)"]
        LOC_ENG["LocationEngine (Geofencing, candidate stay learning)"]
        CTX_ENG["ContextEngine (Familiarity score L1, L2, L3)"]
        THREAT_EVAL["Threat Evaluator (App.js, merges packet & context)"]
        USE_EMG["useEmergency Hook (Countdown & Security PIN)"]
        SQLITE[("SQLite Database (Persistent storage)")]
    end

    %% Notification Gateways
    subgraph GATEWAYS [Dispatch Channels]
        TWILIO["Twilio API (SMS & WhatsApp Sandbox)"]
        RESEND["Resend API (Email)"]
        WA_LINK["WhatsApp Native client link (Hand-off)"]
    end

    %% Connections
    IMU -->|10ms tick| QUEUE
    QUEUE --> FE
    FE -->|1326 Float Vector| TFLM
    FE -->|Covariance Trace| WEAR
    TFLM -->|Anomaly Score & 16D Emb| HYS
    WEAR -->|Wear Confidence %| HYS
    
    HYS -->|Normal Telemetry| FEATURE_PACKET
    HYS -->|Hysteresis breach (5 windows)| EVENT_PACKET
    HYS -->|Periodic Heartbeat| STATUS_PACKET

    FEATURE_PACKET -.->|BLE| USE_BLE
    EVENT_PACKET -.->|BLE| USE_BLE
    STATUS_PACKET -.->|BLE| USE_BLE

    USE_BLE -->|10-Packet sliding window| MOTION_ENG
    MOTION_ENG -->|3s Stride Observation| SQLITE
    MOTION_ENG -->|Observation| EPISODE_ENG
    EPISODE_ENG -->|Episode Stats| SQLITE
    
    LOC_ENG -->|Familiarity Rating| CTX_ENG
    LOC_ENG -->|Visit logs| SQLITE
    
    SQLITE -->|30-day baseline comparison| CTX_ENG
    CTX_ENG -->|L1/L2/L3 Familiarity| THREAT_EVAL
    USE_BLE -->|Anomaly & Motion features| THREAT_EVAL
    
    THREAT_EVAL -->|Threat score >= 72%| USE_EMG
    USE_EMG -->|Dispatch commands| TWILIO
    USE_EMG -->|Dispatch commands| RESEND
    USE_EMG -->|Launch URL| WA_LINK
```

---

## 4. Component Deep Dive

### A. ESP32-S3 Firmware (`conclave/esp firmware`)
The wristband firmware runs on a Seeed Studio XIAO ESP32-S3 microcontroller connected to an LSM6DSOX IMU via I2C. The software architecture is organized as three concurrent FreeRTOS tasks:
1. **IMU Sampler Task (Core 1, Priority 10)**: Reads 6-axis acceleration ($g$) and angular velocity ($dps$) at **100 Hz** via hardware interrupts and pushes samples to a thread-safe FreeRTOS Queue.
2. **Feature Processing Task (Core 1, Priority 5)**: Pulls data from the queue. For every 50 new samples (a 2 Hz tick rate), it builds a **200-sample window** (2.0s of data) and extracts a **1326-dimensional feature vector** (calculates resultant vector, statistical properties, FFT frequency magnitudes, spectral entropy, and zero-crossing rates). It quantizes the vector to `int8`, runs inference on TensorFlow Lite Micro, and evaluates anomaly scores.
3. **Heartbeat Task (Core 0, Priority 2)**: Monitors Bluetooth connections and, every 30 seconds, reads battery status, uptime, and transmits a status heartbeat packet to the mobile application.

*   **TinyML Autoencoder Model**: The model maps 1326 input features to a 16-dimensional bottleneck space, reconstructing the output. It is trained only on normal patterns. The reconstruction Mean Absolute Error (MAE) serves as the Anomaly Score. The calibrated threshold is **`1.01309`**.
*   **Integer Quantization Formulas**:
    $$\text{Reconstruction Error (MAE):} \quad \text{Value}_{\text{float}} = (\text{Value}_{\text{int8}} - (-128)) \times 0.00441764$$
    $$\text{Motion Embedding (16D):} \quad \text{Value}_{\text{float}} = (\text{Value}_{\text{int8}} - (-93)) \times 0.01699736$$

### B. Mobile App Coordination Engines (`conclave/mobile_app`)
The mobile client is built on React Native and coordinates context-level evaluation using four background engines:
*   **MotionEngine**: Maintains a sliding buffer of the last 10 received `FEATURE` packets (representing 5.0 seconds of activity). Every 3.0 seconds, it clusters the 16D embeddings against learned centroids (using Euclidean L2 distance) to output the wearer's current activity breakdown (e.g., walking, standing, typing).
*   **EpisodeEngine**: Uses Welford's algorithm to analyze incoming activity distributions, grouping them into distinct temporal "Episodes" (e.g., sleeping, walking) to track behavior durations and anomalies without high memory footprints.
*   **LocationEngine**: Manages spatial tracking. Filters out noisy GPS signals ($> 50$m accuracy) and utilizes entry/exit hysteresis (20m/30m radii) to avoid geofence flickering. It detects candidate nodes where the user stays for $> 5$ minutes and registers them as new nodes. It returns a location familiarity score.
*   **ContextEngine**: Compares the current 15-minute behavioral profile against historical data at three levels:
    1.  *Level 1 (Session)*: Current 15-minute slot vs. the immediate last 15-30 minutes.
    2.  *Level 2 (Circadian Today)*: Current slot vs. earlier hours today.
    3.  *Level 3 (Circadian History)*: Current slot vs. the same time slot over the last 7 days.
    
    Calculates combined similarity using location matching, temporal proximity, and cosine similarity of motion embeddings:
    $$\text{Familiarity} = 0.2 \times L1 + 0.3 \times L2 + 0.5 \times L3$$

*   **Threat Evaluator**: Recalculates threat levels at 2 Hz by scaling the base edge anomaly score ($A_E$) based on spatial-behavioral familiarity ($F$):
    $$\text{Threat Score} = A_E \times (1.3 - 0.6 \times F)$$
    If the threat score reaches or exceeds **72%**, an emergency pre-alert is initiated.

---

## 5. Security & Fail-Safe Mechanisms

*   **Wear Confidence Mask**: Edge-level checks verify if the band is actually worn by calculating the trace of the IMU covariance matrix. If total variance remains below `100` (e.g., device sitting on a desk), a still counter increments. If still for $> 5$ minutes, wear confidence decays linearly to 0% over 5 minutes. If wear confidence falls below `40%`, edge anomaly triggers are suppressed to prevent false alerts.
*   **Dual-PIN Security Screen**: During the 15-second pre-alert countdown, the user must input a PIN to cancel:
    *   *Real PIN*: Halts countdown, sends a reset packet (`0xFF`) over BLE to the band, and starts a 20-second cooldown.
    *   *Duress (Coercion) PIN*: Closes the alert UI immediately as if cancelled, but silently sends the emergency location and alerts to contacts, appending the flag `[WARNING: ALERT DISPATCHED UNDER DURESS / COERCION]`.
*   **Database Cleanups**: To optimize SQLite queries, database cleanups purge all activity logs and observations older than 7 days, maintaining a clean 7-day rolling window for circadian analysis.

---

## 6. BLE Communication Protocol

During connection setup, the mobile application negotiates an **MTU size of 64 bytes** (essential to prevent packet fragmentation of 34-byte telemetry payloads). Data is exchanged using the following characteristics under the main Service UUID `4fafc201-1fb5-459e-8fcc-c5c9c331914b`:

| Characteristic UUID | Type ID | Usage | Payload Structure |
| :--- | :--- | :--- | :--- |
| `beb5483e-36e1-4688-b7f5-ea07361b26a8` (EVENT) | `0x01` | Edge Anomaly Alert | Triggered immediately when the hysteresis threshold is breached. Contains the violating anomaly score and 16D motion embedding. |
| `00002a29-0000-1000-8000-00805f9b34fb` (STATUS) | `0x02` | 30s Heartbeat | Periodic telemetry including uptime, battery %, and recent average anomaly score. |
| `00002a24-0000-1000-8000-00805f9b34fb` (SENSOR) | `0x03` | 25 Hz IMU Stream | Streaming mode for debugging; sends raw acceleration and gyroscope data (active only when charting in-app). |
| `00002a25-0000-1000-8000-00805f9b34fb` (FEATURE) | `0x04` | 2 Hz Telemetry | Active low-rate telemetry. Sends the edge quantized anomaly score and 16-dimensional motion embedding. |

---

## 7. Directory Layout

The repository is structured as follows:

*   [conclave/esp firmware/](file:///c:/Users/Shlok%20Shah/Documents/GitHub/conclave2.0/conclave/esp%20firmware): ESP32-S3 microcontroller source code.
    *   `src/`: Main application code (`main.cpp`, `ModelRunner.cpp`, `FeatureExtractor.cpp`, etc.).
    *   `include/`: Configuration and model weight headers (`model_data.h`, etc.).
    *   `platformio.ini`: PlatformIO compilation environment and libraries.
*   [conclave/mobile_app/](file:///c:/Users/Shlok%20Shah/Documents/GitHub/conclave2.0/conclave/mobile_app): React Native Expo client application.
    *   `src/`: App pages, state hooks, and core engines (`useBle.js`, `useEmergency.js`, `MotionEngine.js`, `LocationEngine.js`, `ContextEngine.js`, `EpisodeEngine.js`).
    *   `App.js`: Main layout, tabs, state management, and threat calculation.
*   [model.tflite](file:///c:/Users/Shlok%20Shah/Documents/GitHub/conclave2.0/model.tflite): The flatbuffer Convolutional Autoencoder model file.
*   [Guides & Specs](file:///c:/Users/Shlok%20Shah/Documents/GitHub/conclave2.0/conclave):
    *   [1_mobile_app_guide.md](file:///c:/Users/Shlok%20Shah/Documents/GitHub/conclave2.0/conclave/1_mobile_app_guide.md): Deep-dive into mobile components.
    *   [2_model_firmware_guide.md](file:///c:/Users/Shlok%20Shah/Documents/GitHub/conclave2.0/conclave/2_model_firmware_guide.md): In-depth review of edge hardware, quantization, and kernel repairs.
    *   [3_system_architecture_guide.md](file:///c:/Users/Shlok%20Shah/Documents/GitHub/conclave2.0/conclave/3_system_architecture_guide.md): Overall functional design.

---

## 8. Build & Installation Setup

### A. Uploading ESP32-S3 Firmware
The firmware is built using **PlatformIO**.

1.  Install the **PlatformIO IDE** extension in VS Code.
2.  Open the directory [conclave/esp firmware](file:///c:/Users/Shlok%20Shah/Documents/GitHub/conclave2.0/conclave/esp%20firmware) as a project.
3.  Connect the Seed Xiao ESP32-S3 to your computer via USB-C.
4.  Compile the codebase:
    ```bash
    pio run
    ```
5.  Upload the firmware to the device:
    ```bash
    pio run --target upload
    ```
6.  Open a serial monitor at `115200` baud (e.g., `pio device monitor`) to watch the system initialize:
    *   MPU-6050 and Tensor Arena memory initialization.
    *   `AllocateTensors() -> kTfLiteOk` confirmation message.
    *   FreeRTOS tasks launching and BLE advertising start.

### B. Launching the React Native Expo App
The mobile app requires Node.js and Expo.

1.  Navigate into the [conclave/mobile_app](file:///c:/Users/Shlok%20Shah/Documents/GitHub/conclave2.0/conclave/mobile_app) folder:
    ```bash
    cd "conclave/mobile_app"
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Start the Expo development server:
    ```bash
    npx expo start
    ```
4.  Run on an emulator or scan the QR code using the **Expo Go** app on your phone (ensure Bluetooth permissions are allowed for BLE connectivity).
