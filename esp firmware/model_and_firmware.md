# SafeBand — ML Model, Feature Engineering & Firmware Protocol
## Document Version 1.0

---

## 1. Problem Framing

The device must distinguish **normal motion** from **anomalous / threat motion** in real time on a resource-constrained microcontroller (ESP32). The core challenge is:

- Normal motion is diverse (walking, typing, gesturing, eating) — the model must generalise across all of these.
- Anomalous motion is sparse and unknown at training time — we cannot enumerate every possible threat pattern.
- The temporal arrangement of a signal matters as much as its statistical distribution — two signals with identical eigenvalue spectra can encode completely different physical events.

The solution is a **reconstruction-based anomaly detector**: train a model only on normal motion, and flag anything the model fails to reconstruct well as anomalous.

---

## 2. Sensor Setup

### Hardware
- **IMU**: MPU-6050 or ICM-42688-P (preferred for lower noise floor)
- **Axes**: Accelerometer (Ax, Ay, Az) + Gyroscope (Gx, Gy, Gz)
- **Sample Rate**: 100 Hz (sufficient for capturing human motion up to 50 Hz Nyquist; human struggle/fall events are typically 1–20 Hz)
- **Range**: ±8g accelerometer, ±500 dps gyroscope (covers both normal and high-impact events)

### Coordinate Convention
Mount the band so that:
- **X** = along the forearm (longitudinal)
- **Y** = across the wrist (lateral)
- **Z** = perpendicular to the wrist face (normal)

Document this firmly — inconsistent mounting across devices will corrupt cross-device model transfer.

---

## 3. The Eigenvalue Problem and Why You Need Hybrid Features

### What eigenvalues give you
The covariance matrix of a multivariate signal window captures **how axes co-vary** — essentially, the orientation and spread of the point cloud in 6D space. Eigenvalues tell you the **magnitude** of variance along each principal component.

### What eigenvalues lose
Eigenvalues are **order-invariant decompositions of variance**. They compress an N×6 window into 6 scalars, discarding:

1. **Temporal sequencing**: `[10, 10, 10, 0, 0, 0]` and `[0, 10, 0, 10, 0, 10]` have identical variance but completely different temporal structure. The first is a sustained burst followed by stillness; the second is a rhythmic alternating pattern.
2. **Within-window dynamics**: The rise/fall profile, the rhythm, the inter-burst interval — all gone.
3. **Phase relationships between axes**: Two axes oscillating in-phase vs anti-phase look identical after eigendecomposition.

### The solution: Layered Feature Design

Use **three feature tiers** that are combined before feeding into the model:

---

## 4. Feature Engineering Pipeline

### Window Parameters
- **Window size**: 200 samples = 2 seconds at 100 Hz
- **Stride**: 50 samples = 0.5 seconds (75% overlap)
- This means 2 inferences per second with full 2-second context.

### Derived Signals (compute first, then extract features from these)
From raw (Ax, Ay, Az, Gx, Gy, Gz):

```
ResultantA  = sqrt(Ax² + Ay² + Az²)
ResultantG  = sqrt(Gx² + Gy² + Gz²)
Jerk        = d(ResultantA)/dt  (finite difference at 100 Hz)
SMA         = (|Ax| + |Ay| + |Az|) / 3    (Signal Magnitude Area per sample)
TiltAngle   = atan2(Az, sqrt(Ax²+Ay²))     (wrist tilt relative to gravity)
```

---

### Tier 1 — Statistical Temporal Features (solve the ordering problem)

Computed over the 200-sample window for each of the 9 channels: Ax, Ay, Az, Gx, Gy, Gz, ResultantA, Jerk, SMA.

| Feature | Formula / Description | Why it matters |
|---|---|---|
| Mean | μ = (1/N)Σx | DC offset / gravitational component |
| Standard Deviation | σ = sqrt((1/N)Σ(x-μ)²) | Overall activity level |
| RMS | sqrt((1/N)Σx²) | Energy; less sensitive to sign |
| Skewness | E[(x-μ)³]/σ³ | Asymmetry; falls have left-skewed jerk |
| Kurtosis | E[(x-μ)⁴]/σ⁴ - 3 | Impulsiveness; struggle has high kurtosis |
| Zero Crossing Rate | count(sign changes) / N | Distinguishes alternating vs sustained patterns — **directly solves your 10,10,10 vs 0,10,0 problem** |
| Mean Crossing Rate | count(crosses μ) / N | Captures oscillation frequency around mean |
| Interquartile Range | Q3 - Q1 | Robust spread measure |
| Peak-to-Peak | max(x) - min(x) | Dynamic range |
| Percentile Ratio | P90 / P10 | Shape of distribution tails |

**Why ZCR solves your specific problem:**
- Signal `[10,10,10,0,0,0]`: ZCR ≈ 0.1 (one sign change at the transition)
- Signal `[0,10,0,10,0,10]`: ZCR ≈ 1.0 (many sign changes)

These are now discriminable with a single scalar feature.

---

### Tier 2 — Frequency Domain Features (capture rhythm and periodicity)

Apply FFT to each channel over the 200-sample window (after Hanning windowing to reduce spectral leakage).

| Feature | Description |
|---|---|
| Dominant Frequency | argmax(\|FFT(x)\|), Hz |
| Spectral Energy in Bands | Energy in [0–2 Hz], [2–5 Hz], [5–12 Hz], [12–20 Hz] — covers rest, walking, vigorous activity, and impact bands respectively |
| Spectral Entropy | -Σ p_k * log(p_k) where p_k is normalized spectral power; measures frequency concentration vs spread |
| Peak Frequency Ratio | Energy at dominant frequency / total energy; high for periodic motion (walking), low for aperiodic struggle |
| Autocorrelation at Lag 1, 5, 10 | r(k) = Σ x(t)x(t+k); captures self-similarity at short, medium, and longer delays. Periodic signals have high r(k) at their period; aperiodic struggle does not. |

---

### Tier 3 — Structural / Cross-Axis Features (eigenvalue-based spatial features)

Now eigenvalues are still useful — just not sufficient alone.

From the 6×6 covariance matrix of [Ax, Ay, Az, Gx, Gy, Gz]:

| Feature | Description |
|---|---|
| λ₁, λ₂, λ₃ (top 3 eigenvalues) | Variance along principal components |
| λ₁ / (λ₁+λ₂+λ₃) | Linearity — motion dominated by one axis (like a fall) |
| (λ₁+λ₂) / Σλ | Planarity — motion confined to a plane |
| Σλ | Total variance (energy measure) |
| Condition number λ₁/λ₆ | Elongation of motion ellipsoid |
| Off-diagonal covariance terms | Cov(Ax,Gx), Cov(Ay,Gy), Cov(Az,Gz) — coupling between linear and rotational motion |

The cross-axis covariance terms are particularly powerful for struggle detection: voluntary reaching has smooth Accel-Gyro coupling, while struggle has chaotic, inconsistent coupling.

---

### Final Feature Vector

Combining all tiers:
- Tier 1: 10 features × 9 channels = **90 features**
- Tier 2: 7 features × 6 primary channels = **42 features**
- Tier 3: 12 structural features = **12 features**
- **Total: ~144 features per window**

For TinyML on ESP32, this is feasible — 144 float32 values = 576 bytes, well within SRAM.

---

## 5. Model Architecture

### Current: 1D CNN Autoencoder (retain and improve)

```
Input: (200, 6) — raw window of 6 IMU channels

Encoder:
  Conv1D(32 filters, kernel=5, stride=2, activation=ReLU)  → (100, 32)
  Conv1D(16 filters, kernel=3, stride=2, activation=ReLU)  → (50, 16)
  Conv1D(8 filters, kernel=3, stride=2, activation=ReLU)   → (25, 8)
  Flatten → Dense(32) → Latent vector (32-dim)

Decoder (mirror):
  Dense(25*8)
  Reshape(25, 8)
  Conv1DTranspose(16, kernel=3, stride=2)  → (50, 16)
  Conv1DTranspose(32, kernel=3, stride=2)  → (100, 32)
  Conv1DTranspose(6,  kernel=5, stride=2)  → (200, 6)

Loss: MAE (Mean Absolute Error) — more robust than MSE for outlier anomalies
```

The reconstruction error (mean MAE over the window) is the **anomaly score**.

---

### Target Architecture: Hybrid CNN-LSTM Autoencoder

This directly addresses the temporal limitation of pure eigenvalue approaches.

```
Input: (200, 6)

Encoder:
  Conv1D(32, kernel=5, stride=1, padding=same, activation=ReLU)
  MaxPool1D(2)                    → (100, 32)  — local feature extraction
  Conv1D(64, kernel=3, stride=1, padding=same, activation=ReLU)
  MaxPool1D(2)                    → (50, 64)   — higher-level patterns
  LSTM(64, return_sequences=True) → (50, 64)   — temporal dependencies
  LSTM(32, return_sequences=False)→ (32,)      — bottleneck

Decoder:
  RepeatVector(50)
  LSTM(32, return_sequences=True)
  LSTM(64, return_sequences=True)
  TimeDistributed(Dense(6))       → (50, 6)
  Upsample + Conv1DTranspose back to (200, 6)
```

**Why CNN first, LSTM second**: CNNs extract local motion motifs (a single step, a single gesture beat). The LSTM then models how those motifs evolve over the 2-second window. This respects the hierarchical nature of human motion.

---

### Anomaly Score Calibration

After training, run the model on a held-out validation set of normal motion to get a distribution of reconstruction errors. Set the anomaly threshold at:

```
threshold = μ_normal + 3σ_normal
```

This gives ~0.13% false positive rate under Gaussian assumptions. In practice, test and tune — aim for < 2 false alerts per hour in daily wear.

Additionally, add a **hysteresis filter**: an anomaly is only flagged if the reconstruction error exceeds the threshold for **3 consecutive windows** (1.5 seconds). Single-window spikes are usually sensor artifacts or sudden innocent gestures.

---

## 6. Training Data Collection Protocol

### Normal Motion Classes (collect ~15 min each)
- Resting (arm on table, on lap, standing still)
- Walking (slow, normal, fast)
- Running
- Arm gestures (typing, phone use, eating, waving)
- Exercising (cycling, weights — if in target user profile)
- Sleeping / night motion

### Recommended Anomaly Classes (for evaluation only — NOT used in training)
- Simulated fall (forward, sideways)
- Simulated struggle (arm grabbed and restrained)
- Simulated seizure-like motion (rhythmic arm convulsion)
- High-frequency random noise (sensor shake test)

These anomaly classes are **only used to validate** that the autoencoder correctly assigns high reconstruction error to them. They must never enter the training set.

### Data Collection Script
Collect at 100 Hz, label windows with activity class, store as HDF5 or numpy .npz files. Target: minimum 10,000 windows of normal motion before training.

---

## 7. TinyML Deployment on ESP32

### Quantization Strategy
After training in TensorFlow/Keras:

```python
# Post-training integer quantization
converter = tf.lite.TFLiteConverter.from_keras_model(model)
converter.optimizations = [tf.lite.Optimize.DEFAULT]
converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
converter.inference_input_type = tf.int8
converter.inference_output_type = tf.int8

# Calibration dataset (representative normal motion)
def representative_data_gen():
    for sample in calibration_data:
        yield [sample.astype(np.float32)]

converter.representative_dataset = representative_data_gen
tflite_model = converter.convert()
```

Target model size: < 100 KB (fits comfortably in ESP32's 4MB flash).

### Inference Pipeline on ESP32
```
Interrupt-driven ISR at 100 Hz fills circular buffer (200 × 6 int16 values)
Every 50 samples (stride), copy window → run feature extraction → run TFLite inference
If anomaly_score > threshold for 3 consecutive windows → trigger event packet
```

### Ring Buffer Design
Use a 200-sample circular buffer per axis. New samples overwrite oldest. Stride counter triggers inference at every 50th new sample. This gives continuous sliding-window inference at 2 Hz with no dead time.

---

## 8. Packet Protocol Specification

All packets are transmitted over BLE as raw byte arrays on a custom GATT characteristic. Byte order is **little-endian** throughout. Each packet has a 1-byte type prefix and a 1-byte XOR checksum at the end.

---

### 8.1 Event Packet (Type = 0x01)

Triggered when TinyML detects a sustained anomaly (3+ consecutive windows above threshold).

**Design rationale**: This packet must be small (BLE default MTU = 23 bytes, usable = 20 bytes), carry the anomaly's statistical fingerprint for context analysis on the phone, and include enough motion state for the context engine to work without needing a separate sensor packet.

| Byte(s) | Field | Type | Range / Unit | Description |
|---|---|---|---|---|
| 0 | Packet Type | uint8 | 0x01 | Identifies this as an Event packet |
| 1 | Sequence ID | uint8 | 0–255 (rolls over) | Rolling counter to detect dropped packets |
| 2–3 | Timestamp | uint16 | Seconds since boot | When the anomaly window started |
| 4 | Anomaly Score | uint8 | 0–255 (scaled from 0.0–1.0) | Reconstruction error normalised to [0,1] then × 255 |
| 5 | Confidence | uint8 | 0–100 (percent) | Internal model confidence, derived from how many consecutive windows exceeded threshold (capped: 3 windows = 33%, 6 = 66%, 9+ = 99%) |
| 6 | Motion State | uint8 | Bitmask | Bit 0: Still, Bit 1: Periodic (rhythmic), Bit 2: Aperiodic (chaotic), Bit 3: High-Impact, Bit 4: Restrained (low variance post-spike), Bits 5–7: Reserved |
| 7 | Anomaly Duration | uint8 | ×100ms units (1 = 100ms) | How long anomaly has persisted so far |
| 8–9 | Peak Resultant Accel | uint16 | mg (milli-g) | Peak resultant acceleration in the anomaly window |
| 10 | Dominant Frequency | uint8 | Hz × 2 (0.5 Hz resolution) | Dominant frequency of the anomalous motion |
| 11 | ZCR | uint8 | Scaled 0–255 (ZCR × 255, max = 1.0) | Zero crossing rate; distinguishes rhythmic vs burst patterns |
| 12 | Spectral Entropy | uint8 | Scaled 0–255 | Frequency spread; chaotic struggle is high entropy |
| 13–14 | Eigenvalue Ratio | uint16 | Scaled ×1000 (0–1000 = 0.0–1.0) | λ₁/(λ₁+λ₂+λ₃); linearity of motion. High = fall-like, low = multidirectional struggle |
| 15 | Battery Level | uint8 | 0–100 (percent) | ESP32 battery % at time of event |
| 16 | Wear Confidence | uint8 | 0–100 (percent) | Wrist-contact confidence from skin contact sensor or impedance estimate |
| 17 | Checksum | uint8 | XOR of bytes 0–16 | Integrity check |

**Total: 18 bytes** — fits within default BLE MTU.

---

### 8.2 Status Packet (Type = 0x02)

Sent periodically (every 30 seconds) for system health monitoring. Also sent immediately on connect and on significant battery change (±5%).

**Design rationale**: Lightweight heartbeat that lets the app know the device is alive, in good health, and properly worn. Enables the context engine to discount alerts when wear confidence is low (device may have been removed).

| Byte(s) | Field | Type | Description |
|---|---|---|---|
| 0 | Packet Type | uint8 | 0x02 |
| 1 | Battery Level | uint8 | 0–100 % |
| 2 | Wear Confidence | uint8 | 0–100 %; below 40 = likely not worn |
| 3 | Model Version | uint8 | Firmware ML model version for compatibility checks |
| 4 | System Flags | uint8 | Bit 0: IMU OK, Bit 1: BLE OK, Bit 2: Flash OK, Bit 3: Inference running, Bit 4: Threshold overridden by user, Bits 5–7: Reserved |
| 5–6 | Uptime | uint16 | Minutes since last power-on |
| 7 | Avg Anomaly Score (last 60s) | uint8 | Rolling average anomaly score — lets app track baseline drift |
| 8 | Inference Rate | uint8 | Actual inferences per second × 10 (nominal = 20 = 2 Hz) |
| 9 | Checksum | uint8 | XOR of bytes 0–8 |

**Total: 10 bytes**

---

### 8.3 Sensor Packet (Type = 0x03)

Contains raw or lightly-processed sensor data. Sent **only on demand** from the app (app writes a command byte to a control characteristic to start/stop streaming). Not sent by default — streaming at 100 Hz over BLE would saturate the link and drain the battery.

**Design rationale**: Used for the app's graph view, for collecting labeled training data from the field, and for live debug during development. Sent at a reduced rate (25 Hz) to stay within BLE bandwidth. The app subsamples or buffers as needed.

| Byte(s) | Field | Type | Unit | Description |
|---|---|---|---|---|
| 0 | Packet Type | uint8 | — | 0x03 |
| 1 | Sequence ID | uint8 | — | Rolling counter; app uses to detect dropped frames |
| 2–3 | Timestamp | uint16 | ms since boot (mod 65535) | Sample timestamp |
| 4–5 | Accel X | int16 | mg | Raw accelerometer X |
| 6–7 | Accel Y | int16 | mg | Raw accelerometer Y |
| 8–9 | Accel Z | int16 | mg | Raw accelerometer Z |
| 10–11 | Gyro X | int16 | 0.1 dps | Raw gyroscope X |
| 12–13 | Gyro Y | int16 | 0.1 dps | Raw gyroscope Y |
| 14–15 | Gyro Z | int16 | 0.1 dps | Raw gyroscope Z |
| 16–17 | Resultant Accel | uint16 | mg | sqrt(Ax²+Ay²+Az²) |
| 18–19 | Jerk | int16 | mg/s | d(ResultantA)/dt |
| 20 | Anomaly Score | uint8 | Scaled 0–255 | Current reconstruction error (for live graph overlay) |
| 21 | Checksum | uint8 | — | XOR of bytes 0–20 |

**Total: 22 bytes** — fits within default MTU. At 25 Hz, this is 550 bytes/sec, well within BLE 4.2 throughput.

---

### 8.4 Command Packet (App → Device, Type = 0x10)

The app can send commands back to the ESP32 via a writable GATT characteristic.

| Byte 0 (Command) | Action |
|---|---|
| 0x01 | Start sensor streaming (sends Sensor Packets) |
| 0x02 | Stop sensor streaming |
| 0x03 | Request immediate Status Packet |
| 0x04 | Acknowledge event (suppresses re-send timer) |
| 0x05 | Enter calibration mode (collect baseline for 10s) |
| 0x06 | Trigger test alert (QA / demo mode) |
| 0xFF | Emergency cancel (user confirmed safe) |

---

### 8.5 GATT Service Layout

```
Service UUID: 0xFE00  (SafeBand Primary Service)
  Characteristic 0xFE01 — Notify — Device → App   (Event, Status, Sensor packets)
  Characteristic 0xFE02 — Write  — App → Device   (Command packets)
  Characteristic 0xFE03 — Read   — Device info     (Device name, firmware version, serial)
```

---

## 9. Future Work: LSTM + Eigenvalue Hybrid

When migrating to the hybrid model, the feature vector fed to the LSTM should be the **concatenation of Tier 1 + Tier 2 features** per sub-window (e.g., 10 sub-windows of 20 samples each = 10 timesteps). Tier 3 eigenvalue features are added as **global context** concatenated into the bottleneck, not fed into the LSTM sequence. This respects their order-invariant nature while allowing the LSTM to model temporal evolution.

```
LSTM input:  (10 timesteps, 132 features) — Tier1 + Tier2 per sub-window
Bottleneck:  LSTM output (64-dim) || Eigenvalue features (12-dim) = 76-dim
Decoder:     Reconstructs the 10-timestep sequence from bottleneck
```
