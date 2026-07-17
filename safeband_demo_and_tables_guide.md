# SafeBand: System Architecture, Database Schemas, & Demo Seeding Guide

This guide provides a technical walkthrough of the SafeBand platform, bridging the edge-inference wristband firmware and the local coordinator React Native mobile app. It details how data flows from the physical sensors to the SQLite database on the mobile device, maps out the schema of all 10 persistent storage tables, and provides step-by-step instructions (with ready-to-run SQL scripts) to populate the database for a live demonstration.

---

## 1. System Philosophy: Edge-Inference & Local Autonomy

SafeBand uses a hybrid **Edge-Inference & Local Coordination** model:
1. **Low Latency on the Edge:** A TinyML autoencoder model runs in real-time on the wristband itself. This guarantees immediate fall or struggle detection, independent of network status.
2. **Privacy by Design:** Raw high-rate IMU signals are processed locally on the band and never sent off the device. Only low-rate 16-dimensional motion embeddings and summary statistics are sent to the phone over Bluetooth Low Energy (BLE).
3. **Smart Context Fusing:** The mobile app acts as the database and notification gateway. It applies spatial context (GPS geofencing) and temporal/circadian context (comparing current behavior against a 7-day baseline) to evaluate whether a detected anomaly represents a true emergency or a false alarm.

---

## 2. ESP32-S3 Firmware Architecture (Basic Explanation)

The wristband firmware is built in C++ using **PlatformIO** and runs on a **Seeed Studio XIAO ESP32-S3** board. It leverages **FreeRTOS** to partition execution into three concurrent, prioritized tasks:

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
* Executes every 10ms using a hardware-timer-aligned FreeRTOS delay (`vTaskDelayUntil`).
* Queries the LSM6DSOX sensor via I2C to capture acceleration ($a_x, a_y, a_z$) and angular velocity ($g_x, g_y, g_z$).
* Pushes raw samples into a thread-safe FreeRTOS queue. If the app requests real-time plotting, it down-samples the stream to **25 Hz** and dispatches raw packets over BLE.

### B. Feature Processing Task (2 Hz, Core 1, Priority 5)
* Blocks on the IMU sample queue. When 50 new samples arrive (representing a 0.5-second stride), it slides a **200-sample window** (representing 2 seconds of physical motion).
* **Feature Engineering:** Computes a **1326-dimensional float vector** containing resultant acceleration ($R = \sqrt{a_x^2 + a_y^2 + a_z^2}$ for orientation invariance), Fast Fourier Transform (FFT) coefficients, spectral entropy, zero-crossing rates, covariance matrices, and statistical variances.
* **TinyML Inference:** Runs a Convolutional Autoencoder using the `TensorFlow Lite for Microcontrollers` runtime.
  - The model is trained exclusively on normal human behaviors (walking, sleeping, typing, etc.). It compresses the 1326-dimensional features into a **16D bottleneck layer** ("Motion Embedding") and attempts to reconstruct the original features.
  - **Anomaly Metric:** If the movement is abnormal (e.g., a fall, spasm, or collision), the reconstruction fails. The Mean Absolute Error (MAE) between the input and output acts as the **Anomaly Score**. If the MAE exceeds a calibrated threshold of **`1.01309`** for **5 consecutive windows** (2.5 seconds), the band triggers an alert.
* Dispatches telemetry over BLE using `FEATURE` (Type `0x04`) or `EVENT` (Type `0x01`) packets.

### C. Heartbeat Task (Every 30s, Core 0, Priority 2)
* Runs on Core 0 to avoid blocking high-priority math/sampling tasks.
* Measures battery level and system health.
* Dispatches a periodic `STATUS` packet (Type `0x02`) every 30 seconds to let the phone know the band is connected and powered.

### D. Integer Quantization & BLE Scaling
To fit the model on the microcontroller and reduce BLE bandwidth, the autoencoder runs in `int8` quantized mode. Before sending over BLE, values are kept in `int8`. The mobile app applies dequantization scales upon receiving the packets:
* **Reconstruction Error (MAE):** $\text{MAE}_{\text{float}} = (\text{Value}_{\text{int8}} - (-128)) \times 0.00441764$
* **Motion Embedding (16D):** $\text{Embedding}_{\text{float}} = (\text{Value}_{\text{int8}} - (-93)) \times 0.01699736$

---

## 3. Mobile App Architecture & State Engines (Detailed)

The React Native application connects to the band using `react-native-ble-plx`. Once connected, it subscribes to the BLE notification characteristics and routes the incoming telemetry stream through three stateful singletons and an evaluation module:

```
                    +-----------------------+
                    |  BLE Packet Stream    |
                    +-----------+-----------+
                                | (2 Hz FEATURE / SENSOR)
                                v
                    +-----------+-----------+
                    |     MotionEngine      |  <-- Accumulates sliding windows (5s)
                    +-----------+-----------+
                                | (3s stride Observations)
                                v
                    +-----------+-----------+
                    |     EpisodeEngine     |  <-- Groups behavior into Episodes
                    +-----------+-----------+
                                | (Dominant behavior segments)
                                v
     +--------------------------+--------------------------+
     |                                                     |
     v                                                     v
  +--+--------------------+                             +--+--------------------+
  |    LocationEngine     |                             |     ContextEngine     |
  | (GPS, Node Learning,  |                             | (Historical query,    |
  |  Geofencing, Visits)  |                             |  L1/L2/L3 familiarity) |
  +--+--------------------+                             +--+--------------------+
     |                                                     |
     +--------------------------+--------------------------+
                                | (Current coordinates + Familiarity Score)
                                v
                    +-----------+-----------+
                    |   Threat Score Gauge  |  <-- App.js recalculates
                    +-----------+-----------+
                                | (If score >= 72%)
                                v
                    +-----------+-----------+
                    |  useEmergency Hook    |  <-- 15s pre-alert -> Dispatch
                    +-----------------------+
```

### A. MotionEngine
* **Telemetry Buffer:** Maintains a sliding window buffer of the last 10 BLE packets (representing 5s of physical activity).
* **Stride Window:** Every 6 new packets (a stride of 3 seconds), it builds an `Observation` object. The 60% temporal overlap between observations ensures signal stability.
* **Centroid Clustering:** Loads trained centroids from the database. It calculates the Euclidean distance between each of the 10 embeddings in the sliding window and each centroid, assigning them to the closest match. It returns a probability distribution, e.g., `{"1": 0.70, "2": 0.30}`, indicating the user spent 70% of the window in cluster 1 and 30% in cluster 2.
* **Output:** Saves the compiled `Observation` into the SQLite database and returns it.

### B. EpisodeEngine
* **State Machine:** Groups 3-second observations into continuous "Episodes" of sustained behavior. If the user's dominant activity cluster changes, the engine closes the active episode (setting `end_date` and `end_time`) and initializes a new one.
* **Familiarity Metrics:** Uses Welford's online algorithm to maintain numerically stable running means, minimums, maximums, and variances of the location familiarity during the episode.
* **Persistence:** Recovers open episodes on app startup to handle sudden application closures.

### C. LocationEngine
* **GPS Filtering:** Rejects GPS fixes with accuracy $>50$ meters to avoid boundary jitter.
* **Hysteresis Geofencing:** Uses a dual-boundary to prevent oscillating visits:
  - **Entry Radius:** 20 meters. Must move within 20m of a node center to open a visit.
  - **Exit Radius:** 30 meters. Must move beyond 30m to close the visit.
* **Auto-Discovery (Place Learning):** If the user remains in an unknown location ($r < 50$ meters) for $\ge 5$ minutes, the engine registers a new **Location Node** in the database and retroactively back-dates a visit.
* **Location Familiarity:** Computes an exponential decay score based on distance to the closest learned node:
  $$\text{Familiarity} = e^{-\frac{\text{Distance}}{2 \times \text{Radius}}}$$
  Returns `1.0` if inside the geofence, and decays toward `0.0` as they move further away.

### D. ContextEngine
* **3-Level Behavioral Assessment:** Compares the user's current 15-minute behavioral window ($W_T$) against three levels of historical context:
  - **Level 1 (Session Context):** $W_T$ compared to the last 15–30 minutes to check for sudden behavioral changes.
  - **Level 2 (Circadian Today):** $W_T$ compared to earlier periods today.
  - **Level 3 (Circadian Historical):** $W_T$ compared to the same 15-minute slot on D-1, D-7, and D-15 to check if the behavior matches the user's typical daily routine.
* **Similarity Fusion:** Combines motion distribution similarity (Bhattacharyya coefficient), dominant cluster sequence matches, feature vector cosine similarity, and location familiarity.
* **Final Threat Modulation:** Modulates the raw edge anomaly score based on historical familiarity:
  $$\text{Threat Score} = \text{Base Threat} \times (1.3 - 0.6 \times \text{Familiarity})$$
  Familiar context (e.g., falling at home at a normal waking hour) dampens the alert, while unfamiliar context (e.g., falling at 3 AM in an unknown location) amplifies the threat rating.
* **Emergency Dispatch:** If the threat score reaches or exceeds **72%**, a 15-second visual and haptic pre-alert countdown is triggered.
  - **Real PIN:** Immediately cancels the alert and applies a 20-second cooldown.
  - **Fake Duress PIN:** Closes the modal immediately to fool an attacker, but silently dispatches emergency alerts in the background with a `[DURESS]` flag.
  - **Dispatch Channels:** Executes SMS/WhatsApp alerts via Twilio and emails via the Resend API.

---
## 4. SQLite Database Schema (Very Detailed)

The app stores all configurations, locations, behaviors, and diagnostic logs in a local SQLite file named `safeband.db`. Nested arrays and dictionaries are stored as serialized **JSON TEXT**.

Here is a detailed analysis of all 10 database tables, documenting the data they expect, their producers (data origin), consumers, and operational usage:

---

### 1. `settings`
Stores user profile attributes, medical metadata, security PINs, and API credentials.
* **Primary Key:** `key` (TEXT)
* **Columns:**
  - `key` (TEXT, PK): Unique configuration identifier.
  - `value` (TEXT): Stored configuration value parsed as a string.
* **Data Source / Origin:**
  - **User Input:** Entered in [SettingsTab.js](file:///c:/esp_firmware/mobile_app/src/components/SettingsTab.js) through forms (calling `saveSetting`).
  - **Initialization:** Seeded with standard defaults (such as `'Jane Smith'`, PINs, and Twilio/Resend toggle flags) inside `initDatabase()` in [Database.js](file:///c:/esp_firmware/mobile_app/src/Database.js) upon the app's first launch.
* **Data Consumer & Operational Usage:**
  - **[useEmergency.js](file:///c:/esp_firmware/mobile_app/src/hooks/useEmergency.js) (Emergency Dispatcher):** Retrieves API tokens like `twilio_account_sid`, `twilio_auth_token`, `twilio_sms_from`, `twilio_whatsapp_from`, and `resend_api_key` to build and authenticate headers/payloads for outgoing HTTP POST requests to Twilio and Resend. It also reads `medical_conditions` and `medical_instructions` to insert into alert templates.
  - **Security Overlay UI:** Queries `real_pin` and `fake_pin` to authenticate keypad inputs when canceling pre-alerts. Entering `fake_pin` triggers a silent duress flag.
  - **[ContextEngine.js](file:///c:/esp_firmware/mobile_app/src/ContextEngine.js) (Threat Assessment):** Reads alert toggle keys to confirm if channels are globally enabled and scales raw values accordingly.

---

### 2. `contacts`
Stores emergency contact records, each with per-channel alert configurations and custom notification templates.
* **Primary Key:** `id` (INTEGER AUTOINCREMENT)
* **Columns:**
  - `id` (INTEGER, PK): Unique auto-incremented identifier.
  - `name` (TEXT): Full name of the contact.
  - `phone` (TEXT): Number for SMS dispatches.
  - `email` (TEXT): Email address for alerts.
  - `whatsapp` (TEXT): Dedicated WhatsApp number.
  - `whatsapp_method` (TEXT): Method for WhatsApp dispatches (`'NATIVE'`, `'CALLMEBOT'`, or `'TWILIO'`).
  - `callmebot_key` (TEXT): Authorization key required if utilizing CallMeBot.
  - `sms_enabled` (INTEGER): Toggle flag (`1` for enabled, `0` for disabled).
  - `whatsapp_enabled` (INTEGER): Toggle flag (`1` for enabled, `0` for disabled).
  - `email_enabled` (INTEGER): Toggle flag (`1` for enabled, `0` for disabled).
  - `template_id` (INTEGER): Foreign key referencing `templates.id`. If `0`, defaults to the system alert text.
* **Data Source / Origin:**
  - **User Input:** Created, updated, and deleted by the user inside [ContactsTab.js](file:///c:/esp_firmware/mobile_app/src/components/ContactsTab.js) via the [ContactFormModal.js](file:///c:/esp_firmware/mobile_app/src/components/ContactFormModal.js).
* **Data Consumer & Operational Usage:**
  - **[useEmergency.js](file:///c:/esp_firmware/mobile_app/src/hooks/useEmergency.js) (Emergency Dispatcher):** Calls `getContacts()` when the 15-second countdown finishes (or when forced by the user). It loops over active contact objects to execute API dispatches conditionally. If a contact has `whatsapp_enabled = 1` and `whatsapp_method = 'TWILIO'`, it initiates a Twilio API call using the Twilio credentials fetched from the `settings` table.

---

### 3. `templates`
Stores customized notification layouts with placeholder bracket syntax.
* **Primary Key:** `id` (INTEGER AUTOINCREMENT)
* **Columns:**
  - `id` (INTEGER, PK): Unique auto-incremented identifier.
  - `name` (TEXT): Short name or label (e.g. `"Work Hours Template"`).
  - `content` (TEXT): Template body containing replaceable placeholders.
* **Data Source / Origin:**
  - **User Input:** Created, edited, and deleted inside [TemplatesTab.js](file:///c:/esp_firmware/mobile_app/src/components/TemplatesTab.js) via the [TemplateFormModal.js](file:///c:/esp_firmware/mobile_app/src/components/TemplateFormModal.js).
* **Data Consumer & Operational Usage:**
  - **[useEmergency.js](file:///c:/esp_firmware/mobile_app/src/hooks/useEmergency.js) (Emergency Dispatcher):** Queries template content matching the contact's `template_id` (falling back to a default system layout if `template_id = 0`). It substitutes placeholders (`{name}`, `{maps_link}`, `{blood_group}`, etc.) with values geocoded from current coordinates and profiles loaded from the `settings` table to formulate the final alert message.

---

### 4. `observations`
Stores 3-second stride summaries containing dequantized edge sensor features and neural embeddings.
* **Primary Key:** `observation_id` (INTEGER AUTOINCREMENT)
* **Columns:**
  - `observation_id` (INTEGER, PK): Unique auto-incremented identifier.
  - `date` (TEXT): Date string in `"YYYY-MM-DD"`.
  - `time` (TEXT): Wall-clock time in `"HH:MM:SS"`.
  - `embeddings` (TEXT): **JSON TEXT**. Serialized 10 × 16D dequantized float embeddings.
  - `reconstruction_scores` (TEXT): **JSON TEXT**. Serialized 10 × dequantized reconstruction MAE float values.
  - `motion_features` (TEXT): **JSON TEXT**. Serialized 10 × feature structures.
  - `cluster_distribution` (TEXT): **JSON TEXT**. Serialized map of active clusters and relative percentages.
  - `cluster_version` (INTEGER): Active model version.
* **Data Source / Origin:**
  - **Background Processing:** Compiled and inserted dynamically by [MotionEngine.js](file:///c:/esp_firmware/mobile_app/src/MotionEngine.js) (calling `storeObservation`). Every 6 incoming BLE packets (a 3-second stride), the engine processes its 10-packet circular buffer to construct the observation record.
* **Data Consumer & Operational Usage:**
  - **[ContextEngine.js](file:///c:/esp_firmware/mobile_app/src/ContextEngine.js) (Behavioral Analytics):** The core consumer. It calls `fetchWindowObservations` to load observations for the current 5-minute window and loops over historical tables for D-1, D-7, and D-15 at the same time-of-day. It runs similarity calculations (Bhattacharyya discrete distributions, cosine feature similarity, sequence matching) to estimate temporal familiarity.
  - **[DashboardTab.js](file:///c:/esp_firmware/mobile_app/src/components/DashboardTab.js) (UI):** Queries recent observations to feed the PCA visualization chart showing the active movement distribution.

#### JSON Serialization Schemas:
* **`embeddings`**:
  ```json
  [
    [0.12, -0.45, 0.02, 0.88, -0.11, 0.33, -0.05, 0.12, 0.44, -0.91, 0.12, 0.08, -0.01, 0.02, -0.19, 0.22],
    [0.10, -0.42, 0.01, 0.85, -0.10, 0.30, -0.04, 0.10, 0.41, -0.89, 0.11, 0.07, -0.02, 0.01, -0.17, 0.20],
    ... // 10 float arrays (one per 2 Hz packet in the 5s window)
  ]
  ```
* **`reconstruction_scores`**:
  ```json
  [0.154, 0.162, 0.149, 0.155, 0.160, 0.171, 0.158, 0.144, 0.150, 0.161]
  ```
* **`motion_features`**:
  ```json
  [
    {
      "sequenceId": 124,
      "motionState": 130, // 0x82: Worn + Periodic
      "dominantFreq": 1.5,
      "zcr": 32,
      "spectralEntropy": 122,
      "eigenvalueRatio": 210,
      "wearConfidence": 100,
      "peakAccel": 980,
      "anomalyDuration": 0,
      "twelveFeatures": [0.15, 9.8, 0, 0, 0.05, 1.5, 0.45, 0, 0, 0.8, 2.5, 0.02]
    },
    ... // 10 objects representing each packet's physical signal features
  ]
  ```
* **`cluster_distribution`**:
  ```json
  {"1": 0.8, "2": 0.2}
  ```

---

### 5. `motion_clusters`
Stores centroid vectors and metadata defining behavior categories (e.g. Sitting, Walking).
* **Composite Primary Key:** (`cluster_id`, `cluster_version`)
* **Columns:**
  - `cluster_id` (INTEGER): Unique ID mapping to a specific activity cluster.
  - `cluster_version` (INTEGER): Active ML clustering model layout version.
  - `centroid` (TEXT): **JSON TEXT**. Serialized 16D float coordinate vector.
  - `covariance` (TEXT): **JSON TEXT**. Serialized mathematical covariances.
  - `visit_count` (INTEGER): Sum of historical packet mappings matching this cluster.
  - `reconstruction_mean` (REAL): Average reconstruction MAE score.
  - `motion_summary` (TEXT): **JSON TEXT**. Descriptive labels (e.g., `{"label": "Walking"}`).
  - `created_date`, `created_time`, `updated_date`, `updated_time` (TEXT): Timestamps.
* **Data Source / Origin:**
  - **Machine Learning Pipeline:** Seeded offline via calibrations or uploaded directly by the Python/ML model deployment scripts (calling `saveMotionCluster`).
* **Data Consumer & Operational Usage:**
  - **[MotionEngine.js](file:///c:/esp_firmware/mobile_app/src/MotionEngine.js) (Clustering Engine):** Queries active max-version clusters on initialize. It computes the Euclidean distance between raw 16D BLE embeddings and these centroids in 16D space to determine the user's active cluster category.

---

### 6. `episodes`
Stores macro behavioral blocks representing contiguous periods of a single dominant activity.
* **Primary Key:** `episode_id` (INTEGER AUTOINCREMENT)
* **Columns:**
  - `episode_id` (INTEGER, PK): Unique auto-incremented identifier.
  - `start_date` (TEXT): `"YYYY-MM-DD"`.
  - `start_time` (TEXT): `"HH:MM:SS"`.
  - `end_date` (TEXT): End date (NULL if the episode is currently active).
  - `end_time` (TEXT): End time (NULL if the episode is currently active).
  - `duration` (REAL): Cumulative episode duration in seconds.
  - `motion_distribution` (TEXT): **JSON TEXT**. Serialized overall cluster distribution split.
  - `familiarity_mean` (REAL): Running mean of location familiarity during this segment.
  - `familiarity_min` (REAL): Minimum location familiarity recorded during this segment.
  - `familiarity_max` (REAL): Maximum location familiarity recorded during this segment.
  - `familiarity_variance` (REAL): Running location familiarity variance.
* **Data Source / Origin:**
  - **Segmenter Engine:** Maintained, updated, and closed by [EpisodeEngine.js](file:///c:/esp_firmware/mobile_app/src/EpisodeEngine.js) (calling `saveEpisode`). Every 3 seconds, if the user remains in the same dominant cluster, the record is updated in SQLite. If a transition is detected, the old record is finalized, and a new row is inserted.
* **Data Consumer & Operational Usage:**
  - **[ContextEngine.js](file:///c:/esp_firmware/mobile_app/src/ContextEngine.js) (Threat Evaluator):** Reads the active episode ID to link with diagnostic evaluations.
  - **[DashboardTab.js](file:///c:/esp_firmware/mobile_app/src/components/DashboardTab.js) (UI):** Queries the latest episodes to display the wearer's chronological history timeline (e.g. `"Sitting for 45 minutes"`, `"Walking for 10 minutes"`).

---

### 7. `episode_motion_timelines`
Stores stride history snapshots tied to their parent episode.
* **Primary Key:** `timeline_id` (INTEGER AUTOINCREMENT)
* **Columns:**
  - `timeline_id` (INTEGER, PK): Unique auto-incremented identifier.
  - `episode_id` (INTEGER, FK): Reference to `episodes.episode_id` (ON DELETE CASCADE).
  - `window_start_date` (TEXT): `"YYYY-MM-DD"`.
  - `window_start_time` (TEXT): `"HH:MM:SS"`.
  - `motion_distribution` (TEXT): **JSON TEXT**. Serialized probability dictionary.
  - `reconstruction_mean` (REAL): The average reconstruction MAE of the stride.
* **Data Source / Origin:**
  - **Segmenter Engine:** Saved by [EpisodeEngine.js](file:///c:/esp_firmware/mobile_app/src/EpisodeEngine.js) (calling `saveEpisodeTimeline`) on every 3-second stride while an episode is active.
* **Data Consumer & Operational Usage:**
  - **[EpisodeEngine.js](file:///c:/esp_firmware/mobile_app/src/EpisodeEngine.js) (State Recovery):** Counts timeline entries on app initialization to restore Welford's algorithm parameters for running episodes.
  - **Analytics Exports:** Used by developers to perform high-resolution behavioral auditing.

---

### 8. `location_nodes`
Stores geofenced zones representing regular places visited by the wearer (e.g., Home, Office).
* **Primary Key:** `location_node_id` (INTEGER AUTOINCREMENT)
* **Columns:**
  - `location_node_id` (INTEGER, PK): Unique auto-incremented identifier.
  - `center_latitude` (REAL): Center GPS latitude.
  - `center_longitude` (REAL): Center GPS longitude.
  - `radius` (REAL): Zone boundary radius in meters (typically `30.0`).
  - `visit_count` (INTEGER): Total visit count.
  - `total_stay_duration` (REAL): Cumulative stay time in seconds.
  - `first_visit_date`, `first_visit_time` (TEXT)
  - `last_visit_date`, `last_visit_time` (TEXT)
* **Data Source / Origin:**
  - **Discovery Engine:** Automatically learned by [LocationEngine.js](file:///c:/esp_firmware/mobile_app/src/LocationEngine.js) (calling `saveLocationNode`). If the wearer lingers in an unknown location ($r < 50$ meters) for $\ge 5$ minutes, a new node is written.
* **Data Consumer & Operational Usage:**
  - **[LocationEngine.js](file:///c:/esp_firmware/mobile_app/src/LocationEngine.js) (Geofencer):** Caches all nodes as `this.knownNodes` to verify GPS fixes, estimate local familiarity, and manage entry/exit hysteresis.
  - **[ContextEngine.js](file:///c:/esp_firmware/mobile_app/src/ContextEngine.js) (Threat Evaluator):** Associates the active location node ID with threat assessments.

---

### 9. `location_visits`
Logs entry and exit metadata for visits to learned location nodes.
* **Primary Key:** `visit_id` (INTEGER AUTOINCREMENT)
* **Columns:**
  - `visit_id` (INTEGER, PK): Unique auto-incremented identifier.
  - `location_node_id` (INTEGER, FK): Reference to `location_nodes.location_node_id` (ON DELETE CASCADE).
  - `enter_date` (TEXT): Arrival date `"YYYY-MM-DD"`.
  - `enter_time` (TEXT): Arrival time `"HH:MM:SS"`.
  - `exit_date` (TEXT): Departure date (NULL if visit is active/ongoing).
  - `exit_time` (TEXT): Departure time (NULL if visit is active/ongoing).
  - `duration` (REAL): Active stay duration in seconds.
  - `entry_latitude`, `entry_longitude` (REAL): Coordinates at arrival.
  - `exit_latitude`, `exit_longitude` (REAL): Coordinates at departure.
  - `confidence` (TEXT): High/Low based on GPS accuracy.
* **Data Source / Origin:**
  - **Discovery Engine:** Opened, updated (duration), and closed by [LocationEngine.js](file:///c:/esp_firmware/mobile_app/src/LocationEngine.js) (calling `saveLocationVisit`). Entry occurs when coordinates fall within `ENTRY_RADIUS` (20m), and exit occurs when moving past `EXIT_RADIUS` (30m).
* **Data Consumer & Operational Usage:**
  - **[LocationEngine.js](file:///c:/esp_firmware/mobile_app/src/LocationEngine.js) (State Recovery):** Restores active visits (where `exit_date IS NULL`) on app start.
  - **[ContextEngine.js](file:///c:/esp_firmware/mobile_app/src/ContextEngine.js) (Threat Evaluator):** Reads the active visit to determine which location node ID is active during the current inference.

---

### 10. `inference_logs`
Stores diagnostic logs of context engine threat decisions.
* **Primary Key:** `inference_id` (INTEGER AUTOINCREMENT)
* **Columns:**
  - `inference_id` (INTEGER, PK): Unique auto-incremented identifier.
  - `date` (TEXT): `"YYYY-MM-DD"`.
  - `time` (TEXT): `"HH:MM:SS"`.
  - `familiarity_score` (REAL): Computed familiarity ($0.0 \dots 1.0$).
  - `anomaly_score` (REAL): Edge sensor MAE score.
  - `emergency_score` (REAL): Blended Threat Score ($0.0 \dots 1.0$).
  - `selected_episode` (INTEGER, Nullable): Foreign key to the active episode.
  - `selected_location` (INTEGER, Nullable): Foreign key to the active location node.
  - `explanation` (TEXT): **JSON TEXT**. Serialized array of diagnostic string logs.
* **Data Source / Origin:**
  - **Threat Assessment:** Written by the threat evaluator in `App.js` or [ContextEngine.js](file:///c:/esp_firmware/mobile_app/src/ContextEngine.js) (calling `storeInference`) on every 2 Hz threat evaluation cycle.
* **Data Consumer & Operational Usage:**
  - **[DatabaseTab.js](file:///c:/esp_firmware/mobile_app/src/components/DatabaseTab.js) (UI Debugging):** Queries and formats the explanation text logs in the database viewer tab to help developers verify and trace the ContextEngine's decision logic during testing.

#### JSON Serialization Schema for `explanation`:
```json
[
  "Assessment started at 2026-07-17 09:35:00",
  "Retrieved 10 current observations in the 5m window.",
  "On-demand Location Familiarity computed: 1.000",
  "Window 3s: S_hist=0.020 (BC=1.00, Seq=1.00, Feat=0.98)",
  "Window 3m: S_hist=0.030 (BC=1.00, Seq=0.98, Feat=0.97)",
  "Window 5m: S_hist=0.025 (BC=1.00, Seq=0.99, Feat=0.98)",
  "ContextEngine Tick: Fused S_final = 0.050",
  "Final Fused Threat Score S_final: 0.050"
]
```

---

## 5. How to Populate the Database for a Demonstration

To present a realistic, high-fidelity demonstration, you need mock data that aligns with your environment. If the database is empty, the `ContextEngine` defaults to `0.0` familiarity, resulting in elevated false alarms. Populating the database correctly allows you to demonstrate both **"Familiar Context Suppression"** (suppressing false alarms) and **"Anomalous Incident Escalation"** (triggering alerts when behavior deviates).

### Step 1: Align Dates and Times Chronologically
The `ContextEngine` compares the user's current time and date against three benchmarks:
* **D-1** (Yesterday)
* **D-7** (Exactly 1 week ago)
* **D-15** (Exactly 15 days ago)

> [!IMPORTANT]  
> If you are presenting a live demo on **July 17, 2026, at 10:00 AM**, your historical database must contain observations for the **09:45 AM – 10:15 AM window** on:
> * **July 16, 2026** (D-1)
> * **July 10, 2026** (D-7)
> * **July 02, 2026** (D-15)

### Step 2: Set Coordinates for your Location
The `LocationEngine` calculates familiarity based on the great-circle distance between the active GPS coordinate and known centers in `location_nodes`.
* Look up the coordinates of your demonstration venue (e.g., Latitude `37.7749`, Longitude `-122.4194`).
* Insert this location node in `location_nodes` and create visit records in `location_visits`.
* If you set your current location as a known node with a high visit count, the engine will compute high familiarity ($1.0$), demonstrating how SafeBand remains calm in familiar environments.

### Step 3: Configure Motion Clusters
Seed at least two motion clusters so the centroid matcher can group embeddings:
* **Cluster 1:** Representing low-intensity stationary behavior (e.g. Sitting / Reading).
* **Cluster 2:** Representing regular active behavior (e.g. Walking / Strolling).

---

## 6. SQL Demonstration Seeding Script

Run the following SQL commands in your SQLite browser (or load them in React Native via custom debug functions) to establish a baseline of historical data.

> [!TIP]
> Before running this script, adjust the date strings (`'2026-07-16'`, `'2026-07-10'`, `'2026-07-02'`) and times to match the dates relative to your live demonstration.

```sql
-- =============================================================================
-- SECTION 1: Settings, Contacts, and Custom Templates Setup
-- =============================================================================

-- Clear existing setup data to avoid conflicts
DELETE FROM settings;
DELETE FROM contacts;
DELETE FROM templates;

-- Insert configurations
INSERT INTO settings (key, value) VALUES
  ('user_name', 'Jane Smith'),
  ('medical_blood_group', 'O+'),
  ('medical_conditions', 'Mild Asthma'),
  ('medical_allergies', 'Penicillin'),
  ('medical_instructions', 'Inhaler in front pocket of backpack'),
  ('real_pin', '1234'),
  ('fake_pin', '9999'),
  ('pin_enabled', '1'),
  ('silent_beacon', '0'),
  ('email_alerts_enabled', '1'),
  ('whatsapp_alerts_enabled', '1'),
  ('sms_alerts_enabled', '1');

-- Add two custom emergency templates
INSERT INTO templates (id, name, content) VALUES
  (1, 'Urgent Fall Alert', 'Emergency! SafeBand detected a critical fall for {name} ({blood_group}). Conditions: {medical_conditions}. Action: {medical_instructions}. Location: {maps_link}'),
  (2, 'Silent Duress Alert', 'Silent Alert. {name} has entered duress cancel pin. Immediate follow-up required. Location: {maps_link}');

-- Add emergency contacts
-- Contact 1 uses SMS (configured template 1)
-- Contact 2 uses Twilio WhatsApp (configured template 1)
INSERT INTO contacts (id, name, phone, email, whatsapp, whatsapp_method, sms_enabled, whatsapp_enabled, email_enabled, template_id) VALUES
  (1, 'John Smith (Primary)', '+15550192831', 'john.smith@example.com', '+15550192831', 'NATIVE', 1, 1, 1, 1),
  (2, 'Sarah Jenkins (Medical Support)', '+15550129844', 's.jenkins@hospital.org', '+15550129844', 'TWILIO', 1, 1, 0, 1);


-- =============================================================================
-- SECTION 2: Spatial Data (Location Nodes & Visit Logs)
-- =============================================================================

DELETE FROM location_nodes;
DELETE FROM location_visits;

-- Seed 3 known locations: Home, Office, and the Demo Venue.
-- NOTE: Modify coordinates to match your demo venue.
INSERT INTO location_nodes (location_node_id, center_latitude, center_longitude, radius, visit_count, total_stay_duration, first_visit_date, first_visit_time, last_visit_date, last_visit_time) VALUES
  (1, 37.7749, -122.4194, 30.0, 120, 432000.0, '2026-07-01', '08:00:00', '2026-07-16', '22:00:00'), -- Home (High Visits)
  (2, 37.7891, -122.4014, 30.0, 45, 162000.0, '2026-07-02', '09:00:00', '2026-07-16', '18:00:00'),  -- Office
  (3, 37.7650, -122.4400, 30.0, 5, 18000.0, '2026-07-10', '10:00:00', '2026-07-17', '09:30:00');    -- Demo Venue (Current Place)

-- Seed visits to these locations
-- Seeding an ongoing active visit to the Demo Venue (exit_date/exit_time is NULL)
INSERT INTO location_visits (visit_id, location_node_id, enter_date, enter_time, exit_date, exit_time, duration, entry_latitude, entry_longitude, confidence) VALUES
  (101, 1, '2026-07-15', '19:00:00', '2026-07-16', '08:30:00', 48600.0, 37.77485, -122.41935, 'HIGH'),
  (102, 2, '2026-07-16', '09:00:00', '2026-07-16', '17:30:00', 30600.0, 37.78905, -122.40135, 'HIGH'),
  (103, 1, '2026-07-16', '18:15:00', '2026-07-17', '08:45:00', 52200.0, 37.77492, -122.41941, 'HIGH'),
  (104, 3, '2026-07-17', '09:30:00', NULL, NULL, 1800.0, 37.76498, -122.43995, 'HIGH'); -- Active Visit (User is currently here)


-- =============================================================================
-- SECTION 3: Motion Engine Clusters (Machine Learning Centroids)
-- =============================================================================

DELETE FROM motion_clusters;

-- Seed three activity clusters. Centroids are 16-dimensional float embeddings.
-- Cluster 1 represents Stationary/Sitting (centroid close to 0.1)
-- Cluster 2 represents walking (centroid close to -0.5)
-- Cluster 3 represents running/high-intensity (centroid close to 0.8)
INSERT INTO motion_clusters (cluster_id, cluster_version, centroid, covariance, visit_count, reconstruction_mean, motion_summary, created_date, created_time) VALUES
  (1, 0, '[0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]', '[]', 500, 0.14, '{"label":"Sitting / Stationary","intensity":"LOW"}', '2026-07-01', '08:00:00'),
  (2, 0, '[-0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5]', '[]', 250, 0.22, '{"label":"Walking","intensity":"MEDIUM"}', '2026-07-01', '08:00:00'),
  (3, 0, '[0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8]', '[]', 100, 0.35, '{"label":"High Active / Running","intensity":"HIGH"}', '2026-07-01', '08:00:00');


-- =============================================================================
-- SECTION 4: Behavior Episodes and Timelines
-- =============================================================================

DELETE FROM episodes;
DELETE FROM episode_motion_timelines;

-- Seed two completed episodes and one active/ongoing episode
INSERT INTO episodes (episode_id, start_date, start_time, end_date, end_time, duration, motion_distribution, familiarity_mean, familiarity_min, familiarity_max, familiarity_variance) VALUES
  (1, '2026-07-17', '08:00:00', '2026-07-17', '08:45:00', 2700.0, '{"1":0.95,"2":0.05}', 1.0, 1.0, 1.0, 0.0), -- Sitting at Home
  (2, '2026-07-17', '08:45:00', '2026-07-17', '09:00:00', 900.0, '{"2":0.90,"1":0.10}', 0.75, 0.35, 1.0, 0.05), -- Walking transit
  (3, '2026-07-17', '09:30:00', NULL, NULL, 1800.0, '{"1":1.0}', 1.0, 1.0, 1.0, 0.0); -- Ongoing Sitting at Demo Venue

-- Seed timelines for active Episode #3 (every 3 seconds)
INSERT INTO episode_motion_timelines (timeline_id, episode_id, window_start_date, window_start_time, motion_distribution, reconstruction_mean) VALUES
  (1001, 3, '2026-07-17', '09:30:00', '{"1":1.0}', 0.12),
  (1002, 3, '2026-07-17', '09:30:03', '{"1":1.0}', 0.13),
  (1003, 3, '2026-07-17', '09:30:06', '{"1":1.0}', 0.11),
  (1004, 3, '2026-07-17', '09:30:09', '{"1":1.0}', 0.12);


-- =============================================================================
-- SECTION 5: Context Engine Circadian Baselines (D-1, D-7, D-15)
-- =============================================================================

DELETE FROM observations;

-- We want to prove that the current time slot (e.g., 09:45 AM - 10:15 AM)
-- is FAMILIAR for Cluster 1 (Sitting).
-- We write observations representing 100% Cluster 1 at these exact times
-- on D-1 (July 16), D-7 (July 10), and D-15 (July 02).

-- Helper Loop Structure represented in flat SQL:
-- Baseline for D-1 (Yesterday - July 16, 2026) around 10:00 AM
INSERT INTO observations (date, time, embeddings, reconstruction_scores, motion_features, cluster_distribution, cluster_version) VALUES
  ('2026-07-16', '09:50:00', '[[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]]', '[0.14]', '[{"sequenceId":1,"motionState":130,"dominantFreq":1.2,"zcr":28,"spectralEntropy":115,"eigenvalueRatio":110,"wearConfidence":100,"peakAccel":970,"anomalyDuration":0,"twelveFeatures":[0.14,9.7,0,0,0.04,1.2,0.42,0,0,0.6,2.2,0.01]}]', '{"1":1.0}', 0),
  ('2026-07-16', '09:55:00', '[[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]]', '[0.12]', '[{"sequenceId":2,"motionState":130,"dominantFreq":1.1,"zcr":26,"spectralEntropy":112,"eigenvalueRatio":105,"wearConfidence":100,"peakAccel":975,"anomalyDuration":0,"twelveFeatures":[0.13,9.8,0,0,0.04,1.1,0.40,0,0,0.5,2.1,0.01]}]', '{"1":1.0}', 0),
  ('2026-07-16', '10:00:00', '[[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]]', '[0.13]', '[{"sequenceId":3,"motionState":130,"dominantFreq":1.2,"zcr":27,"spectralEntropy":114,"eigenvalueRatio":108,"wearConfidence":100,"peakAccel":972,"anomalyDuration":0,"twelveFeatures":[0.14,9.7,0,0,0.04,1.2,0.41,0,0,0.6,2.2,0.01]}]', '{"1":1.0}', 0),
  ('2026-07-16', '10:05:00', '[[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]]', '[0.15]', '[{"sequenceId":4,"motionState":130,"dominantFreq":1.3,"zcr":29,"spectralEntropy":118,"eigenvalueRatio":112,"wearConfidence":100,"peakAccel":968,"anomalyDuration":0,"twelveFeatures":[0.15,9.6,0,0,0.05,1.3,0.43,0,0,0.7,2.3,0.02]}]', '{"1":1.0}', 0);

-- Baseline for D-7 (Last Week - July 10, 2026) around 10:00 AM
INSERT INTO observations (date, time, embeddings, reconstruction_scores, motion_features, cluster_distribution, cluster_version) VALUES
  ('2026-07-10', '09:50:00', '[[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]]', '[0.13]', '[{"sequenceId":1,"motionState":130,"dominantFreq":1.2,"zcr":28,"spectralEntropy":115,"eigenvalueRatio":110,"wearConfidence":100,"peakAccel":970,"anomalyDuration":0,"twelveFeatures":[0.14,9.7,0,0,0.04,1.2,0.42,0,0,0.6,2.2,0.01]}]', '{"1":1.0}', 0),
  ('2026-07-10', '09:55:00', '[[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]]', '[0.11]', '[{"sequenceId":2,"motionState":130,"dominantFreq":1.1,"zcr":26,"spectralEntropy":112,"eigenvalueRatio":105,"wearConfidence":100,"peakAccel":975,"anomalyDuration":0,"twelveFeatures":[0.13,9.8,0,0,0.04,1.1,0.40,0,0,0.5,2.1,0.01]}]', '{"1":1.0}', 0),
  ('2026-07-10', '10:00:00', '[[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]]', '[0.14]', '[{"sequenceId":3,"motionState":130,"dominantFreq":1.2,"zcr":27,"spectralEntropy":114,"eigenvalueRatio":108,"wearConfidence":100,"peakAccel":972,"anomalyDuration":0,"twelveFeatures":[0.14,9.7,0,0,0.04,1.2,0.41,0,0,0.6,2.2,0.01]}]', '{"1":1.0}', 0),
  ('2026-07-10', '10:05:00', '[[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]]', '[0.12]', '[{"sequenceId":4,"motionState":130,"dominantFreq":1.3,"zcr":29,"spectralEntropy":118,"eigenvalueRatio":112,"wearConfidence":100,"peakAccel":968,"anomalyDuration":0,"twelveFeatures":[0.15,9.6,0,0,0.05,1.3,0.43,0,0,0.7,2.3,0.02]}]', '{"1":1.0}', 0);

-- Baseline for D-15 (Two Weeks Ago - July 02, 2026) around 10:00 AM
INSERT INTO observations (date, time, embeddings, reconstruction_scores, motion_features, cluster_distribution, cluster_version) VALUES
  ('2026-07-02', '09:50:00', '[[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]]', '[0.15]', '[{"sequenceId":1,"motionState":130,"dominantFreq":1.2,"zcr":28,"spectralEntropy":115,"eigenvalueRatio":110,"wearConfidence":100,"peakAccel":970,"anomalyDuration":0,"twelveFeatures":[0.14,9.7,0,0,0.04,1.2,0.42,0,0,0.6,2.2,0.01]}]', '{"1":1.0}', 0),
  ('2026-07-02', '09:55:00', '[[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]]', '[0.13]', '[{"sequenceId":2,"motionState":130,"dominantFreq":1.1,"zcr":26,"spectralEntropy":112,"eigenvalueRatio":105,"wearConfidence":100,"peakAccel":975,"anomalyDuration":0,"twelveFeatures":[0.13,9.8,0,0,0.04,1.1,0.40,0,0,0.5,2.1,0.01]}]', '{"1":1.0}', 0),
  ('2026-07-02', '10:00:00', '[[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]]', '[0.12]', '[{"sequenceId":3,"motionState":130,"dominantFreq":1.2,"zcr":27,"spectralEntropy":114,"eigenvalueRatio":108,"wearConfidence":100,"peakAccel":972,"anomalyDuration":0,"twelveFeatures":[0.14,9.7,0,0,0.04,1.2,0.41,0,0,0.6,2.2,0.01]}]', '{"1":1.0}', 0),
  ('2026-07-02', '10:05:00', '[[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]]', '[0.14]', '[{"sequenceId":4,"motionState":130,"dominantFreq":1.3,"zcr":29,"spectralEntropy":118,"eigenvalueRatio":112,"wearConfidence":100,"peakAccel":968,"anomalyDuration":0,"twelveFeatures":[0.15,9.6,0,0,0.05,1.3,0.43,0,0,0.7,2.3,0.02]}]', '{"1":1.0}', 0);


-- =============================================================================
-- SECTION 6: Inference Logs (Diagnostic History Logs)
-- =============================================================================

DELETE FROM inference_logs;

-- Seed three historical decision evaluations in the app viewer.
INSERT INTO inference_logs (inference_id, date, time, familiarity_score, anomaly_score, emergency_score, selected_episode, selected_location, explanation) VALUES
  (1, '2026-07-17', '09:35:00', 0.98, 0.12, 0.05, 3, 3, '["Assessment started at 2026-07-17 09:35:00","Retrieved 10 current observations in the 5m window.","On-demand Location Familiarity computed: 1.000","Window 3s: S_hist=0.020 (BC=1.00, Seq=1.00, Feat=0.98)","Window 3m: S_hist=0.030 (BC=1.00, Seq=0.98, Feat=0.97)","Window 5m: S_hist=0.025 (BC=1.00, Seq=0.99, Feat=0.98)","ContextEngine Tick: Fused S_final = 0.050","Final Fused Threat Score S_final: 0.050"]'),
  (2, '2026-07-17', '09:40:00', 0.99, 0.14, 0.04, 3, 3, '["Assessment started at 2026-07-17 09:40:00","Retrieved 12 current observations in the 5m window.","On-demand Location Familiarity computed: 1.000","Window 3s: S_hist=0.010 (BC=1.00, Seq=1.00, Feat=0.99)","ContextEngine Tick: Fused S_final = 0.040"]'),
  -- Seed an historical anomaly that occurred at an UNKNOWN place (Location Node 0) where the user was walking (Cluster 2) but deviated
  (3, '2026-07-17', '09:12:00', 0.18, 1.25, 0.86, 2, NULL, '["Assessment started at 2026-07-17 09:12:00","Retrieved 10 current observations in the 5m window.","On-demand Location Familiarity computed: 0.000 (Unknown Territory)","Window 3s: S_hist=0.820 (BC=0.10, Seq=0.05, Feat=0.12)","ContextEngine Tick: Fused S_final = 0.860","Final Fused Threat Score S_final: 0.860 (CRITICAL - countdown triggered)"]');
```

---

## 7. How to Apply this Data inside the Application

You can write this data directly into the database on your target mobile device using one of the following approaches:

### Option A: Via DB Browser GUI (Simulator / Rooted Device)
If running on an Android/iOS simulator:
1. Locate the `safeband.db` file.
   - **Expo Sandbox Path:** Typically located in:
     `Documents/ExponentExperienceData/%40anonymous%2Fmobile_app-xxxxx/SQLite/safeband.db`
2. Open the file in [DB Browser for SQLite](https://sqlitebrowser.org/).
3. Navigate to **Execute SQL**, copy-paste the script from Section 6, and click **Run**.
4. Write changes to the database and restart the application.

### Option B: Via App Debug Panel (Dynamic Injection)
If you want to inject data directly using React Native, you can temporarily add a button in your `DatabaseTab.js` file:

```javascript
import { executeRun } from '../Database';

const injectDemoData = () => {
  try {
    // Paste the SQL statements here as a single template string
    executeRun(`
      INSERT OR REPLACE INTO settings (key, value) VALUES ('user_name', 'Jane Smith');
      -- Add other SQL statements here ...
    `);
    Alert.alert("Success", "Demo data seeded successfully!");
  } catch (err) {
    Alert.alert("Seeding Failed", err.message);
  }
};
```

---

## 8. Reasoning Guidelines for Demonstrators

Once the database is seeded, you can demonstrate the intelligence of the ContextEngine:

| Scenario | Raw Anomaly MAE | Location Context | Circadian Context | Final Threat Score | System Action |
|---|---|---|---|---|---|
| **1. Standing Still (Normal)** | `0.15` (Low) | Familiar Venue (`1.0`) | Familiar Slot (`1.0`) | **`~5%`** (Normal) | Logged silently. |
| **2. Physical Activity (Normal)** | `0.30` (Medium) | Familiar Venue (`1.0`) | Familiar Slot (`1.0`) | **`~12%`** (Normal) | Logged silently. |
| **3. Accidental Slam / Jolt** | `1.15` (High Anomaly) | Familiar Venue (`1.0`) | Familiar Slot (`1.0`) | **`~45%`** (Low Alert) | Haptic pulse on phone. No dispatch countdown. |
| **4. Fall at Venue (Live Demo)** | `1.20` (High Anomaly) | Unfamiliar Place (`0.0`) | Unfamiliar Slot (`0.0`) | **`~86%`** (Critical) | **Alarm Triggers:** 15s flashing countdown. Dispatches notifications upon timeout. |

By modifying the current GPS coordinates of the mobile device (using Mock Location tools or simulator location settings), you can showcase how SafeBand dynamically modulates its threat response between **Home** (suppressed) and **Unfamiliar Alley** (escalated).
