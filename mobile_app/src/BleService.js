// BLE Service to parse incoming binary data packet payloads and simulate telemetry streams.

// BLE Specification UUIDs (lowercase for react-native-ble-plx matching)
export const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
export const CHAR_UUID_EVENT = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
export const CHAR_UUID_COMMAND = "c083bcf3-4c9b-44c0-9943-228ae92e8fa4";
export const CHAR_UUID_DEVICE_INFO = "d2b781e9-4e78-43e9-92c1-d2a84e92a2a0";
export const CHAR_UUID_STATUS = "8f1f7e34-bb52-4467-b5cc-fb5a8e03e5c9";
export const CHAR_UUID_SENSOR = "c9298492-95b6-455f-8c3a-bb5a8e03e5ca";
export const CHAR_UUID_FEATURE = "e2e0a294-814d-45db-9c3f-bb5a8e03e5cb";


// Pure JS Base64 to Uint8Array decoder
export function base64ToUint8Array(base64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) {
    lookup[chars.charCodeAt(i)] = i;
  }
  
  let bufferLength = base64.length * 0.75;
  if (base64[base64.length - 1] === '=') {
    bufferLength--;
    if (base64[base64.length - 2] === '=') {
      bufferLength--;
    }
  }
  
  const arrayBuffer = new ArrayBuffer(bufferLength);
  const bytes = new Uint8Array(arrayBuffer);
  
  let p = 0;
  for (let i = 0; i < base64.length; i += 4) {
    const encoded1 = lookup[base64.charCodeAt(i)];
    const encoded2 = lookup[base64.charCodeAt(i + 1)];
    const encoded3 = lookup[base64.charCodeAt(i + 2)];
    const encoded4 = lookup[base64.charCodeAt(i + 3)];
    
    bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
    if (p < bufferLength) {
      bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
    }
    if (p < bufferLength) {
      bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
    }
  }
  return bytes;
}

// Helper to encode a single byte command value into a Base64 string for BLE writes
export function encodeSingleByteBase64(byte) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const b = byte & 0xFF;
  const c1 = b >> 2;
  const c2 = (b & 3) << 4;
  return chars[c1] + chars[c2] + '==';
}

export function parseIncomingPacket(bytes) {
  if (!bytes || bytes.length < 2) return null;
  const type = bytes[0];

  // Validate XOR checksum (last byte of the packet)
  const receivedChecksum = bytes[bytes.length - 1];
  let calculatedChecksum = 0;
  for (let i = 0; i < bytes.length - 1; i++) {
    calculatedChecksum ^= bytes[i];
  }

  if (calculatedChecksum !== receivedChecksum) {
    console.warn('[BLE] Checksum mismatch — dropping packet');
    return null;
  }

  switch (type) {
    case 0x01: // Event Packet (18 bytes)
      return parseEventPacket(bytes);
    case 0x02: // Status Packet (10 bytes)
      return parseStatusPacket(bytes);
    case 0x03: // Sensor Packet (22 bytes)
      return parseSensorPacket(bytes);
    case 0x04: // Feature Packet (16 bytes)
      return parseFeaturePacket(bytes);
    default:
      return null;
  }
}

function dequantizeEmbedding(slice) {
  const scale = 0.01250550;
  const zeroPoint = -80;
  return Array.from(slice).map(x => {
    const int8Val = x > 127 ? x - 256 : x;
    return (int8Val - zeroPoint) * scale;
  });
}

function parseFeaturePacket(bytes) {
  if (bytes.length < 32) return null;

  const eigenvalueRatio = bytes[7] | (bytes[8] << 8);
  const peakAccel = bytes[10] | (bytes[11] << 8);
  const anomalyDuration = bytes[12] | (bytes[13] << 8);
  const motionEmbedding = dequantizeEmbedding(bytes.slice(14, 30));

  return {
    type: 'FEATURE',
    sequenceId: bytes[1],
    anomalyScore: bytes[2],
    motionState: bytes[3],
    dominantFreq: bytes[4] * 0.5, // Hz
    zcr: bytes[5],
    spectralEntropy: bytes[6],
    eigenvalueRatio,
    wearConfidence: bytes[9],
    peakAccel, // mg
    anomalyDuration, // units of 100ms
    motionEmbedding,
  };
}

function parseEventPacket(bytes) {
  if (bytes.length < 34) return null;
  
  // Bytes 2-3: Timestamp (uint16 little endian)
  const timestamp = bytes[2] | (bytes[3] << 8);
  // Bytes 8-9: Peak Accel (uint16 little endian)
  const peakAccel = bytes[8] | (bytes[9] << 8);
  // Bytes 13-14: Eigenvalue ratio (uint16 little-endian, scaled x1000)
  const eigenvalueRatio = bytes[13] | (bytes[14] << 8);
  const motionEmbedding = dequantizeEmbedding(bytes.slice(17, 33));

  return {
    type: 'EVENT',
    sequenceId: bytes[1],
    timestamp,
    anomalyScore: bytes[4],       // 0 - 255
    confidence: bytes[5],         // 0 - 100
    motionState: bytes[6],        // Bitmask
    anomalyDuration: bytes[7],    // ×100ms units
    peakAccel,                    // mg
    dominantFreq: bytes[10] * 0.5,// Hz
    zcr: bytes[11],               // 0 - 255
    spectralEntropy: bytes[12],   // 0 - 255
    eigenvalueRatio,              // 0 - 1000
    battery: bytes[15],           // %
    wearConfidence: bytes[16],    // %
    motionEmbedding,
  };
}

function parseStatusPacket(bytes) {
  if (bytes.length < 10) return null;

  // Bytes 5-6: Uptime minutes (uint16 little-endian)
  const uptime = bytes[5] | (bytes[6] << 8);

  return {
    type: 'STATUS',
    battery: bytes[1],
    wearConfidence: bytes[2],
    modelVersion: bytes[3],
    systemFlags: bytes[4],
    uptime,
    avgAnomaly: bytes[7],
    inferenceRate: bytes[8] * 0.1, // Hz
  };
}

function parseSensorPacket(bytes) {
  if (bytes.length < 22) return null;

  const timestamp = bytes[2] | (bytes[3] << 8);
  
  // Helper for reading signed 16-bit ints
  const readInt16 = (b1, b2) => {
    const val = b1 | (b2 << 8);
    return val > 32767 ? val - 65536 : val;
  };

  const ax = readInt16(bytes[4], bytes[5]);
  const ay = readInt16(bytes[6], bytes[7]);
  const az = readInt16(bytes[8], bytes[9]);
  
  const gx = readInt16(bytes[10], bytes[11]);
  const gy = readInt16(bytes[12], bytes[13]);
  const gz = readInt16(bytes[14], bytes[15]);

  const resultant = bytes[16] | (bytes[17] << 8);
  const jerk = readInt16(bytes[18], bytes[19]);

  return {
    type: 'SENSOR',
    sequenceId: bytes[1],
    timestamp,
    ax, ay, az,                  // mg
    gx, gy, gz,                  // dps x 10
    resultant,                   // mg
    jerk,                        // mg/s
    anomalyScore: bytes[20],     // 0 - 255
  };
}

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
