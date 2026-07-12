// =============================================================================
// BleService.js — BLE Packet Parser & Protocol Definitions
// =============================================================================
//
// DRY RUN / ARCHITECTURE OVERVIEW
// --------------------------------
// This file is the lowest-level "protocol decoder" of the BLE stack. It has
// NO React state and NO side-effects — it is a pure utility module.
//
// WHO USES THIS FILE:
//   → useBle.js (hook) imports all UUIDs, base64 helpers, and parseIncomingPacket()
//     to decode every raw BLE notification that arrives from the ESP32 firmware.
//
// OUTPUT (what this file produces):
//   → Parsed JS objects with named fields (anomalyScore, motionEmbedding, etc.)
//     that are consumed by useBle.js, then forwarded to the dashboard UI and
//     the MotionEngine/EpisodeEngine/ContextEngine analytics pipeline.
//
// DATA FLOW WITHIN THIS FILE:
//   ESP32 BLE notification (raw bytes, Base64-encoded)
//     ↓  base64ToUint8Array()         — decode to raw Uint8Array
//     ↓  parseIncomingPacket()        — read packet type byte, validate XOR checksum
//     ↓  parseFeaturePacket()         — OR parseEventPacket(), parseSensorPacket(), etc.
//     ↓  dequantizeEmbedding()        — int8 → float for motion embedding
//   Returns → typed JS object ({type, anomalyScore, motionEmbedding, ...})
//
// BLE PACKET TYPES (all sent from the firmware):
//   0x01 → EVENT:   Fired when an anomaly threshold is crossed (alert trigger)
//   0x02 → STATUS:  Heartbeat every ~30s (battery, wear confidence, uptime)
//   0x03 → SENSOR:  High-rate raw IMU streaming (25 Hz when streaming is ON)
//   0x04 → FEATURE: Low-rate inference result every 500ms (2 Hz) — main data feed
//
// BUGS / NOTES:
//   ⚠ generateMockPacket() is currently commented out with /* ... */. This was
//     the simulation / testing helper. It can be re-enabled for local UI testing
//     without a physical ESP32 board connected.
//   ⚠ The anomaly score in the FEATURE packet is decoded as:
//       bytes[2] * 0.00441764  (NOT divided by 255 like in SENSOR packet)
//     This is because the firmware serializes the int8 dequantized value directly
//     using the model's output quantization scale. The SENSOR packet uses a simpler
//     raw 0-255 encoding. Both paths are intentional.
// =============================================================================


// =============================================================================
// SECTION 1: BLE Service & Characteristic UUIDs
// These are fixed 128-bit UUIDs that both the ESP32 firmware and this phone app
// must agree on. The firmware registers these UUIDs in GATT, and useBle.js
// uses them to subscribe to (monitor) each characteristic for incoming packets.
// =============================================================================

// The top-level GATT service UUID — acts as a "namespace" for all SafeBand characteristics.
export const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";

// Emergency event packet (0x01) — only fires when anomaly threshold is breached.
export const CHAR_UUID_EVENT = "beb5483e-36e1-4688-b7f5-ea07361b26a8";

// Command write channel (WRITE with response) — phone sends commands to ESP32.
// Currently used commands: 0x01 = start streaming, 0x02 = stop streaming,
//                          0xFF = cancel alert, 0x04 = acknowledge alert.
export const CHAR_UUID_COMMAND = "c083bcf3-4c9b-44c0-9943-228ae92e8fa4";

// Read-once string characteristic sent on connection (firmware version, model info, etc.)
export const CHAR_UUID_DEVICE_INFO = "d2b781e9-4e78-43e9-92c1-d2a84e92a2a0";

// Periodic heartbeat packet (0x02) — battery %, wear confidence, uptime, avg anomaly.
export const CHAR_UUID_STATUS = "8f1f7e34-bb52-4467-b5cc-fb5a8e03e5c9";

// High-rate raw IMU stream (0x03) — 25 Hz, ax/ay/az/gx/gy/gz, resultant, jerk.
export const CHAR_UUID_SENSOR = "c9298492-95b6-455f-8c3a-bb5a8e03e5ca";

// Low-rate TinyML inference result (0x04) — 2 Hz, anomaly score + 16D embedding.
// This is the PRIMARY data feed for the dashboard, MotionEngine, and PCA plot.
export const CHAR_UUID_FEATURE = "e2e0a294-814d-45db-9c3f-bb5a8e03e5cb";


// =============================================================================
// SECTION 2: Base64 Utility Helpers
// react-native-ble-plx returns characteristic values encoded as Base64 strings.
// We need to decode them to raw byte arrays to parse the binary packet format.
// These are pure-JS implementations to avoid native module dependencies.
// =============================================================================

// Decodes a Base64 string → Uint8Array of raw bytes.
// Used to decode every incoming BLE notification value before parsing.
export function base64ToUint8Array(base64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  // Build a fast lookup table: ASCII char code → 6-bit Base64 index
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) {
    lookup[chars.charCodeAt(i)] = i;
  }
  
  // Calculate the output buffer size, accounting for '=' padding characters
  // Every 4 Base64 characters encode exactly 3 bytes
  let bufferLength = base64.length * 0.75;
  if (base64[base64.length - 1] === '=') {
    bufferLength--; // One trailing '=' means one fewer byte
    if (base64[base64.length - 2] === '=') {
      bufferLength--; // Two trailing '==' means two fewer bytes
    }
  }
  
  const arrayBuffer = new ArrayBuffer(bufferLength);
  const bytes = new Uint8Array(arrayBuffer);
  
  let p = 0; // Output byte index
  for (let i = 0; i < base64.length; i += 4) {
    // Each group of 4 Base64 characters → 3 output bytes
    const encoded1 = lookup[base64.charCodeAt(i)];
    const encoded2 = lookup[base64.charCodeAt(i + 1)];
    const encoded3 = lookup[base64.charCodeAt(i + 2)];
    const encoded4 = lookup[base64.charCodeAt(i + 3)];
    
    // Reconstruct bytes via bit operations:
    bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);      // Byte 1
    if (p < bufferLength) {
      bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2); // Byte 2
    }
    if (p < bufferLength) {
      bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);  // Byte 3
    }
  }
  return bytes;
}

// Encodes a single byte value (0x00–0xFF) as a Base64 string.
// Used to encode single-byte commands before writing them to CHAR_UUID_COMMAND.
// Example: encodeSingleByteBase64(0x01) → "AQ=="
export function encodeSingleByteBase64(byte) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const b = byte & 0xFF;         // Mask to ensure it's a valid byte
  const c1 = b >> 2;             // Top 6 bits
  const c2 = (b & 3) << 4;      // Bottom 2 bits, shifted up
  return chars[c1] + chars[c2] + '=='; // Always 2 trailing '=' for a 1-byte payload
}


// =============================================================================
// SECTION 3: Packet Entry Point — Dispatcher
// This is the function called by useBle.js for every raw BLE notification.
// It validates the XOR checksum, reads the first byte to determine packet type,
// then dispatches to the appropriate parser function below.
// =============================================================================

export function parseIncomingPacket(bytes) {
  if (!bytes || bytes.length < 2) return null;
  const type = bytes[0]; // First byte is always the packet type identifier

  // Validate XOR checksum — the firmware XORs all payload bytes and appends
  // the result as the LAST byte. If this doesn't match, the packet was corrupted
  // in transit and must be discarded silently.
  const receivedChecksum = bytes[bytes.length - 1];
  let calculatedChecksum = 0;
  for (let i = 0; i < bytes.length - 1; i++) {
    calculatedChecksum ^= bytes[i];
  }

  if (calculatedChecksum !== receivedChecksum) {
    console.warn('[BLE] Checksum mismatch — dropping packet');
    return null; // Discard corrupt packet
  }

  // Route to the correct parser based on the packet type byte
  switch (type) {
    case 0x01: // Emergency EVENT packet — anomaly threshold was crossed on-device
      return parseEventPacket(bytes);
    case 0x02: // STATUS heartbeat packet — periodic health snapshot
      return parseStatusPacket(bytes);
    case 0x03: // SENSOR raw IMU frame — high-rate waveform streaming
      return parseSensorPacket(bytes);
    case 0x04: // FEATURE TinyML result — 2 Hz inference output (main feed)
      return parseFeaturePacket(bytes);
    default:
      return null; // Unknown type — ignore silently
  }
}


// =============================================================================
// SECTION 4: Quantization Helper — int8 → float for Motion Embeddings
//
// The TinyML model outputs a 16-dimensional motion embedding as int8 bytes.
// To recover the actual float values the model computed internally, we apply
// the dequantization formula:
//   float = (int8_value - zero_point) * scale
//
// Parameters from the 20-epoch model calibration (integration_guidelines.md):
//   scale      = 0.01699736
//   zero_point = -93
//
// This function is called by both parseFeaturePacket and parseEventPacket.
// =============================================================================
function dequantizeEmbedding(slice) {
  const scale = 0.01699736;
  const zeroPoint = -93;
  return Array.from(slice).map(x => {
    // BLE delivers bytes as uint8 (0–255). Re-interpret as int8 (-128 to 127).
    const int8Val = x > 127 ? x - 256 : x;
    return (int8Val - zeroPoint) * scale;
  });
}


// =============================================================================
// SECTION 5: FEATURE Packet Parser (type = 0x04)
//
// The most important packet. Sent at 2 Hz (every 500ms) after each TinyML
// inference completes. Contains:
//   - The anomaly/reconstruction error score (dequantized float)
//   - Motion state bitmask (Still / Periodic / Aperiodic / High-Impact / Restrained)
//   - Signal features (dominant frequency, ZCR, spectral entropy, eigenvalue ratio)
//   - Wear confidence (is the wristband actually worn?)
//   - Peak acceleration of the window (mg units)
//   - Anomaly duration counter (how many consecutive anomalous windows)
//   - The full 16-dimensional motion embedding (16 int8 bytes → 16 floats)
//
// Byte Layout (minimum 32 bytes + 1 checksum = 33 total):
//   [0]     = 0x04 (type)
//   [1]     = sequenceId (uint8, wraps 0–255)
//   [2]     = anomaly score (int8 raw, multiply by scale 0.00441764 to get float)
//   [3]     = motionState (bitmask: bit0=Still, bit1=Periodic, bit2=Aperiodic,
//                          bit3=HighImpact, bit4=Restrained)
//   [4]     = dominantFreq encoded (multiply by 0.5 to get Hz)
//   [5]     = ZCR (zero-crossing rate, 0–255)
//   [6]     = spectralEntropy (0–255)
//   [7:8]   = eigenvalueRatio (uint16 LE, 0–1000, where >700 = highly linear = fall)
//   [9]     = wearConfidence (0–100%)
//   [10:11] = peakAccel (uint16 LE, milligravity units)
//   [12:13] = anomalyDuration (uint16 LE, units of 100ms, e.g. 15 = 1.5 seconds)
//   [14:29] = motionEmbedding (16 int8 bytes → dequantized to 16 floats)
//   [last]  = XOR checksum
// =============================================================================
function parseFeaturePacket(bytes) {
  if (bytes.length < 32) return null;

  // Reconstruct 16-bit little-endian values from two consecutive bytes
  const eigenvalueRatio = bytes[7] | (bytes[8] << 8);
  const peakAccel = bytes[10] | (bytes[11] << 8);
  const anomalyDuration = bytes[12] | (bytes[13] << 8);

  // Bytes 14–29 are the 16 int8 embedding values from the model output
  const motionEmbedding = dequantizeEmbedding(bytes.slice(14, 30));

  return {
    type: 'FEATURE',
    sequenceId: bytes[1],
    anomalyScore: bytes[2] * 0.00441764,    // Dequantized reconstruction error (MAE)
    motionState: bytes[3],                   // Raw bitmask — see bit definitions above
    dominantFreq: bytes[4] * 0.5,           // Hz (encoded as 2× to use single byte)
    zcr: bytes[5],                           // Zero-crossing rate (0–255 raw)
    spectralEntropy: bytes[6],               // Spectral entropy (0–255 raw)
    eigenvalueRatio,                         // >700 suggests linear/directional fall
    wearConfidence: bytes[9],               // 0 = unworn, 100 = definitely worn
    peakAccel,                               // mg units — 1000 ≈ 1g (gravity)
    anomalyDuration,                         // ×100ms — how long anomaly has lasted
    motionEmbedding,                         // 16D float vector for PCA / clustering
  };
}


// =============================================================================
// SECTION 6: EVENT Packet Parser (type = 0x01)
//
// Fired ONCE by the firmware after 3 consecutive anomalous windows (1.5s of
// sustained anomaly). This is the hardware-level alert trigger that initiates
// the emergency pre-alert countdown on the phone (useEmergency.js).
//
// Contains the same feature data as FEATURE packets, plus:
//   - timestamp (seconds since device boot, uint16)
//   - confidence (0–100% — model confidence in the event classification)
//   - battery (% at the time of the event)
//
// Byte Layout (minimum 34 bytes + 1 checksum):
//   [0]     = 0x01 (type)
//   [1]     = sequenceId
//   [2:3]   = timestamp (uint16 LE, seconds since boot)
//   [4]     = anomaly score (int8 × 0.00441764)
//   [5]     = confidence (0–100%)
//   [6]     = motionState bitmask
//   [7]     = anomalyDuration (×100ms)
//   [8:9]   = peakAccel (uint16 LE, mg)
//   [10]    = dominantFreq encoded (×0.5 for Hz)
//   [11]    = ZCR
//   [12]    = spectralEntropy
//   [13:14] = eigenvalueRatio (uint16 LE)
//   [15]    = battery (0–100%)
//   [16]    = wearConfidence (0–100%)
//   [17:32] = motionEmbedding (16 int8 bytes)
//   [last]  = XOR checksum
// =============================================================================
function parseEventPacket(bytes) {
  if (bytes.length < 34) return null;
  
  // Reconstruct multi-byte fields from little-endian pairs
  const timestamp = bytes[2] | (bytes[3] << 8);
  const peakAccel = bytes[8] | (bytes[9] << 8);
  const eigenvalueRatio = bytes[13] | (bytes[14] << 8);
  const motionEmbedding = dequantizeEmbedding(bytes.slice(17, 33));

  return {
    type: 'EVENT',
    sequenceId: bytes[1],
    timestamp,                                          // Seconds since device boot
    anomalyScore: bytes[4] * 0.00441764,              // Model-scale dequantized MAE
    confidence: bytes[5],                              // 0–100%
    motionState: bytes[6],                             // Motion bitmask
    anomalyDuration: bytes[7],                         // ×100ms
    peakAccel,                                         // mg
    dominantFreq: bytes[10] * 0.5,                    // Hz
    zcr: bytes[11],
    spectralEntropy: bytes[12],
    eigenvalueRatio,                                   // Linear vs. multidirectional
    battery: bytes[15],                                // % at time of event
    wearConfidence: bytes[16],
    motionEmbedding,                                   // 16D dequantized floats
  };
}


// =============================================================================
// SECTION 7: STATUS Packet Parser (type = 0x02)
//
// A periodic heartbeat sent roughly every 30 seconds when idle.
// Used to keep the phone's battery and wear indicators up to date even when
// no motion anomalies are occurring.
//
// Byte Layout (minimum 10 bytes + 1 checksum):
//   [0]   = 0x02 (type)
//   [1]   = battery (0–100%)
//   [2]   = wearConfidence (0–100%)
//   [3]   = modelVersion (firmware model version code, e.g. 0x10 = v1.6)
//   [4]   = systemFlags (bitmask: bit0=IMU OK, bit1=Model OK, bit2=BLE OK, etc.)
//   [5:6] = uptime (uint16 LE, minutes since last boot)
//   [7]   = avgAnomaly raw (multiply by 0.00441764 to get float avg MAE)
//   [8]   = inferenceRate (multiply by 0.1 to get Hz, e.g. 20 → 2.0 Hz)
//   [last]= XOR checksum
// =============================================================================
function parseStatusPacket(bytes) {
  if (bytes.length < 10) return null;

  const uptime = bytes[5] | (bytes[6] << 8); // Minutes since last boot

  return {
    type: 'STATUS',
    battery: bytes[1],
    wearConfidence: bytes[2],
    modelVersion: bytes[3],                        // e.g. 0x10 = firmware v1.6
    systemFlags: bytes[4],                         // Health bitmask
    uptime,                                        // Minutes
    avgAnomaly: bytes[7] * 0.00441764,            // Rolling average MAE (float)
    inferenceRate: bytes[8] * 0.1,                // Hz (e.g. 20 → 2.0 Hz)
  };
}


// =============================================================================
// SECTION 8: SENSOR Packet Parser (type = 0x03)
//
// Raw 6-axis IMU data sent at ~25 Hz when streaming is enabled (via 0x01 command).
// Used to draw the live waveform graph on the Dashboard tab.
// NOT used for TinyML inference — that uses the pre-processed FEATURE packets.
//
// Byte Layout (minimum 22 bytes + 1 checksum):
//   [0]     = 0x03 (type)
//   [1]     = sequenceId
//   [2:3]   = timestamp (uint16 LE)
//   [4:5]   = ax (int16 LE, mg)
//   [6:7]   = ay (int16 LE, mg)
//   [8:9]   = az (int16 LE, mg)
//   [10:11] = gx (int16 LE, dps × 10)
//   [12:13] = gy (int16 LE, dps × 10)
//   [14:15] = gz (int16 LE, dps × 10)
//   [16:17] = resultant magnitude (uint16 LE, mg = sqrt(ax²+ay²+az²))
//   [18:19] = jerk (int16 LE, mg/s)
//   [20]    = anomalyScore raw (uint8, raw 0–255 value — NOT model-scaled)
//   [last]  = XOR checksum
// =============================================================================
function parseSensorPacket(bytes) {
  if (bytes.length < 22) return null;

  const timestamp = bytes[2] | (bytes[3] << 8);
  
  // Helper: read two consecutive bytes as a signed int16 (little-endian).
  // BLE delivers unsigned bytes, so values > 32767 are negative in int16 space.
  const readInt16 = (b1, b2) => {
    const val = b1 | (b2 << 8);
    return val > 32767 ? val - 65536 : val;
  };

  const ax = readInt16(bytes[4], bytes[5]);  // Accel X axis (mg)
  const ay = readInt16(bytes[6], bytes[7]);  // Accel Y axis (mg)
  const az = readInt16(bytes[8], bytes[9]);  // Accel Z axis (mg)
  
  const gx = readInt16(bytes[10], bytes[11]); // Gyro X (dps × 10)
  const gy = readInt16(bytes[12], bytes[13]); // Gyro Y (dps × 10)
  const gz = readInt16(bytes[14], bytes[15]); // Gyro Z (dps × 10)

  const resultant = bytes[16] | (bytes[17] << 8); // sqrt(ax²+ay²+az²) in mg
  const jerk = readInt16(bytes[18], bytes[19]);    // Rate of change of accel (mg/s)

  return {
    type: 'SENSOR',
    sequenceId: bytes[1],
    timestamp,
    ax, ay, az,             // mg units
    gx, gy, gz,             // dps × 10 units
    resultant,              // mg — total acceleration magnitude
    jerk,                   // mg/s — rate of change (useful for impact detection)
    anomalyScore: bytes[20], // Raw 0–255 (NOT dequantized — used only for graph color)
  };
}


// =============================================================================
// SECTION 9: Mock Packet Generator (CURRENTLY COMMENTED OUT)
//
// This block was used during development to simulate different incident types
// (FALL, STRUGGLE, SEIZURE, NORMAL, SENSOR, FEATURE) without a physical device.
// It generates valid binary packets with proper XOR checksums.
//
// TO RE-ENABLE FOR TESTING: Remove the /* and */ delimiters around this block.
//
// NOTE: buildPacket() is a local helper inside this commented block.
// =============================================================================
/*
// Helper to pack values into a Uint8Array with an XOR checksum at the end
function buildPacket(bytesList) {
  const bytes = new Uint8Array(bytesList.length + 1);
  let checksum = 0;
  for (let i = 0; i < bytesList.length; i++) {
    bytes[i] = bytesList[i] & 0xFF;
    checksum ^= bytes[i];
  }
  bytes[bytes.length - 1] = checksum;
  return bytes;
}

// Generator for Simulated Telemetry packets based on actual user actions
export function generateMockPacket(type, params = {}) {
  const seq = params.seq || 0;
  const ts = Math.floor((params.time || Date.now()) / 1000) & 0xFFFF;
  
  if (type === 'STATUS') {
    const battery = params.battery !== undefined ? params.battery : 98;
    const wearConfidence = params.wearConfidence !== undefined ? params.wearConfidence : 100;
    const avgAnomaly = params.avgAnomaly !== undefined ? params.avgAnomaly : 24;
    return buildPacket([
      0x02,                 // Type
      battery,              // Battery
      wearConfidence,       // Wear confidence
      0x10,                 // Model version 1.6
      0x0F,                 // System flags (all systems OK)
      ts & 0xFF, (ts >> 8) & 0xFF, // Uptime (mins)
      avgAnomaly,           // Avg Anomaly
      20,                   // 2.0 Hz inference rate
    ]);
  }

  if (type === 'FALL') {
    // High anomaly, high-impact flag (Bit 3), linear ratio (850)
    const anomalyScore = 195; // > 128 (threshold)
    const motionState = 1 << 3; // High-Impact
    const peakAccel = 3500; // 3.5g impact
    const duration = 25; // 2.5 seconds
    const eigenvalueRatio = 850; // high = linear fall

    return buildPacket([
      0x01,                 // Type
      seq,                  // Sequence ID
      ts & 0xFF, (ts >> 8) & 0xFF, // Timestamp seconds
      anomalyScore,         // Anomaly Score
      80,                   // Confidence
      motionState,          // Motion state mask
      duration,             // Anomaly Duration
      peakAccel & 0xFF, (peakAccel >> 8) & 0xFF,
      4,                    // Dominant Freq: 2 Hz (encoded as 4)
      42,                   // ZCR
      75,                   // Spectral Entropy
      eigenvalueRatio & 0xFF, (eigenvalueRatio >> 8) & 0xFF,
      98,                   // Battery
      100,                  // Wear confidence
    ]);
  }

  if (type === 'STRUGGLE') {
    // High anomaly, aperiodic flag (Bit 2), low eigenvalue ratio (220 = multidirectional)
    const anomalyScore = 175;
    const motionState = 1 << 2; // Aperiodic
    const peakAccel = 1800; // 1.8g
    const duration = 90; // 9 seconds
    const eigenvalueRatio = 220; // low = multidirectional struggle

    return buildPacket([
      0x01,
      seq,
      ts & 0xFF, (ts >> 8) & 0xFF,
      anomalyScore,
      90,
      motionState,
      duration,
      peakAccel & 0xFF, (peakAccel >> 8) & 0xFF,
      8,                    // Dominant Freq: 4 Hz
      185,                  // High ZCR
      210,                  // High Entropy
      eigenvalueRatio & 0xFF, (eigenvalueRatio >> 8) & 0xFF,
      98,
      100,
    ]);
  }

  if (type === 'SEIZURE') {
    // Rhythmic oscillation, periodic flag (Bit 1), low entropy (55)
    const anomalyScore = 165;
    const motionState = 1 << 1; // Periodic
    const peakAccel = 1200; // 1.2g
    const duration = 150; // 15 seconds
    const eigenvalueRatio = 450;

    return buildPacket([
      0x01,
      seq,
      ts & 0xFF, (ts >> 8) & 0xFF,
      anomalyScore,
      95,
      motionState,
      duration,
      peakAccel & 0xFF, (peakAccel >> 8) & 0xFF,
      6,                    // Dominant Freq: 3 Hz (6 x 0.5)
      140,
      55,                   // Low entropy = highly periodic
      eigenvalueRatio & 0xFF, (eigenvalueRatio >> 8) & 0xFF,
      98,
      100,
    ]);
  }

  if (type === 'NORMAL') {
    // Normal motion event (should not trigger alert)
    const anomalyScore = 65; // < 128
    const motionState = 1 << 1; // Periodic walking
    const peakAccel = 1100;
    const duration = 5;
    const eigenvalueRatio = 500;

    return buildPacket([
      0x01,
      seq,
      ts & 0xFF, (ts >> 8) & 0xFF,
      anomalyScore,
      10,
      motionState,
      duration,
      peakAccel & 0xFF, (peakAccel >> 8) & 0xFF,
      3,                    // Dominant Freq: 1.5 Hz
      60,
      110,
      eigenvalueRatio & 0xFF, (eigenvalueRatio >> 8) & 0xFF,
      98,
      100,
    ]);
  }

  if (type === 'SENSOR') {
    // Generates a mock real-time sensor frame (25 Hz stream)
    const noise = () => Math.floor((Math.random() - 0.5) * 120);
    const ax = params.ax !== undefined ? params.ax : noise();
    const ay = params.ay !== undefined ? params.ay : 1000 + noise(); // gravity on Z
    const az = params.az !== undefined ? params.az : noise();
    
    const resultant = Math.floor(Math.sqrt(ax*ax + ay*ay + az*az));
    const jerk = noise();
    const score = params.anomalyScore !== undefined ? params.anomalyScore : 35;

    return buildPacket([
      0x03,
      seq,
      ts & 0xFF, (ts >> 8) & 0xFF,
      ax & 0xFF, (ax >> 8) & 0xFF,
      ay & 0xFF, (ay >> 8) & 0xFF,
      az & 0xFF, (az >> 8) & 0xFF,
      0, 0, 0, 0, 0, 0,    // Gyros = 0
      resultant & 0xFF, (resultant >> 8) & 0xFF,
      jerk & 0xFF, (jerk >> 8) & 0xFF,
      score,
    ]);
  }

  if (type === 'FEATURE') {
    const score = params.anomalyScore !== undefined ? params.anomalyScore : 24;
    const wearConfidence = params.wearConfidence !== undefined ? params.wearConfidence : 100;
    const motionState = params.motionState !== undefined ? params.motionState : (1 << 1); // Periodic walking default
    const dominantFreq = params.dominantFreq !== undefined ? params.dominantFreq : 1.5;
    const zcr = params.zcr !== undefined ? params.zcr : 45;
    const entropy = params.spectralEntropy !== undefined ? params.spectralEntropy : 70;
    const eigenvalueRatio = params.eigenvalueRatio !== undefined ? params.eigenvalueRatio : 520;
    const peakAccel = params.peakAccel !== undefined ? params.peakAccel : 1020;
    const duration = params.anomalyDuration !== undefined ? params.anomalyDuration : 0;

    const freqEncoded = Math.floor(dominantFreq * 2.0) & 0xFF;

    return buildPacket([
      0x04,                 // Type
      seq,                  // Sequence ID
      score,                // Anomaly Score
      motionState,          // Motion state mask
      freqEncoded,          // Dominant Freq (scaled x2)
      zcr,                  // ZCR
      entropy,              // Spectral Entropy
      eigenvalueRatio & 0xFF, (eigenvalueRatio >> 8) & 0xFF,
      wearConfidence,
      peakAccel & 0xFF, (peakAccel >> 8) & 0xFF,
      duration & 0xFF, (duration >> 8) & 0xFF,
      0,                    // Reserved
    ]);
  }

  return null;
}
*/
