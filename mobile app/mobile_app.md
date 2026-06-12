# SafeBand — Mobile App Architecture
## Document Version 1.0

---

## 1. Overview

The SafeBand mobile app is the intelligence layer of the system. The ESP32 firmware handles real-time sensor inference (is this motion unusual?), but the app handles **meaning inference** (does this unusual motion constitute an emergency?). This distinction is important — it offloads the cognitively expensive reasoning to a platform with more compute, connectivity, and contextual awareness.

The app must work reliably in the background, handle intermittent BLE connectivity gracefully, and execute emergency responses with zero ambiguity under stress.

---

## 2. Technology Stack

### Framework
**React Native (with Expo SDK 51+)** or **Flutter 3.x** — both are viable. This document uses React Native conventions, but the architecture maps directly to Flutter.

### Key Libraries

| Layer | Library | Purpose |
|---|---|---|
| BLE | `react-native-ble-plx` | BLE scan, connect, notify, write |
| Background | `react-native-background-actions` | Keep BLE listener alive when app is backgrounded |
| Location | `expo-location` | GPS coordinates + geofencing |
| Notifications | `expo-notifications` | Local push alerts, full-screen intents |
| Storage | `expo-sqlite` + `MMKV` | SQLite for history; MMKV for fast key-value state |
| Audio | `expo-av` | Microphone sampling for sound context |
| SMS | `react-native-sms` + direct API | Emergency SMS sending |
| Charts | `Victory Native` or `react-native-gifted-charts` | Sensor graphs |
| State | `Zustand` | Lightweight global state |
| Navigation | `React Navigation v6` | Stack + Tab navigator |

---

## 3. App Architecture

```
┌─────────────────────────────────────────────────────┐
│                    UI Layer                          │
│  Dashboard | History | Graphs | Feedback | Settings  │
└───────────────────────┬─────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────┐
│                 Zustand Store                        │
│  deviceState | alertState | historyState | settings  │
└──────┬──────────────────────────────────┬────────────┘
       │                                  │
┌──────▼──────┐              ┌────────────▼────────────┐
│  BLE Service │              │   Context Engine         │
│  (Background)│              │   (Analyser Module)      │
│             │              └────────────┬────────────┘
│  Scan/Connect│                          │
│  Parse Pkts  │              ┌────────────▼────────────┐
│  Reconnect   │              │   Emergency Engine       │
└──────┬───────┘              │   (Responder Module)     │
       │                      └────────────┬────────────┘
       │                                   │
┌──────▼───────────────────────────────────▼────────────┐
│                 Data Layer                              │
│   SQLite (history) | MMKV (fast state) | AsyncStorage  │
└────────────────────────────────────────────────────────┘
```

---

## 4. BLE Service

### 4.1 Connection Lifecycle

The BLE service runs as a foreground service (Android) / background task (iOS) at all times once the user has paired a device.

```
App launch
  └─> Restore last known device UUID from MMKV
        └─> Attempt direct connect (skip scan if UUID known)
              ├─ Success → subscribe to notify characteristic 0xFE01
              └─ Fail    → start scan with 5-second timeout
                              └─ On find → connect → subscribe
                                  └─ On fail → retry after 15s (exponential backoff up to 2 min)
```

**Reconnection Strategy:**
- Exponential backoff: 5s → 15s → 30s → 60s → 120s (then stay at 120s)
- On Bluetooth re-enable: immediate retry
- On app foreground: immediate retry
- On Android: use `autoConnect = true` in the BLE connect call to let the OS handle reconnection natively as a fallback

### 4.2 Packet Parser

```typescript
function parseIncomingPacket(bytes: Uint8Array): ParsedPacket | null {
  const type = bytes[0];
  
  // Validate checksum
  const checksum = bytes.slice(0, -1).reduce((acc, b) => acc ^ b, 0);
  if (checksum !== bytes[bytes.length - 1]) {
    console.warn('Checksum mismatch — dropping packet');
    return null;
  }

  switch(type) {
    case 0x01: return parseEventPacket(bytes);
    case 0x02: return parseStatusPacket(bytes);
    case 0x03: return parseSensorPacket(bytes);
    default:   return null;
  }
}
```

Each parse function returns a strongly-typed object. Event packets are immediately forwarded to the Context Engine. Sensor packets are buffered in a circular array for graph rendering. Status packets update device health state.

### 4.3 Sequence ID Tracking

The app tracks the last seen Sequence ID per packet type. If IDs are non-sequential, a `packetDropped` event is logged. Dropped event packets trigger a status re-request (command 0x03) to resync.

---

## 5. The Context Engine

### 5.1 Philosophy

The Context Engine answers a single question: **"Given everything the app knows right now, how likely is this an emergency?"**

It does NOT make binary yes/no decisions. It computes a continuous **threat score** (0.0 – 1.0) by combining multiple evidence streams. Only when the threat score crosses a configurable threshold (default 0.72) is an emergency protocol initiated.

This threshold-based design has a critical property: **each context factor acts as a multiplier or modifier**, not a gate. A high anomaly score from a known-safe location (home) should produce a lower threat score than the same anomaly at an unknown late-night location. No single factor should be able to force a false positive.

---

### 5.2 Input Signals

#### Signal A: Motion Evidence (from Event Packet)
The raw intelligence from the device.

| Sub-signal | Source | Interpretation |
|---|---|---|
| Anomaly Score | Event Byte 4 | How deviant is this motion from the model's normal distribution |
| Confidence | Event Byte 5 | How many consecutive anomalous windows were detected |
| Anomaly Duration | Event Byte 7 | How long it has been going on (in 100ms units) |
| Motion State Flags | Event Byte 6 | Is it still, rhythmic, chaotic, high-impact, or restrained? |
| Peak Resultant Accel | Event Bytes 8–9 | Impact magnitude (falls typically > 3g = 3000 mg) |
| Dominant Frequency | Event Byte 10 | Frequency signature |
| ZCR + Spectral Entropy | Bytes 11, 12 | Rhythm vs chaos discrimination |
| Eigenvalue Ratio | Bytes 13–14 | Directionality (linear fall vs multidirectional struggle) |

**Motion Pattern Classification** (computed in the context engine from the above):
```
Pattern = classify(motionStateFlags, peakAccel, dominantFreq, ZCR, spectralEntropy)

Rules:
  If highImpact AND linear AND duration < 5s    → FALL_CANDIDATE       (weight: 0.80)
  If chaotic AND !highImpact AND duration > 8s  → STRUGGLE_CANDIDATE   (weight: 0.75)
  If periodic AND lowEntropy AND duration > 10s → SEIZURE_CANDIDATE    (weight: 0.70)
  If restrained AND lowVariance AND duration > 6s → PINNED_CANDIDATE   (weight: 0.65)
  If anomalous AND nothing matches above        → UNKNOWN_ANOMALY      (weight: 0.40)
```

---

#### Signal B: Temporal Persistence Evidence

How long the anomaly has been active. Brief anomalies (< 1.5s) are mostly sensor artifacts or sudden innocent gestures. Sustained anomalies are increasingly credible threats.

```
Duration Factor:
  0 – 1.5 seconds  : factor = 0.10   (likely artifact — filter almost everything out)
  1.5 – 3 seconds  : factor = 0.35
  3 – 6 seconds    : factor = 0.60
  6 – 12 seconds   : factor = 0.80
  > 12 seconds     : factor = 0.95   (sustained anomaly — very high credibility)
```

Additionally, track **post-anomaly stillness**: if motion stops abruptly and then the device reads near-zero acceleration for > 5 seconds, this is a strong indicator of a fall resulting in incapacitation (the person is now lying still). Add +0.15 to threat score in this case.

---

#### Signal C: Historical Pattern Evidence

The app maintains a **local pattern library** — a database of every past event and its outcome (emergency / false positive / unknown). When a new event arrives:

1. Extract the current event's feature signature (anomaly score, dominant frequency, ZCR, eigenvalue ratio, motion pattern).
2. Compute cosine similarity to each past event in the library.
3. Find the K=5 nearest past events.
4. Compute a **weighted verdict**:
   - If most similar past events were false positives: reduce threat score by up to 0.20
   - If most similar past events were genuine emergencies: increase by up to 0.25
   - If no similar past events exist: neutral (±0)

```typescript
function historicalEvidence(currentEvent: EventFeatures): number {
  const nearestK = patternLibrary.findNearest(currentEvent, k=5);
  if (nearestK.length === 0) return 0;  // no history, neutral

  const falsePositiveRate = nearestK.filter(e => e.outcome === 'false_positive').length / nearestK.length;
  const emergencyRate     = nearestK.filter(e => e.outcome === 'emergency').length / nearestK.length;

  return (emergencyRate * 0.25) - (falsePositiveRate * 0.20);
}
```

This makes the system **personalised over time** — a user who exercises intensely will accumulate false positives for high-ZCR, high-impact motion, and the engine learns to discount those.

---

#### Signal D: Location Context

GPS location informs the risk profile of an anomaly.

**Location Categories:**
```
HOME          : User's registered home address ± 50m geofence
KNOWN_SAFE    : Other registered safe places (work, gym, family)
UNKNOWN_URBAN : GPS fix, in a populated area, but not registered
UNKNOWN_ISOLATED : Low population density or no nearby POIs
INDOORS_KNOWN : Correlated with known indoor spaces (via WiFi SSID)
```

**Location Risk Multipliers:**

| Category | Multiplier | Reasoning |
|---|---|---|
| HOME | × 0.55 | Falls at home are still emergencies but false positive rate is highest here |
| KNOWN_SAFE | × 0.65 | Lower risk environment |
| UNKNOWN_URBAN | × 1.00 | Neutral baseline |
| UNKNOWN_ISOLATED | × 1.35 | Harder for help to arrive; err toward alerting |
| GPS_UNAVAILABLE | × 1.10 | Slight increase in caution when location unknown |

**Location Velocity** (optional, powerful): If the user's location has been changing rapidly in recent minutes (running, cycling, in a vehicle) but suddenly stops moving, this context raises threat score. Combine with post-anomaly stillness signal.

---

#### Signal E: Time of Day Context

Risk profile varies significantly by time of day.

```
00:00 – 06:00  : NIGHT_RISK    × 1.20  (reduced help availability, sleepwalking/medical events)
06:00 – 09:00  : MORNING       × 1.00
09:00 – 18:00  : DAYTIME       × 0.90  (peak social contact, lowest risk)
18:00 – 22:00  : EVENING       × 1.00
22:00 – 00:00  : LATE_NIGHT    × 1.15
```

---

#### Signal F: Sound Context (Optional — requires microphone permission)

Brief microphone sampling (2-second window, 16kHz) triggered when an anomaly event arrives. The app runs a lightweight on-device sound classifier (TFLite) to detect:

| Sound Event | Effect on Threat Score |
|---|---|
| Scream / distress vocalisation | +0.30 |
| Impact / crash / glass breaking | +0.20 |
| Loud raised voices | +0.10 |
| Silence in an expected-social context | +0.05 |
| Normal ambient noise | ±0.00 |
| User's own calm voice detected | −0.15 (user likely just gesturing while talking) |

Privacy note: Audio is never recorded or stored. Only the classifier output (a label + confidence score) is used. The microphone is sampled for ≤2 seconds per event.

---

#### Signal G: Device Wear State

From Status Packet or Event Packet Byte 16 (Wear Confidence):

```
Wear Confidence < 30%  : Device likely not worn → suppress all alerts
Wear Confidence 30–60% : Degraded confidence → reduce threat score × 0.7
Wear Confidence > 60%  : Normal operation
```

This prevents false alerts when the device has been removed and left on a surface.

---

### 5.3 Threat Score Computation

```
threatScore = 0

// Base from motion evidence
baseMotionScore = anomalyScore_normalised × patternWeight  // e.g., 0.85 × 0.80 = 0.68

// Apply temporal persistence
threatScore = baseMotionScore × durationFactor  // e.g., 0.68 × 0.80 = 0.544

// Add post-anomaly stillness bonus
if (postAnomalyStillness) threatScore += 0.15

// Apply historical adjustment
threatScore += historicalEvidence(currentEvent)  // e.g., +0.05

// Apply location multiplier
threatScore *= locationMultiplier  // e.g., × 1.00

// Apply time-of-day multiplier
threatScore *= timeMultiplier  // e.g., × 1.20

// Apply sound evidence addend
threatScore += soundEvidence  // e.g., +0.00

// Apply wear confidence
if (wearConfidence < 0.60) threatScore *= 0.70

// Clamp to [0, 1]
threatScore = clamp(threatScore, 0.0, 1.0)
```

For the example above: `threatScore ≈ 0.544 × 1.20 + 0.05 + 0.15 ≈ 0.85` → Emergency threshold crossed.

---

### 5.4 Threat Score Levels

| Score Range | Level | Action |
|---|---|---|
| 0.00 – 0.40 | NORMAL | Log event silently, update pattern library |
| 0.40 – 0.55 | LOW_ALERT | Haptic notification on phone, start logging sensor data |
| 0.55 – 0.72 | ELEVATED | Screen notification, start countdown timer, begin location tracking |
| 0.72 – 0.88 | HIGH | Full-screen alert, start countdown (15s to cancel), pre-compose SMS |
| 0.88 – 1.00 | CRITICAL | Immediate emergency response, no countdown |

The CRITICAL level (score > 0.88) is reserved for patterns like: high anomaly score + fall pattern + post-anomaly stillness + night-time + isolated location. In this case, waiting 15 seconds for confirmation could be the difference between life and death.

---

### 5.5 Hysteresis and Cooldown

- Once a threat score drops back below 0.55 without triggering an emergency, enter a **2-minute cooldown** before the engine is fully sensitive again. This prevents alert storms if the user is in an unusually active but non-emergency situation.
- If the user cancelled a false alert, log the event as `false_positive` and enter a **5-minute reduced-sensitivity cooldown** (all incoming threat scores multiplied by 0.6 for this period).

---

## 6. The Emergency Engine

### 6.1 Design Principles

1. **No false silences**: It is always better to alert unnecessarily than to miss a real emergency. Design with this asymmetry in mind.
2. **User can always cancel**: Every emergency protocol has a clear, obvious cancel path that works within 15 seconds.
3. **Graceful degradation**: If SMS fails, try VOIP call. If call fails, push to a server. If internet is down, the app still sounds a local alarm.
4. **Minimal friction to cancel, maximal friction to dismiss permanently**: A user should be able to stop the alert in 2 taps, but should NOT be able to accidentally disable the emergency system.

---

### 6.2 Emergency Protocol State Machine

```
                    threatScore ≥ 0.72
                          │
                          ▼
              ┌─────────────────────────┐
              │     PRE_ALERT state      │
              │  - Full-screen overlay   │
              │  - Loud phone vibration  │
              │  - 15-second countdown   │
              │  - "ARE YOU OK?" prompt  │
              └───────────┬─────────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
     User taps        User taps       Countdown
     "I'M SAFE"       "HELP ME"        expires
          │               │               │
          ▼               ▼               ▼
     CANCELLED        EMERGENCY       EMERGENCY
     state            state           state
          │               │               │
     Log as FP      [Execute         [Execute
     & notify       Protocol]        Protocol]
     contacts
     "User is safe"
```

---

### 6.3 Emergency Protocol Execution

When the EMERGENCY state is reached, execute the following steps **in parallel** (not sequentially — don't wait for one to finish before starting another):

#### Step 1: Local Alarm
- Play a loud alarm tone at maximum volume
- Override silent/DND mode (requires special permission on Android)
- Flash the screen with high-contrast red overlay
- Continuous haptic vibration pattern

#### Step 2: Location Snapshot
- Acquire GPS fix immediately (force high-accuracy mode)
- If GPS unavailable within 5 seconds, use last known location + note "approximate"
- Format as: human-readable address (reverse geocoded) + raw coordinates

#### Step 3: Notify Emergency Contacts
Send to all registered emergency contacts (in priority order):

**SMS Message (Primary):**
```
🚨 EMERGENCY ALERT from [User Name]'s SafeBand
Possible emergency detected at:
[Human Address]
[Google Maps link: https://maps.google.com/?q=LAT,LONG]

Time: [HH:MM, Day Date]

To confirm you received this: reply OK
If you cannot reach [User Name], call emergency services.

— SafeBand App
```

**Push Notification** (if contact has the app):
- Rich notification with map preview, one-tap "I'm responding" button
- Contact's response is relayed back to the emergency user's phone

**VOIP Call** (if SMS fails):
- Automated voice call using a VOIP API (Twilio or similar) reading the alert message

#### Step 4: Optional — Contact Emergency Services
- Show a prominent "CALL 911 / 112" button on the emergency screen
- Do NOT auto-call emergency services — the legal and ethical implications of an automated call are significant
- If the user is unconscious but had pre-configured "auto-call after 60 seconds of no interaction": call

#### Step 5: Sensor Log Upload
- Upload the last 60 seconds of sensor data (buffered from Sensor Packets or inferred from event history) to the backend
- This gives emergency contacts and responders context about what happened
- Store encrypted, with a shareable link

#### Step 6: Keep Alive
- Continue emergency mode until:
  - User manually dismisses (requires PIN or biometric — prevents accidental dismissal)
  - An emergency contact confirms they are responding (app-to-app)
  - 30 minutes elapse with no response (auto-escalate to a backend call service, if configured)

---

### 6.4 Emergency Contact Management

Each emergency contact record stores:
```
{
  name: string,
  phone: string,
  email: string (optional),
  hasSafeBandApp: boolean,
  notifyMethod: ['sms', 'push', 'call'],  // priority order
  language: string  // for SMS template localisation
}
```

The app verifies contacts by sending a test message when first added and requiring the contact to reply. This confirms the number is correct and the contact understands their role.

---

## 7. User Feedback System

### Purpose
Feedback closes the loop between the Context Engine and reality. Without it, the engine cannot learn from mistakes.

### Feedback Triggers

After every non-cancelled alert (and for the first 5 low-level alerts that were silently dismissed), show a feedback card within 2 minutes of the event ending.

### Feedback UI
A simple card (not a modal — should not interrupt current activity):

```
┌─────────────────────────────────────────────┐
│  📊 Motion Alert — 2 minutes ago             │
│                                              │
│  Was this alert accurate?                    │
│                                              │
│  [✅ Yes, real emergency]  [❌ False alarm]   │
│                                              │
│  What were you doing? (optional)             │
│  [Text field]                                │
│                                              │
│  [Skip]                              [Done]  │
└─────────────────────────────────────────────┘
```

### What Feedback Does
1. Labels the event as `emergency` or `false_positive` in the local pattern library
2. Updates the historical evidence model with the correct label
3. If "false_positive" is given for a pattern ≥3 times: the engine flags this pattern as a personal baseline and automatically lowers its base threat score weight by 10%
4. Activity tag (free text) is used for future display in history

---

## 8. History & Analytics

### Event History Screen
A reverse-chronological list of all detected events with:
- Timestamp, duration, threat score (shown as a colored severity badge)
- Location (map pin or "Home")
- Outcome (emergency / false positive / unknown / ongoing)
- Tap to expand: full event details, motion pattern classification, context factors breakdown

**Context Breakdown Card** (on expand):
Shows how the threat score was built — which factors contributed how much. This helps users understand and trust the system.

```
Threat Score: 0.63  [ELEVATED]
├── Motion Anomaly:      0.54  ██████████░░░░ (80% of base)
├── Duration (8s):       × 0.80 applied
├── Location (Home):     × 0.55 applied
├── Time (14:00):        × 0.90 applied
├── Historical:          +0.02  (1 similar past event, unknown)
└── Sound:               +0.00  (not triggered)
```

### Statistics Screen
- Total events this week/month
- False positive rate
- Most common motion pattern flagged
- Time-of-day heatmap of events
- Location heatmap (if user consents)

---

## 9. Sensor Graph Screen

Displays live or historical sensor data. Three views:

### Live View
- Requires sensor streaming to be started (app sends command 0x01 to device)
- Real-time line chart: Resultant Acceleration, Jerk, Gyro Magnitude
- Overlay: current Anomaly Score as a colored band (green/yellow/red)
- Auto-scales Y axis, scrolls at 25 Hz
- Record button: saves current stream to a labeled file (for training data collection)

### Historical View
- Select any past event from history
- Replay the sensor data from that event window
- Overlay shows where threshold was exceeded
- Useful for reviewing false positives and understanding what triggered them

### Feature View
- Shows the computed Tier 1 & 2 features as a radar chart per window
- Primarily for power users and developers
- Hidden behind a "Developer Mode" toggle in settings

---

## 10. Settings & Configuration

### Device Settings
- Paired device name / UUID
- Forget device
- Sensitivity adjustment (slider that modifies threat threshold from 0.55 to 0.85)
- Test alert button

### User Profile
- Name (used in emergency SMS)
- Medical notes (optional, appended to emergency messages: "Note: User has epilepsy")
- Home and safe location registration

### Emergency Contacts
- Add / remove / reorder contacts
- Test notification button per contact
- Auto-call after N seconds (default: off)

### Context Engine Settings
- Enable/disable sound context (microphone permission)
- Enable/disable location context
- Sensitivity presets: Conservative / Balanced / Sensitive
- Cooldown duration adjustment

### Privacy
- Event history retention period (7 days / 30 days / Forever / Off)
- Opt out of pattern library learning
- Clear all local data

---

## 11. Background Service Architecture

The BLE listener and context engine must survive app backgrounding and OS task-killing (especially aggressive on Chinese Android OEMs).

### Android
Use a **Foreground Service** with a persistent notification:
```
"SafeBand is active — monitoring for your safety"   [Settings]
```
This prevents the OS from killing the service. Request `FOREGROUND_SERVICE_CONNECTED_DEVICE` permission.

### iOS
Use `CBCentralManager` with `CBConnectPeripheralOptionNotifyOnNotificationKey` — iOS will relaunch the app in the background when the BLE device sends a notification, even if the app was killed. However, processing time is limited (~30 seconds). The context engine must complete its analysis within this window.

For emergency execution (SMS sending, audio playback), iOS requires a notification with `categoryIdentifier` set to an action category. The full emergency screen is launched via a `UNNotificationContentExtension` or a regular app foreground launch triggered by the notification.

---

## 12. Data Schema (SQLite)

### Table: `events`
```sql
CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp       INTEGER NOT NULL,        -- Unix epoch ms
  anomaly_score   REAL,
  confidence      INTEGER,
  duration_ms     INTEGER,
  motion_pattern  TEXT,                    -- 'FALL', 'STRUGGLE', 'SEIZURE', 'UNKNOWN'
  threat_score    REAL,
  threat_level    TEXT,                    -- 'LOW', 'ELEVATED', 'HIGH', 'CRITICAL'
  outcome         TEXT,                    -- 'emergency', 'false_positive', 'unknown', 'cancelled'
  location_lat    REAL,
  location_lng    REAL,
  location_label  TEXT,                    -- 'Home', 'Unknown', etc.
  user_activity   TEXT,                    -- free text from feedback
  raw_packet_hex  TEXT,                    -- hex dump of original event packet
  created_at      INTEGER DEFAULT (strftime('%s','now'))
);
```

### Table: `contacts`
```sql
CREATE TABLE contacts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL,
  email           TEXT,
  notify_methods  TEXT,                    -- JSON array: ["sms", "push"]
  has_app         INTEGER DEFAULT 0,
  verified        INTEGER DEFAULT 0,
  priority        INTEGER DEFAULT 0
);
```

### Table: `sensor_logs`
```sql
CREATE TABLE sensor_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        INTEGER REFERENCES events(id),
  timestamp       INTEGER,
  ax              INTEGER, ay INTEGER, az INTEGER,
  gx              INTEGER, gy INTEGER, gz INTEGER,
  resultant       INTEGER,
  jerk            INTEGER,
  anomaly_score   INTEGER
);
```

### Table: `pattern_library`
```sql
CREATE TABLE pattern_library (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        INTEGER REFERENCES events(id),
  anomaly_score   REAL,
  dominant_freq   REAL,
  zcr             REAL,
  spectral_entropy REAL,
  eigenvalue_ratio REAL,
  motion_flags    INTEGER,
  outcome         TEXT,                    -- 'emergency', 'false_positive', 'unknown'
  similarity_weight REAL DEFAULT 1.0       -- reduced if this data point was an outlier
);
```

---

## 13. Screen Map

```
Tab Navigator:
├── 🏠 Dashboard
│     └── Connection status, wear state, battery, last event card, threat level indicator
├── 📋 History
│     └── Event list → Event Detail (with context breakdown card)
│           └── Sensor Replay view
├── 📈 Graphs
│     └── Live sensor view | Historical event view | Feature radar view
├── 💬 Feedback
│     └── Pending feedback cards for recent events
└── ⚙️ Settings
      ├── Device settings
      ├── User profile
      ├── Emergency contacts
      ├── Context engine settings
      └── Privacy

Modal overlays:
├── Emergency Alert screen (full-screen, launched by notification or foreground trigger)
└── Onboarding flow (first launch: pair device → add contacts → register home → test alert)
```

---

## 14. Onboarding Flow

A new user must complete these steps before the system is active:

1. **Bluetooth Permissions** — request and explain why
2. **Scan & Pair** — scan for SafeBand device, connect, confirm firmware version compatibility
3. **Location Permission** — request always-on location, explain context engine benefits
4. **Microphone Permission** — optional, explain sound context
5. **Register Home Location** — tap to set current location as Home
6. **Add First Emergency Contact** — at least one contact required; send test notification
7. **Sensitivity Setup** — choose preset (Conservative / Balanced / Sensitive)
8. **Test Alert** — trigger a simulated alert to verify the full pipeline end-to-end
9. **Done** — system is now active

---

## 15. Privacy & Security Considerations

- All event data is stored **locally on device** by default
- Emergency SMS contains minimal PII — only name and location
- Sensor logs are not transmitted unless the user explicitly shares an event report
- Audio is processed entirely on-device; never stored or transmitted
- Optional cloud backup of history is end-to-end encrypted using a key derived from the user's biometric/PIN (never the raw biometric — use a derived key via Secure Enclave / Android Keystore)
- BLE characteristic data is not encrypted at the application layer (rely on BLE pairing security), but could be AES-128 encrypted with a shared key provisioned during device pairing for higher-security use cases
