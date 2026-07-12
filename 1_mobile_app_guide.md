# SafeBand Mobile App — Technical Guide
## Architecture, Data Pipeline, & Core Engines

---

## 1. System Overview
The SafeBand mobile application is built using **React Native (Expo)**. It acts as the "smart coordinator" of the SafeBand ecosystem. While the ESP32 wristband performs real-time sensor processing and anomaly detection on the edge, the mobile app aggregates this data, correlates it with the user’s location and time, evaluates behavioral familiarity, and manages emergency alert dispatches.

---

## 2. Core Engines & State Machines

The app organizes its analytics and business logic into three discrete, stateful singletons and one evaluation engine:

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
The **MotionEngine** bridges raw telemetry packets and semantic behavioral observations.
* **Buffer Mechanism:** It maintains a circular sliding buffer of the last 10 BLE `FEATURE` packets (representing 5 seconds of physical activity at a 2 Hz inference rate).
* **Stride Window:** Every time 6 new packets arrive (a stride of 3 seconds), it builds an `Observation` object. This creates a 60% temporal overlap between consecutive observations, ensuring signal continuity.
* **Centroid Clustering:** It calculates the L2 (Euclidean) distance between the 10 motion embeddings in the window and the cluster centroids cached in memory from the database. It produces a normalized probability distribution (e.g., `{"1": 0.7, "2": 0.3}`) representing the wearer's activity split.
* **Output:** An `Observation` record written to SQLite and returned to `useBle.js`.

### B. EpisodeEngine
The **EpisodeEngine** aggregates short 3-second observations into macro-level "Episodes" of sustained behavior.
* **State Machine:**
  - **No Active Episode:** Creates a new episode with the current dominant motion state.
  - **Dominant State Unchanged:** Extends the duration of the current episode (adds 3.0 seconds per stride) and updates the rolling average motion distribution.
  - **Dominant State Changed:** Closes the current episode by setting its `end_date` and `end_time`, and opens a new episode.
* **Welford's Algorithm:** Rather than storing all individual familiarity scores, it uses Welford's online algorithm to calculate a numerically stable running mean, min, max, and variance of the user's familiarity during the episode.

### C. LocationEngine
The **LocationEngine** manages spatial awareness, geofencing, and place discovery.
* **Accuracy Filter:** Discards any GPS reading with an accuracy greater than 50 meters to prevent jitter from corrupting geofence state.
* **Entry/Exit Hysteresis:** To prevent "flapping" at boundaries, it uses asymmetric radii:
  - **Entry Radius (20m):** Must walk within 20m of a node center to open a visit.
  - **Exit Radius (30m):** Must move past 30m away from the center to close the visit.
* **Candidate Place Tracking:** If the user stays in an unknown location (outside all known nodes) within a 50m radius for $\ge$ `MIN_STAY_DURATION` (default 5 minutes), the engine automatically registers a new **Location Node** in the database and retroactively back-dates a visit to the arrival timestamp.
* **Familiarity Score:** Computes proximity-based exponential distance decay:
  $$\text{Familiarity} = e^{-\frac{\text{Distance}}{2 \times \text{Radius}}}$$
  Returns `1.0` if inside the geofence, and decays toward `0.0` as the user moves further away.

### D. ContextEngine
The **ContextEngine** determines the behavioral anomaly profile of the current moment.
* **Familiarity Scoring (3-Level Comparison):** It compares the current 15-minute behavioral window ($W_T$) against three historical baselines:
  - **Level 1 (Session):** $W_T$ vs. the last 15–30 minutes. Determines if the user's activity has suddenly changed during the current session.
  - **Level 2 (Circadian Today):** $W_T$ vs. earlier periods today.
  - **Level 3 (Circadian Historical):** $W_T$ vs. the same 15-minute slot over the last 30 days (excluding today).
* **Similarity Metric:** Calculates a combined similarity score based on:
  - Motion distribution cosine similarity
  - Location node matching (GPS distance)
  - Temporal distance (time-of-day Gaussian decay)
* **Weights:** Final Familiarity = $0.2 \times L1 + 0.3 \times L2 + 0.5 \times L3$.
* **Threat Score Modulation:** Recalculated in `App.js` at 2 Hz:
  $$\text{Threat Score} = \text{Base Threat} \times (1.3 - 0.6 \times \text{Familiarity})$$
  This dampens alerts in familiar contexts (e.g., falling at home is weighted differently than falling in an unknown location).

---

## 3. Bluetooth Low Energy (BLE) Communication

The app connects using the `react-native-ble-plx` library. On connection, it follows a strict handshake:
1. **Stabilization Delay:** Wait 800ms for connection parameters to settle.
2. **MTU Negotiation:** Requests an MTU of 64 bytes. This is critical because the default BLE MTU (23 bytes) would fragment the 34-byte `EVENT` packets, causing checksum failures.
3. **GATT Discovery:** Queries all service characteristics.
4. **Subscription (Notifications):** Subscribes to four distinct notification characteristics:
   - `CHAR_UUID_EVENT` (0x01): Direct hardware trigger for anomaly events.
   - `CHAR_UUID_STATUS` (0x02): Periodic 30s heartbeat.
   - `CHAR_UUID_SENSOR` (0x03): High-rate 25 Hz raw IMU data (active only when graph is shown).
   - `CHAR_UUID_FEATURE` (0x04): Low-rate 2 Hz TinyML features and 16D embeddings.
5. **Streaming Command:** After a 1500ms stabilization window, writes `0x01` to the command characteristic to activate streaming.

---

## 4. Emergency Lifecycle & Pre-Alert Countdown

When a threat score $\ge 72\%$ is computed, the `useEmergency` hook initiates the alert sequence:

```
+--------------------+
|  Threat >= 72%?    |
+---------+----------+
          | Yes
          v
+---------+----------+
|  15s Countdown     | <--- Vibrate + flashing red screen (if not silent)
+---------+----------+
          |
          +-------------------+-------------------+
          | Timeout           | Cancel Pressed    | Send Now Pressed
          v                   v                   v
+---------+----------+   +----+-------------+   +-+------------------+
|  Normal Dispatch   |   | Ask Security PIN |   |  Normal Dispatch   |
+---------+----------+   +----+-------------+   +--------------------+
                              |
            +-----------------+-----------------+
            | Real PIN                          | Fake (Duress) PIN
            v                                   v
+-----------+--------+                  +-------+------------+
| - Close Modal      |                  | - Close Modal      |
| - Send 0xFF BLE    |                  | - Silent Dispatch  |
| - 20s Cooldown     |                  |   (Add duress flag)|
+--------------------+                  +--------------------+
```

### Dispatch Channels (Parallel Execution)
* **SMS:** Twilio REST API request.
* **WhatsApp:** Supports three delivery methods:
  - **Native Link:** Opens the device's WhatsApp app pre-filled with the alert message (wa.me deeplink fallback).
  - **CallMeBot:** Requests a personal gateway link.
  - **Twilio WhatsApp:** Twilio Business API POST request.
* **Email:** Resend API integration.

---

## 5. SQLite Schema & Storage System

The database contains 9 primary tables. All nested arrays/objects are stored as serialized JSON text:

1. **`settings`**: Key-value configurations (API keys, security PINs, flags).
2. **`contacts`**: Emergency contacts list with active flags and method keys.
3. **`templates`**: Text messages with placeholder replacement tags (`{name}`, `{maps_link}`, etc.).
4. **`observations`**: Stored 3s window embeddings, features, and cluster versions.
5. **`motion_clusters`**: Centroid vectors and schemas for cluster assignment.
6. **`episodes`**: Behavior logs detailing start/end timestamps and familiarity statistics.
7. **`episode_motion_timelines`**: 3s interval slices for each episode, tracking reconstruction error mean.
8. **`location_nodes`**: Geofenced regions centered at GPS coordinates with stay durations.
9. **`location_visits`**: Log of entries/exits from learned geofenced zones.
10. **`inference_logs`**: Logs of context engine decisions for diagnostics.

---

## 6. Static Analysis — Codebase Bugs & Risks

During the mobile codebase review, seven bugs/architectural risks were identified:

### 🔴 High Severity

#### Destructive DB Migration (`Database.js`)
* **Problem:** If a user upgrades the app and the old `observations` table is missing the `cluster_version` column, the app runs `DROP TABLE observations` and `DROP TABLE motion_clusters`. This destroys the user's entire 30-day historical behavior baseline.
* **Impact:** The ContextEngine resets. Familiarity scores drop to 0.0, and the user faces elevated false alarms for weeks.
* **Fix:** Use an `ALTER TABLE observations ADD COLUMN cluster_version INTEGER DEFAULT 0;` block instead of dropping the table.

---

### 🟡 Medium Severity

#### Event Packet Sequence ID Missing (`useBle.js` / `setCurrentPacket`)
* **Problem:** In `useBle.js`, when processing an `EVENT` packet, the updater does not assign `sequenceId` into `currentPacket`.
* **Impact:** The PCA plot in `DashboardTab.js` uses `sequenceId` to deduplicate incoming embeddings. Since the ID is missing during an event, the PCA plot treats the emergency anomaly embedding as a duplicate and **discards it**. The plot fails to show the fall/anomaly embedding.
* **Fix:** Add `sequenceId: parsed.sequenceId` to the EVENT branch of `setCurrentPacket`.

#### Stale `isStreaming` Closure (`useBle.js`)
* **Problem:** `handleIncomingPacket` is set up once on connection and captures the initial `isStreaming` state variable. When the user stops streaming, the callback still references `isStreaming = true`.
* **Impact:** SENSOR packets continue to populate `streamData` and re-render the graph when they shouldn't.
* **Fix:** Use an `isStreamingRef.current` reference that updates on state changes to check streaming status.

#### `forEach` + `async` Dispatch Anti-Pattern (`useEmergency.js`)
* **Problem:** The emergency dispatch loop uses `.forEach(async (contact) => { ... })`. In JS, `forEach` does not await async functions — it fires them in parallel and returns instantly.
* **Impact:** Synchronous setup errors can escape try/catch blocks and be swallowed as unhandled promise rejections. The app also cannot detect when dispatch is fully complete (relying on a hardcoded 2s wait instead).
* **Fix:** Map contacts to an array of promises and execute using `await Promise.allSettled(dispatchPromises)`.

---

### 🟢 Low Severity

#### Base64 Encoder Duplication (`useDatabase.js` & `useEmergency.js`)
* **Problem:** The identical `base64Encode` function is copy-pasted in both files.
* **Impact:** Increased codebase maintenance overhead and a risk of divergence.
* **Fix:** Extract to a shared utility helper file.

#### Cooldown Timer Interval Leak (`useEmergency.js`)
* **Problem:** If the emergency overlay is unmounted mid-cooldown, the `setInterval` remains active.
* **Impact:** Fires state updates on an unmounted component, throwing console warnings in development.
* **Fix:** Assign the interval ID to a ref and clear it in a `useEffect` cleanup return.

#### Welford M2 Restoration Precision Loss (`EpisodeEngine.js`)
* **Problem:** On app restart, the Welford $M_2$ accumulator is approximated from stored variance: `M2 = variance * timelineLength`.
* **Impact:** Introduces minor rounding errors in the 5th decimal place of familiarity calculations.
* **Fix:** Store `familiarity_m2` as a column directly in the database.
