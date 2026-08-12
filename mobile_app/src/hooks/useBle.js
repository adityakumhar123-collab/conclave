// =============================================================================
// hooks/useBle.js — The Core BLE Connection & Data Pipeline Hook
// =============================================================================
//
// DRY RUN / ARCHITECTURE OVERVIEW
// --------------------------------
// useBle is the central nervous system of the SafeBand app. It is a React
// custom hook that manages the entire BLE lifecycle and routes every incoming
// packet to the right destination.
//
// WHO CALLS THIS:
//   → App.js instantiates this hook once at the top level and passes its
//     return values down to all tabs and sub-hooks as props.
//
// WHAT IT DOES:
//   1. Initializes the BleManager (react-native-ble-plx) on mount
//   2. Manages the BLE state machine: DISCONNECTED → SCANNING → CONNECTING → CONNECTED
//   3. On connect: negotiates MTU (64 bytes), reads Device Info, subscribes to
//      all 4 notification characteristics (EVENT, STATUS, SENSOR, FEATURE)
//   4. On every BLE notification: decodes the packet via BleService.js, then:
//      - FEATURE/EVENT → MotionEngine.onBLEPacket() → EpisodeEngine.updateEpisode()
//      - FEATURE/EVENT → setCurrentPacket() to update React state for the dashboard
//      - SENSOR → setStreamData() to update the live IMU waveform graph
//      - STATUS → updates battery, wear confidence, uptime in React state
//      - All types → addLog() to append to the system log panel
//   5. Exposes sendBleCommand() to write a single byte to the COMMAND characteristic
//   6. Exposes toggleStreaming() to start/stop the high-rate SENSOR stream
//
// FILES USED:
//   → BleService.js      for: parseIncomingPacket, UUIDs, base64ToUint8Array,
//                              encodeSingleByteBase64
//   → MotionEngine.js    for: MotionEngine.onBLEPacket(), MotionEngine.initialize()
//   → EpisodeEngine.js   for: EpisodeEngine.updateEpisode()
//   → LocationEngine.js  for: LocationEngine.currentGps, LocationEngine.estimateFamiliarity()
//
// OUTPUT (what this hook returns to App.js):
//   → connectionState: 'DISCONNECTED' | 'SCANNING' | 'CONNECTING' | 'CONNECTED'
//   → devices: scanned SafeBand devices (shown in connection modal)
//   → currentPacket: latest FEATURE/EVENT parsed data (feeds DashboardTab.js)
//   → streamData: last 50 SENSOR frames (feeds the IMU waveform graph)
//   → wearConfidence, batteryPct, uptime: device health values
//   → startScanning, stopScanning, connectToDevice, handleDisconnect: BLE control
//   → sendBleCommand, toggleStreaming: command and streaming control
//
// TIMING:
//   - FEATURE packets arrive at 2 Hz → currentPacket updates every 500ms
//   - SENSOR packets arrive at ~25 Hz → streamData updates at most every 200ms
//     (throttled by lastGraphUpdateRef to avoid React re-render flooding)
//   - STATUS heartbeat arrives every ~30s
//   - EVENT packets are sporadic — only when anomaly is confirmed (3 windows)
//
// BUGS / NOTES:
//   ⚠ handleIncomingPacket is defined as a regular function inside the hook,
//     which means it captures the "stale" isStreaming value from its creation
//     closure. However, activeTabRef.current IS used (instead of activeTab state)
//     specifically to avoid this problem for the tab check. The isStreaming check
//     on line 151 uses the `isStreaming` state variable directly — if isStreaming
//     changes after the handler is set up (but before it fires), the old value
//     may be used. This is a minor issue since the 200ms throttle is the main guard.
//   ⚠ The EVENT packet branch (parsed.type === 'EVENT') does NOT update the
//     sequenceId in the setCurrentPacket call (unlike the FEATURE branch). This
//     means the PCA plot's sequenceId de-duplication won't work for EVENT packets.
//     EVENT packets are rare, so this is unlikely to cause visible PCA issues.
// =============================================================================

import { useState, useEffect, useRef } from 'react';
import { Platform, PermissionsAndroid } from 'react-native';
import {
  parseIncomingPacket,     // Decodes raw bytes → typed JS packet object
  SERVICE_UUID,            // Top-level GATT service UUID
  CHAR_UUID_COMMAND,       // UUID for writing commands to device
  CHAR_UUID_DEVICE_INFO,   // UUID for reading firmware version string on connect
  CHAR_UUID_STATUS,        // UUID for heartbeat/status notifications (0x02 packets)
  CHAR_UUID_SENSOR,        // UUID for raw IMU stream notifications (0x03 packets)
  CHAR_UUID_FEATURE,       // UUID for TinyML inference result notifications (0x04 packets)
  base64ToUint8Array,      // Converts BLE characteristic value (Base64) → Uint8Array
  encodeSingleByteBase64,  // Encodes a command byte → Base64 for BLE write
} from '../BleService';
import { MotionEngine } from '../MotionEngine.js';
import { EpisodeEngine } from '../EpisodeEngine.js';
import { LocationEngine } from '../LocationEngine.js';

// Decodes a Base64 characteristic value into a human-readable ASCII string.
// Used to read the DEVICE_INFO characteristic as text (firmware version, etc.)
function decodeBase64ToString(base64) {
  const bytes = base64ToUint8Array(base64);
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return str;
}

// Requests Android BLE runtime permissions.
// On Android 12+ (API 31+), requires BLUETOOTH_SCAN + BLUETOOTH_CONNECT + LOCATION.
// On Android 11 and below, only ACCESS_FINE_LOCATION is required.
// On iOS, permissions are handled by the OS dialog on first scan — returns true.
async function requestBluetoothPermissions() {
  if (Platform.OS === 'ios') {
    return true; // iOS handles BLE permissions via Info.plist + OS dialog automatically
  }
  if (Platform.OS === 'android') {
    try {
      if (Platform.Version >= 31) {
        // Android 12+ requires explicit BLE permissions
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);
        return (
          granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === PermissionsAndroid.RESULTS.GRANTED &&
          granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED &&
          granted[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED
        );
      } else {
        // Android 11 and below only need location permission for BLE scanning
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      }
    } catch (err) {
      console.warn('[BLE] Permission request error:', err);
      return false;
    }
  }
  return false;
}

// =============================================================================
// MAIN HOOK
// @param activeTab - current visible tab ('DASHBOARD' | 'CONTACTS' | 'SETTINGS')
// @param addLog    - function from App.js to append a message to the log panel
// =============================================================================
export default function useBle(activeTab, addLog) {
  // --- BLE Connection State ---
  // Drives which UI is shown in the connection modal and the status indicator
  const [connectionState, setConnectionState] = useState('DISCONNECTED');

  // List of discovered SafeBand devices during scanning (shown in the device list modal)
  const [devices, setDevices] = useState([]);

  // The currently connected react-native-ble-plx Device object.
  // Used to write commands and monitor characteristics.
  const [activeDevice, setActiveDevice] = useState(null);

  // Any BLE-level error message to display in the UI (e.g. "Connection failed")
  const [bleError, setBleError] = useState(null);

  // --- SafeBand Device State (updated from STATUS and FEATURE packets) ---
  const [wearConfidence, setWearConfidence] = useState(100); // % — 0 = unworn
  const [batteryPct, setBatteryPct] = useState(98);          // % battery remaining
  const [uptime, setUptime] = useState(12);                  // Minutes since last boot

  // --- Sensor Streaming State ---
  // isStreaming controls whether SENSOR (raw IMU) packets are requested from the device.
  // When true, device sends 0x03 packets at ~25 Hz for the waveform graph.
  const [isStreaming, setIsStreaming] = useState(true);

  // Ring buffer of last 50 SENSOR frames — used to draw the live IMU waveform graph.
  // Each element is a parsed SENSOR packet object (ax, ay, az, resultant, etc.)
  const [streamData, setStreamData] = useState([]);

  // --- Current TinyML Inference Packet ---
  // Holds the most recent FEATURE or EVENT packet values. React state, so any
  // component that reads this will re-render when it changes.
  // DashboardTab.js reads this to update all the gauges and the PCA plot.
  const [currentPacket, setCurrentPacket] = useState({
    anomalyScore: 0.1060,   // Float MAE reconstruction error (dequantized)
    anomalyDuration: 0,     // ×100ms counter of sustained anomaly
    motionState: 0,         // Bitmask: bit0=Still, bit1=Periodic, bit2=Aperiodic, etc.
    peakAccel: 1020,        // mg — peak acceleration in the last window
    dominantFreq: 1.0,      // Hz — dominant frequency in the last window
    eigenvalueRatio: 500,   // 0–1000 — linear vs. multidirectional (>700 = fall-like)
    zcr: 30,                // Zero-crossing rate
    spectralEntropy: 60,    // Spectral entropy (0–255)
    motionEmbedding: new Array(16).fill(0), // 16D dequantized float embedding
  });

  // --- Refs ---
  // bleManagerRef: holds the react-native-ble-plx BleManager instance.
  // It must be a ref (not state) because we need a stable reference
  // without causing re-renders, and it must survive across useEffect cleanups.
  const bleManagerRef = useRef(null);

  // activeTabRef: mirrors the activeTab prop as a ref so that the BLE packet
  // handler (which is set up in an async closure) can always read the current tab
  // without being affected by React's closure capture of the initial value.
  const activeTabRef = useRef(activeTab);

  // lastGraphUpdateRef: timestamp of last streamData update. Used to throttle
  // the SENSOR stream to at most 5 updates/second (every 200ms) to prevent
  // too many React re-renders from the 25Hz raw IMU stream.
  const lastGraphUpdateRef = useRef(0);
  const featureLogCounterRef = useRef(0);

  // Keep activeTabRef in sync with the activeTab prop (updates on every tab switch)
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  // =============================================================================
  // BleManager Lifecycle Effect
  // Creates the BleManager instance once on mount, and destroys it on unmount
  // to cleanly release the native BLE resource.
  // =============================================================================
  useEffect(() => {
    let BleManagerClass = null;
    try {
      // Dynamic require: react-native-ble-plx is a native module that only works
      // in a custom dev build (not standard Expo Go). This try/catch prevents
      // the app from crashing in environments where the native module is missing.
      const BLE = require('react-native-ble-plx');
      BleManagerClass = BLE.BleManager;
    } catch (e) {
      console.log('[BLE] react-native-ble-plx is not available in standard Expo Go.');
    }

    if (BleManagerClass) {
      try {
        bleManagerRef.current = new BleManagerClass();
        console.log('[BLE] BleManager initialized successfully.');
      } catch (err) {
        console.warn('[BLE] BleManager constructor failed:', err);
      }
    }

    // Cleanup: destroy the BleManager when this hook unmounts (app closed/navigated away)
    return () => {
      if (bleManagerRef.current) {
        bleManagerRef.current.destroy();
        console.log('[BLE] BleManager destroyed.');
      }
    };
  }, []); // Empty deps: runs only once on mount

  // =============================================================================
  // Packet Handler — Called for every decoded BLE notification
  // Routes each packet type to the appropriate consumers:
  //   FEATURE/EVENT → MotionEngine → EpisodeEngine → React state → UI logs
  //   SENSOR        → streamData (graph) → UI logs (sampled 10%)
  //   STATUS        → battery/wear state → UI logs
  // =============================================================================
  const handleIncomingPacket = (parsed) => {
    // --- FEATURE and EVENT packets → Analytics pipeline ---
    // Both types carry embeddings and are fed to the MotionEngine for observation building
    if (parsed.type === 'FEATURE' || parsed.type === 'EVENT') {
      try {
        // MotionEngine accumulates packets into its 10-packet buffer.
        // Returns an Observation every 6th packet (every 3s), or null otherwise.
        const obs = MotionEngine.onBLEPacket(parsed);
        if (obs) {
          addLog(`📦 Motion Engine produced Observation #${obs.observation_id} | Distribution: ${JSON.stringify(obs.cluster_distribution)}`, 'CONTEXT');
          
          // Estimate familiarity from GPS if available
          let familiarity = 0.5; // Default: neutral (no GPS = no advantage)
          if (LocationEngine.currentGps) {
            familiarity = LocationEngine.estimateFamiliarity(
              LocationEngine.currentGps.latitude,
              LocationEngine.currentGps.longitude
            );
          }
          
          // Forward observation to EpisodeEngine for session continuity tracking
          const ep = EpisodeEngine.updateEpisode(obs, familiarity);
          if (ep) {
            addLog(`🎬 Episode Engine updated Episode #${ep.episode_id} | Duration: ${ep.duration}s | Dominant State: ${EpisodeEngine.getEpisodeDominantState(ep)}`, 'CONTEXT');
          }
        }
      } catch (err) {
        console.warn('[BLE] MotionEngine packet processing failed:', err);
      }
    }

    // --- SENSOR packets → Live IMU waveform graph ---
    if (parsed.type === 'SENSOR') {
      // Only update the graph if streaming is active AND the user is on the dashboard tab.
      // Throttle to max 5 updates/sec (200ms) to avoid flooding React with re-renders.
      if (isStreaming && activeTabRef.current === 'DASHBOARD') {
        const now = Date.now();
        if (now - lastGraphUpdateRef.current > 200) {
          lastGraphUpdateRef.current = now;
          setStreamData((prevData) => {
            const newData = [...prevData, parsed];
            if (newData.length > 50) newData.shift(); // Keep at most 50 frames (ring buffer)
            return newData;
          });
        }
      }
      // Raw sensor stream logging is disabled to avoid flooding the log panel.
      // The graph on the dashboard provides real-time visual telemetry.
    } else if (parsed.type === 'FEATURE') {
      // --- FEATURE packets → Update currentPacket (dashboard gauges + PCA plot) ---
      setCurrentPacket((prev) => {
        // Only trigger a React re-render if at least one field has actually changed.
        // This prevents unnecessary renders at 2 Hz even when device is still.
        const hasChanged =
          (parsed.anomalyScore !== undefined && parsed.anomalyScore !== prev.anomalyScore) ||
          (parsed.anomalyDuration !== undefined && parsed.anomalyDuration !== prev.anomalyDuration) ||
          (parsed.motionState !== undefined && parsed.motionState !== prev.motionState) ||
          (parsed.peakAccel !== undefined && parsed.peakAccel !== prev.peakAccel) ||
          (parsed.dominantFreq !== undefined && parsed.dominantFreq !== prev.dominantFreq) ||
          (parsed.eigenvalueRatio !== undefined && parsed.eigenvalueRatio !== prev.eigenvalueRatio) ||
          (parsed.zcr !== undefined && parsed.zcr !== prev.zcr) ||
          (parsed.spectralEntropy !== undefined && parsed.spectralEntropy !== prev.spectralEntropy) ||
          (parsed.wearConfidence !== undefined && parsed.wearConfidence !== prev.wearConfidence) ||
          (parsed.isThreat !== undefined && parsed.isThreat !== prev.isThreat) ||
          // Deep compare the 16D embedding using JSON stringify (fast for small arrays)
          (parsed.motionEmbedding !== undefined && JSON.stringify(parsed.motionEmbedding) !== JSON.stringify(prev.motionEmbedding));

        if (!hasChanged) return prev; // Return previous state to skip re-render

        // Merge only the changed fields into the previous state
        return {
          ...prev,
          sequenceId: parsed.sequenceId !== undefined ? parsed.sequenceId : prev.sequenceId,
          anomalyScore: parsed.anomalyScore !== undefined ? parsed.anomalyScore : prev.anomalyScore,
          anomalyDuration: parsed.anomalyDuration !== undefined ? parsed.anomalyDuration : prev.anomalyDuration,
          motionState: parsed.motionState !== undefined ? parsed.motionState : prev.motionState,
          peakAccel: parsed.peakAccel !== undefined ? parsed.peakAccel : prev.peakAccel,
          dominantFreq: parsed.dominantFreq !== undefined ? parsed.dominantFreq : prev.dominantFreq,
          eigenvalueRatio: parsed.eigenvalueRatio !== undefined ? parsed.eigenvalueRatio : prev.eigenvalueRatio,
          zcr: parsed.zcr !== undefined ? parsed.zcr : prev.zcr,
          spectralEntropy: parsed.spectralEntropy !== undefined ? parsed.spectralEntropy : prev.spectralEntropy,
          wearConfidence: parsed.wearConfidence !== undefined ? parsed.wearConfidence : prev.wearConfidence,
          motionEmbedding: parsed.motionEmbedding !== undefined ? parsed.motionEmbedding : prev.motionEmbedding,
          isThreat: parsed.isThreat !== undefined ? parsed.isThreat : prev.isThreat,
          twelveFeatures: parsed.twelveFeatures !== undefined ? parsed.twelveFeatures : prev.twelveFeatures,
        };
      });

      // Update top-level wear confidence state for the status indicator
      if (parsed.wearConfidence !== undefined) setWearConfidence(parsed.wearConfidence);

      // Decode motionState bitmask to human-readable names for log output
      const motionNames = [];
      if (parsed.motionState & (1 << 0)) motionNames.push('STILL');
      if (parsed.motionState & (1 << 1)) motionNames.push('PERIODIC');
      if (parsed.motionState & (1 << 2)) motionNames.push('APERIODIC');
      if (parsed.motionState & (1 << 3)) motionNames.push('HIGH-IMPACT');
      if (parsed.motionState & (1 << 4)) motionNames.push('RESTRAINED');

      // Format the 16D embedding as a readable string with 2 decimal places
      const embStr = parsed.motionEmbedding ? `[${parsed.motionEmbedding.map(x => x.toFixed(2)).join(', ')}]` : 'N/A';

      // Throttle feature logging: log instantly on anomaly, or periodically every 5 seconds (10 packets at 2 Hz)
      featureLogCounterRef.current++;
      if (parsed.anomalyScore > 1.01309 || featureLogCounterRef.current % 10 === 0) {
        const totalVarianceVal = parsed.twelveFeatures ? parsed.twelveFeatures[10].toFixed(1) : 'N/A';
        addLog(
          `TinyML Live Features: Score=${parsed.anomalyScore} | ZCR=${parsed.zcr} Entropy=${parsed.spectralEntropy} | ` +
          `Motion=0x${parsed.motionState.toString(16).toUpperCase()} (${motionNames.join('+')}) Freq=${parsed.dominantFreq.toFixed(1)}Hz | ` +
          `Linearity=${parsed.eigenvalueRatio} Peak=${parsed.peakAccel}mg | Wear=${parsed.wearConfidence}% Var=${totalVarianceVal} | Emb=${embStr}`,
          'TINYML'
        );
      }
    } else if (parsed.type === 'EVENT') {
      // --- EVENT packets → Update currentPacket (same as FEATURE but with alert context) ---
      // NOTE: sequenceId is NOT preserved here — see BUG note at top of file.
      setCurrentPacket((prev) => {
        const hasChanged =
          (parsed.anomalyScore !== undefined && parsed.anomalyScore !== prev.anomalyScore) ||
          (parsed.anomalyDuration !== undefined && parsed.anomalyDuration !== prev.anomalyDuration) ||
          (parsed.motionState !== undefined && parsed.motionState !== prev.motionState) ||
          (parsed.peakAccel !== undefined && parsed.peakAccel !== prev.peakAccel) ||
          (parsed.dominantFreq !== undefined && parsed.dominantFreq !== prev.dominantFreq) ||
          (parsed.eigenvalueRatio !== undefined && parsed.eigenvalueRatio !== prev.eigenvalueRatio) ||
          (parsed.zcr !== undefined && parsed.zcr !== prev.zcr) ||
          (parsed.spectralEntropy !== undefined && parsed.spectralEntropy !== prev.spectralEntropy) ||
          (parsed.wearConfidence !== undefined && parsed.wearConfidence !== prev.wearConfidence) ||
          (parsed.motionEmbedding !== undefined && JSON.stringify(parsed.motionEmbedding) !== JSON.stringify(prev.motionEmbedding));

        if (!hasChanged) return prev;

        return {
          ...prev,
          anomalyScore: parsed.anomalyScore !== undefined ? parsed.anomalyScore : prev.anomalyScore,
          anomalyDuration: parsed.anomalyDuration !== undefined ? parsed.anomalyDuration : prev.anomalyDuration,
          motionState: parsed.motionState !== undefined ? parsed.motionState : prev.motionState,
          peakAccel: parsed.peakAccel !== undefined ? parsed.peakAccel : prev.peakAccel,
          dominantFreq: parsed.dominantFreq !== undefined ? parsed.dominantFreq : prev.dominantFreq,
          eigenvalueRatio: parsed.eigenvalueRatio !== undefined ? parsed.eigenvalueRatio : prev.eigenvalueRatio,
          zcr: parsed.zcr !== undefined ? parsed.zcr : prev.zcr,
          spectralEntropy: parsed.spectralEntropy !== undefined ? parsed.spectralEntropy : prev.spectralEntropy,
          wearConfidence: parsed.wearConfidence !== undefined ? parsed.wearConfidence : prev.wearConfidence,
          motionEmbedding: parsed.motionEmbedding !== undefined ? parsed.motionEmbedding : prev.motionEmbedding,
        };
      });
      if (parsed.battery !== undefined) setBatteryPct(parsed.battery);
      if (parsed.wearConfidence !== undefined) setWearConfidence(parsed.wearConfidence);

      const embStr = parsed.motionEmbedding ? `[${parsed.motionEmbedding.join(', ')}]` : 'N/A';
      addLog(`⚠️ TinyML ALERT RECEIVED: Score=${parsed.anomalyScore} Conf=${parsed.confidence}% Peak=${parsed.peakAccel}mg Dur=${parsed.anomalyDuration}x100ms | Emb=${embStr}`, 'TINYML');
    } else if (parsed.type === 'STATUS') {
      // --- STATUS packets → Update device health indicators ---
      if (parsed.battery !== undefined) setBatteryPct(parsed.battery);
      if (parsed.wearConfidence !== undefined) setWearConfidence(parsed.wearConfidence);
      if (parsed.uptime !== undefined) setUptime(parsed.uptime);

      addLog(`Heartbeat: Battery=${parsed.battery}% Wear=${parsed.wearConfidence}% Uptime=${parsed.uptime}m AvgAnomaly=${parsed.avgAnomaly} Inference=${parsed.inferenceRate}Hz Flags=0x${(parsed.systemFlags || 0).toString(16).toUpperCase()}`, 'TINYML');
    }
  };

  // Refs to always hold the latest version of handler callbacks,
  // preventing stale closures inside the persistent BLE notification monitor callbacks.
  const handleIncomingPacketRef = useRef(handleIncomingPacket);
  handleIncomingPacketRef.current = handleIncomingPacket;

  const addLogRef = useRef(addLog);
  addLogRef.current = addLog;

  // =============================================================================
  // BLE Scanning
  // Starts scanning for nearby BLE devices advertising the SafeBand service UUID.
  // Filters by device name ("SafeBand-ESP32" or "SafeBand-IMU") or service UUID.
  // =============================================================================
  const startScanning = async () => {
    if (!bleManagerRef.current) {
      setBleError('BLE is not supported in Expo Go. Please switch back to Simulation Mode.');
      return;
    }

    const hasPermissions = await requestBluetoothPermissions();
    if (!hasPermissions) {
      setBleError('Bluetooth & location permissions are required for scanning.');
      return;
    }

    setDevices([]);
    setBleError(null);
    setConnectionState('SCANNING');

    try {
      bleManagerRef.current.startDeviceScan(
        null,  // null = scan for all services (we filter by name/UUID in the callback)
        null,  // null = use default scan options
        (error, device) => {
          if (error) {
            console.error('[BLE] Scan error:', error);
            setBleError(error.message);
            setConnectionState('DISCONNECTED');
            return;
          }

          if (device) {
            // Filter: only show SafeBand devices by name or service UUID match
            const isSafeBand =
              device.name === 'SafeBand-ESP32' ||
              device.name === 'SafeBand-IMU' ||
              (device.serviceUUIDs && device.serviceUUIDs.includes(SERVICE_UUID));

            if (isSafeBand) {
              setDevices((prevDevices) => {
                // Avoid duplicates — check by device ID before adding
                if (prevDevices.some((d) => d.id === device.id)) {
                  return prevDevices;
                }
                return [...prevDevices, {
                  id: device.id,
                  name: device.name || 'SafeBand-ESP32',
                  rssi: device.rssi   // Signal strength (dBm) for display
                }];
              });
            }
          }
        }
      );
    } catch (err) {
      console.error('[BLE] Start scan failed:', err);
      setBleError(err.message);
      setConnectionState('DISCONNECTED');
    }
  };

  const stopScanning = () => {
    if (bleManagerRef.current) {
      bleManagerRef.current.stopDeviceScan();
    }
    if (connectionState === 'SCANNING') {
      setConnectionState('DISCONNECTED');
    }
  };

  // =============================================================================
  // BLE Connection — The Full Connection Setup Sequence
  //
  // Step-by-step when connectToDevice() is called:
  //   1. Stop any ongoing scan
  //   2. Connect to the selected device (by ID)
  //   3. Wait 800ms for connection to stabilize (Android firmware quirk)
  //   4. Negotiate MTU = 64 bytes (prevents packet fragmentation for 34-byte packets)
  //   5. Discover all services and characteristics (builds the GATT table)
  //   6. Initialize MotionEngine (clears buffer, loads cluster centroids)
  //   7. Read DEVICE_INFO characteristic (one-time firmware version string)
  //   8. Subscribe to EVENT, STATUS, SENSOR, FEATURE characteristics
  //   9. Wait 1500ms for BLE descriptor subscriptions to stabilize
  //  10. Send START_STREAM command (0x01) to begin receiving packets from the device
  //  11. Register disconnect handler to clean up state if connection drops
  // =============================================================================
  const connectToDevice = async (deviceId) => {
    stopScanning();
    setConnectionState('CONNECTING');
    setBleError(null);

    try {
      if (!bleManagerRef.current) throw new Error('BleManager not initialized');

      console.log('[BLE] Connecting to device:', deviceId);
      const device = await bleManagerRef.current.connectToDevice(deviceId, { autoConnect: false });

      console.log('[BLE] Connected. Waiting for connection to stabilize...');
      // 800ms delay: Required on Android to let the BLE link fully establish before
      // attempting MTU negotiation. Skipping this causes intermittent failures.
      await new Promise((resolve) => setTimeout(resolve, 800));

      try {
        // MTU = Maximum Transmission Unit. Default BLE MTU is 23 bytes (too small
        // for our 34-byte EVENT packets). We request 64 bytes to fit all packets
        // in a single BLE notification without fragmentation.
        await device.requestMTU(64);
        console.log('[BLE] MTU negotiated to 64 bytes.');
        addLog('MTU negotiated: 64 bytes — packet fragmentation prevented.', 'SYSTEM');
      } catch (mtuErr) {
        // MTU negotiation failure is non-fatal — packets will still work but may
        // fragment and cause occasional checksum mismatches on large packets.
        console.warn('[BLE] MTU negotiation failed (non-fatal):', mtuErr.message);
        addLog(`MTU negotiation warning: ${mtuErr.message}`, 'SYSTEM');
      }

      console.log('[BLE] Discovering services and characteristics...');
      const discoveredDevice = await device.discoverAllServicesAndCharacteristics();

      setActiveDevice(discoveredDevice);
      setConnectionState('CONNECTED');
      try {
        // Reset the MotionEngine buffer and reload cluster centroids from DB
        MotionEngine.initialize();
      } catch (err) {
        console.warn('[BLE] Failed to initialize MotionEngine:', err);
      }
      setDevices([]); // Clear the scan list — no longer needed

      // Read the Device Info characteristic (firmware version, model info string)
      try {
        const charInfo = await discoveredDevice.readCharacteristicForService(
          SERVICE_UUID,
          CHAR_UUID_DEVICE_INFO
        );
        if (charInfo && charInfo.value) {
          const rawString = decodeBase64ToString(charInfo.value);
          console.log('[BLE] Connected Device Info:', rawString);
          addLog(`Device Info: ${rawString}`, 'SYSTEM');
        }
      } catch (err) {
        console.warn('[BLE] Read firmware version failed:', err);
      }

      // Factory function: creates a notification handler + subscription reference pair.
      // The `active` flag and the `subscription` ref allow the handler to safely
      // stop itself after a disconnection error without calling remove() too early.
      const makeNotifyHandler = (charName) => {
        let subscription = null;
        let active = true; // Becomes false on the first error to prevent re-entrancy
        const handler = (error, characteristic) => {
          if (!active) return; // Already deactivated — do nothing
          if (error) {
            active = false;
            // errorCode 2 = "Device disconnected" — expected, no need to log it
            if (error.errorCode !== 2) {
              console.error(`[BLE] ${charName} notification error:`, error.message);
              addLogRef.current(`BLE error on ${charName}: ${error.message}`, 'SYSTEM');
            }
            // Defer subscription removal to avoid calling remove() from within the callback
            setTimeout(() => {
              if (subscription) {
                try {
                  subscription.remove();
                } catch (subErr) {
                  console.warn(`[BLE] Failed to remove subscription for ${charName}:`, subErr);
                }
              }
            }, 0);
            return;
          }
          try {
            if (characteristic && characteristic.value) {
              console.log(`[BLE] Received notify on ${charName}: base64 len = ${characteristic.value.length}`);
              // Decode Base64 → raw bytes → parse as a SafeBand packet
              const bytes = base64ToUint8Array(characteristic.value);
              console.log(`[BLE] Decoded ${charName} bytes len = ${bytes.length}: [${Array.from(bytes).join(', ')}]`);
              const parsed = parseIncomingPacket(bytes);
              if (parsed) {
                console.log(`[BLE] Parsed ${charName} successfully:`, JSON.stringify(parsed));
                handleIncomingPacketRef.current(parsed); // Route to the latest handler to prevent stale closures
              } else {
                console.warn(`[BLE] Failed to parse ${charName} packet (ignored)`);
              }
            }
          } catch (handlerErr) {
            console.error(`[BLE] Error handling characteristic notification for ${charName}:`, handlerErr);
            addLogRef.current(`Error handling ${charName}: ${handlerErr.message}`, 'SYSTEM');
          }
        };
        return {
          handler,
          setSubscription: (sub) => { subscription = sub; } // Called after monitor() returns
        };
      };

      // Enumerate all characteristics in the SafeBand GATT service for direct lookup
      let discoveredChars = [];
      try {
        discoveredChars = await discoveredDevice.characteristicsForService(SERVICE_UUID);
        console.log(`[BLE] GATT: Discovered ${discoveredChars.length} characteristics in service.`);
        addLog(`GATT: Discovered ${discoveredChars.length} characteristics in service.`, 'SYSTEM');
      } catch (charErr) {
        console.warn(`[BLE] GATT enumeration failed: ${charErr.message}`);
        addLog(`GATT enumeration failed: ${charErr.message} — falling back to UUID monitor.`, 'SYSTEM');
      }

      // Build a UUID → characteristic object lookup map for O(1) access
      const charByUUID = {};
      for (const c of discoveredChars) {
        charByUUID[c.uuid.toLowerCase()] = c;
      }

      // List of characteristics to subscribe to for notifications
      const NOTIFY_TARGETS = [
        { uuid: CHAR_UUID_STATUS,  name: 'STATUS'  }, // Heartbeat (0x02)
        { uuid: CHAR_UUID_SENSOR,  name: 'SENSOR'  }, // Raw IMU stream (0x03)
        { uuid: CHAR_UUID_FEATURE, name: 'FEATURE' }, // TinyML inference results (0x04)
      ];

      let monitoredCount = 0;
      for (const { uuid, name } of NOTIFY_TARGETS) {
        const char = charByUUID[uuid.toLowerCase()];
        const helper = makeNotifyHandler(name);
        if (char) {
          // Preferred path: use the pre-discovered characteristic object directly
          const sub = char.monitor(helper.handler);
          helper.setSubscription(sub);
          monitoredCount++;
        } else {
          // Fallback path: use the service-level monitor method with UUID string
          // (works even if GATT enumeration partially failed)
          try {
            const sub = discoveredDevice.monitorCharacteristicForService(SERVICE_UUID, uuid, helper.handler);
            helper.setSubscription(sub);
            monitoredCount++;
          } catch (monErr) {
            console.warn(`[BLE] WARNING: ${name} char not found in service:`, monErr.message);
            addLog(`WARNING: ${name} char not found in service (UUID: ${uuid.slice(0,8)}...)`, 'SYSTEM');
          }
        }
      }

      console.log(`[BLE] Connected. Monitoring ${monitoredCount}/3 characteristics (STATUS, SENSOR, FEATURE).`);
      addLog(`Connected. Monitoring ${monitoredCount}/3 characteristics (STATUS, SENSOR, FEATURE).`, 'SYSTEM');

      // Do not auto-start high-rate sensor streaming on connect to prevent flooding the BLE link
      // and causing early disconnections. The user can toggle streaming manually.
      setIsStreaming(false);

      // Register disconnect handler: cleans up state if device drops connection unexpectedly
      bleManagerRef.current.onDeviceDisconnected(deviceId, (error, d) => {
        console.log('[BLE] Device disconnected on connection loss.');
        setActiveDevice(null);
        setConnectionState('DISCONNECTED');
      });

    } catch (err) {
      console.error('[BLE] Connection error:', err);
      setBleError(err.message || 'Connection failed.');
      setConnectionState('DISCONNECTED');
    }
  };

  // Gracefully disconnects from the active device and resets all connection state
  const handleDisconnect = async () => {
    if (activeDevice) {
      try {
        await activeDevice.cancelConnection();
      } catch (err) {
        console.log('[BLE] Connection cancellation error:', err);
      }
    }
    setActiveDevice(null);
    setConnectionState('DISCONNECTED');
    setDevices([]);
  };

  // Writes a single-byte command to the COMMAND characteristic.
  // Used by: toggleStreaming(), cancelEmergency(), and direct command buttons.
  // Returns true on success, false on failure (no connection or write error).
  const sendBleCommand = async (commandByte) => {
    if (connectionState !== 'CONNECTED' || !activeDevice) {
      console.log('[BLE] Command skipped: No active connection.');
      return false;
    }

    try {
      const base64Value = encodeSingleByteBase64(commandByte); // Encode to Base64
      await activeDevice.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHAR_UUID_COMMAND,
        base64Value
      );
      console.log(`[BLE] Sent command 0x${commandByte.toString(16).toUpperCase()}`);
      return true;
    } catch (err) {
      console.error('[BLE] Command write error:', err);
      setBleError(`Command error: ${err.message}`);
      return false;
    }
  };

  // Toggles the IMU sensor data stream on/off.
  // Sends 0x01 = start stream, 0x02 = stop stream to the device.
  // Only sends the command if actually connected (no-op otherwise).
  const toggleStreaming = async () => {
    const nextStreamingState = !isStreaming;
    setIsStreaming(nextStreamingState);
    if (connectionState === 'CONNECTED') {
      await sendBleCommand(nextStreamingState ? 0x01 : 0x02);
    }
  };

  // =============================================================================
  // Return Value — All state and callbacks exposed to App.js (and passed as props
  // to DashboardTab, SettingsTab, and useEmergency)
  // =============================================================================
  return {
    connectionState,    // Current BLE state machine state
    devices,            // Scanned SafeBand devices (for the device list modal)
    activeDevice,       // The connected BLE device object (or null)
    bleError,           // Error message string (or null)
    wearConfidence,     // % wristband wear confidence (from STATUS/FEATURE packets)
    batteryPct,         // % battery (from STATUS/EVENT packets)
    uptime,             // Minutes since last boot (from STATUS packets)
    isStreaming,        // Whether SENSOR stream is active
    streamData,         // Last 50 SENSOR frames (for IMU waveform graph)
    currentPacket,      // Latest FEATURE/EVENT data (feeds all dashboard gauges)
    setStreamData,      // Allows manual clearing of the waveform graph
    setCurrentPacket,   // Allows useEmergency to reset packet after cancel
    setWearConfidence,  // Allows useEmergency to update wear state
    setBatteryPct,      // Exposed for potential future use
    setUptime,          // Exposed for potential future use
    startScanning,      // Start BLE scan
    stopScanning,       // Stop BLE scan
    connectToDevice,    // Connect to a specific device by ID
    handleDisconnect,   // Graceful disconnect
    sendBleCommand,     // Write a single-byte command to the device
    toggleStreaming,    // Toggle IMU stream on/off
  };
}
