# SafeBand — System Architecture & Flow Guide
## End-to-End Design Philosophy & Functional Specs

---

## 1. System Philosophy: Edge-Inference & Local Safety
The core philosophy of the SafeBand platform is **Edge-Inference & Local Autonomy**. 

Unlike traditional wearables that upload raw accelerometer signals to the cloud for heavy computation:
1. **Low Latency:** TinyML model inference runs entirely on the wristband. This ensures immediate fall/struggle detection, regardless of cellular network quality.
2. **Privacy by Design:** Raw IMU waveforms are never transmitted off the device, saving battery and bandwidth. Only low-rate 16D behavioral vectors (embeddings) are shared.
3. **Smart Integration:** The mobile phone act as the local coordinator, database, and notification gateway. It applies temporal, spatial, and historical context to the device's anomaly signals to make the final threat decision.

---

## 2. End-to-End System Architecture

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
        HYS["Hysteresis Filter (3 windows check)"]
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
    HYS -->|Hysteresis breach (3 windows)| EVENT_PACKET
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

## 3. Step-by-Step Incident Lifecyle (E.g., User Falls)

```
[ Wristband ]
  1. IMU measures 100 Hz acceleration.
  2. Fall impact occurs -> peak acceleration RMS spikes.
  3. Feature extractor builds a 200-sample window capturing the fall.
  4. Autoencoder reconstructs the window. MAE score reaches 2.45 (Threshold: 1.01647).
  5. The score remains elevated for 3 consecutive windows (1.5 seconds).
  6. Device sends an EVENT packet (Type 0x01) with the anomaly score and 16D embedding.

[ BLE & Mobile Receiver ]
  7. Mobile app receives the EVENT packet.
  8. MotionEngine captures the packet. Writes observation to SQLite database.
  9. EpisodeEngine detects an anomaly state change. Closes the current normal episode.

[ Context & Threat Evaluation ]
 10. LocationEngine estimates familiarity. User is in an unknown location (Familiarity = 0.15).
 11. ContextEngine compares recent logs against historical data. No matching sessions are found.
 12. App.js evaluates threat score using `computeThreatScoreDetailed()`:
     - Normalizes anomaly score
     - Applies high-impact and linear eigenvalue weights (+0.80)
     - Applies the unknown location multiplier (1.3)
     - Computes a final threat score of 92% (>= 72%).

[ Dispatch Countdown & Action ]
 13. Pre-alert countdown modal opens. Countdown displays 15 seconds.
 14. Device vibrates and flashes a red alert screen.
 15. The countdown timer expires without user cancellation.
 16. App fetches current GPS coordinates and reverse-geocodes them to a street address.
 17. Parallel API calls are executed:
     - SMS sent via Twilio REST API.
     - WhatsApp message sent via Twilio / CallMeBot / Native Link.
     - Email sent via Resend API.
 18. Dispatch status card displays results in the app modal.
```

---

## 4. System Security & Verification Safeguards

To prevent false alarms and malicious misuse, the system implements three protection mechanisms:

1. **Security PIN Screen:**
   If the pre-alert countdown is active, the user must enter a 4-digit PIN code to cancel the alert:
   - **Real PIN:** Stops the alarm, clears the modal, sends a reset command (`0xFF`) to the wristband, and initiates a 20-second cooldown period.
   - **Fake (Duress) PIN:** Immediately closes the alert modal. To a coercion threat, it appears that the alarm was cancelled. However, the app silently dispatches the emergency messages in the background, appending a duress flag warning: `[WARNING: ALERT DISPATCHED UNDER DURESS / COERCION]`.
2. **Wear Confidence Mask:**
   Edge-level checks suppress anomaly detection if the band is not worn. If total acceleration variance remains below 100 for 10 minutes, wear confidence decays to 0% and suppresses alert events.
3. **Database Retention Policy:**
   Every time the user runs a database cleanup, a background process removes observations, timelines, and inference logs older than 7 days. This keeps database query times fast and ensures the 7-day circadian comparison runs efficiently.
