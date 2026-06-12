import React, { useState, useEffect, useRef } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  Modal,
  Dimensions,
  Vibration,
  ActivityIndicator,
  FlatList,
  Platform,
  PermissionsAndroid,
} from 'react-native';
import Svg, { Path, Rect, Circle, Line } from 'react-native-svg';

import {
  parseIncomingPacket,
  generateMockPacket,
  SERVICE_UUID,
  CHAR_UUID_EVENT,
  CHAR_UUID_COMMAND,
  CHAR_UUID_DEVICE_INFO,
  CHAR_UUID_STATUS,
  CHAR_UUID_SENSOR,
  CHAR_UUID_FEATURE,
  base64ToUint8Array,
  encodeSingleByteBase64,
} from './src/BleService';
import { computeThreatScoreDetailed, getThreatLevel } from './src/ContextEngine';

const { width } = Dimensions.get('window');

// Android runtime BLE permission request utility
async function requestBluetoothPermissions() {
  if (Platform.OS === 'ios') {
    return true;
  }
  if (Platform.OS === 'android') {
    try {
      if (Platform.Version >= 31) {
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

// Helper to decode Base64 characteristics value into a raw string
function decodeBase64ToString(base64) {
  const bytes = base64ToUint8Array(base64);
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return str;
}

export default function App() {
  // SafeBand Connection Modes: 'SIMULATION' or 'REAL'
  const [bleMode, setBleMode] = useState('SIMULATION');
  const [connectionState, setConnectionState] = useState('SIMULATING'); // 'DISCONNECTED', 'SCANNING', 'CONNECTING', 'CONNECTED', 'SIMULATING'
  const [devices, setDevices] = useState([]);
  const [activeDevice, setActiveDevice] = useState(null);
  const [bleError, setBleError] = useState(null);

  // SafeBand device state
  const [wearConfidence, setWearConfidence] = useState(100);
  const [batteryPct, setBatteryPct] = useState(98);
  const [uptime, setUptime] = useState(12);

  // Environmental context settings (user-modifiable for testing multipliers)
  const [location, setLocation] = useState('UNKNOWN_URBAN'); // 'HOME', 'UNKNOWN_URBAN', 'UNKNOWN_ISOLATED'
  const [timeOfDay, setTimeOfDay] = useState('MORNING'); // 'MORNING', 'NIGHT_RISK', 'LATE_NIGHT', 'DAYTIME'
  const [postAnomalyStillness, setPostAnomalyStillness] = useState(false);

  // Anomaly score & threat engine state
  const [currentPacket, setCurrentPacket] = useState({
    anomalyScore: 24,
    anomalyDuration: 0,
    motionState: 0,
    peakAccel: 1020,
    dominantFreq: 1.0,
    eigenvalueRatio: 500,
    zcr: 30,
    spectralEntropy: 60,
  });
  const [threatScore, setThreatScore] = useState(0.05);
  const [cooldownActive, setCooldownActive] = useState(false);
  const [cooldownTime, setCooldownTime] = useState(0);

  // Active calibration state
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibrationProgress, setCalibrationProgress] = useState(0);

  // Emergency Overlay State
  const [showAlertModal, setShowAlertModal] = useState(false);
  const [alertCountdown, setAlertCountdown] = useState(15);
  const [isDispatched, setIsDispatched] = useState(false);
  const [beepingFlash, setBeepingFlash] = useState(false);

  // Real-time sensor streaming data (for graph)
  const [isStreaming, setIsStreaming] = useState(true);
  const [streamData, setStreamData] = useState([]); // Holds last 50 points of accel x, y, z & anomaly score
  const [streamSeq, setStreamSeq] = useState(0);

  // Diagnostics Terminal log state
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(true); // Default open to show diagnostics
  const [logFilter, setLogFilter] = useState('CONTEXT'); // 'ALL', 'TINYML', 'CONTEXT', 'SYSTEM'

  // References
  const bleManagerRef = useRef(null);
  const streamIntervalRef = useRef(null);
  const statusIntervalRef = useRef(null);
  const featureSimIntervalRef = useRef(null);
  const alertIntervalRef = useRef(null);
  const decayTimeoutRef = useRef(null);

  // Synchronization refs for interval simulation to prevent restarts on state changes
  const currentPacketRef = useRef(currentPacket);
  const wearConfidenceRef = useRef(wearConfidence);
  const batteryPctRef = useRef(batteryPct);
  const threatScoreRef = useRef(threatScore);
  const streamSeqRef = useRef(streamSeq);

  // Keep refs synchronized with state synchronously during render to prevent effect cascades
  currentPacketRef.current = currentPacket;
  wearConfidenceRef.current = wearConfidence;
  batteryPctRef.current = batteryPct;
  threatScoreRef.current = threatScore;
  streamSeqRef.current = streamSeq;


  // Log appending helper
  const addLog = (message, category = 'SYSTEM') => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => {
      const newLog = { id: Math.random().toString(), time, message, category };
      return [newLog, ...prev].slice(0, 250); // Keep last 250 logs
    });
  };

  // Packet Handler Utility
  const handleIncomingPacket = (parsed) => {
    if (parsed.type === 'SENSOR') {
      setStreamData((prevData) => {
        const newData = [...prevData, parsed];
        if (newData.length > 50) newData.shift();
        return newData;
      });
      // Wire SENSOR anomalyScore into currentPacket so threat engine reacts to real motion in real-time.
      // Only update if the score has actually changed, preventing redundant 25 Hz re-renders.
      if (parsed.anomalyScore !== undefined) {
        setCurrentPacket((prev) => {
          if (prev.anomalyScore === parsed.anomalyScore) {
            return prev;
          }
          return { ...prev, anomalyScore: parsed.anomalyScore };
        });
      }
      // Throttle sensor logs internally to prevent console freeze (only print if filter is RAW or TINYML specifically)
      if (Math.random() < 0.10) { // Stream log sample rate
        addLog(`Sensor stream: res=${parsed.resultant}mg, jerk=${parsed.jerk}mg/s, anomaly=${parsed.anomalyScore}`, 'TINYML');
      }
    } else if (parsed.type === 'FEATURE') {
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
          (parsed.wearConfidence !== undefined && parsed.wearConfidence !== prev.wearConfidence);

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
        };
      });
      if (parsed.wearConfidence !== undefined) setWearConfidence(parsed.wearConfidence);

      const motionNames = [];
      if (parsed.motionState & (1 << 0)) motionNames.push('STILL');
      if (parsed.motionState & (1 << 1)) motionNames.push('PERIODIC');
      if (parsed.motionState & (1 << 2)) motionNames.push('APERIODIC');
      if (parsed.motionState & (1 << 3)) motionNames.push('HIGH-IMPACT');
      if (parsed.motionState & (1 << 4)) motionNames.push('RESTRAINED');

      addLog(
        `TinyML Live Features: Score=${parsed.anomalyScore} | ZCR=${parsed.zcr} Entropy=${parsed.spectralEntropy} | ` +
        `Motion=0x${parsed.motionState.toString(16).toUpperCase()} (${motionNames.join('+')}) Freq=${parsed.dominantFreq.toFixed(1)}Hz | ` +
        `Linearity=${parsed.eigenvalueRatio} Peak=${parsed.peakAccel}mg | Wear=${parsed.wearConfidence}%`,
        'TINYML'
      );
    } else if (parsed.type === 'EVENT') {
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
          (parsed.wearConfidence !== undefined && parsed.wearConfidence !== prev.wearConfidence);

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
        };
      });
      if (parsed.battery !== undefined) setBatteryPct(parsed.battery);
      if (parsed.wearConfidence !== undefined) setWearConfidence(parsed.wearConfidence);

      addLog(`⚠️ TinyML ALERT RECEIVED: Score=${parsed.anomalyScore} Conf=${parsed.confidence}% Peak=${parsed.peakAccel}mg Dur=${parsed.anomalyDuration}x100ms`, 'TINYML');
    } else if (parsed.type === 'STATUS') {
      if (parsed.battery !== undefined) setBatteryPct(parsed.battery);
      // Only update the standalone wearConfidence state — do NOT call setCurrentPacket here.
      // Mutating currentPacket from STATUS handler creates a circular dependency:
      // currentPacket change → threat useEffect → setThreatScore → status sim interval restarts → loop.
      // The wearConfidence state is merged into the packet inside the threat useEffect instead.
      if (parsed.wearConfidence !== undefined) setWearConfidence(parsed.wearConfidence);
      if (parsed.uptime !== undefined) setUptime(parsed.uptime);

      addLog(`Heartbeat: Battery=${parsed.battery}% Wear=${parsed.wearConfidence}% Uptime=${parsed.uptime}m AvgAnomaly=${parsed.avgAnomaly} Inference=${parsed.inferenceRate}Hz`, 'TINYML');
    }
  };

  // 0. BleManager Lifecycle management
  useEffect(() => {
    let BleManagerClass = null;
    try {
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

    return () => {
      if (bleManagerRef.current) {
        bleManagerRef.current.destroy();
        console.log('[BLE] BleManager destroyed.');
      }
    };
  }, []);

  // 1. Live Sensor Streaming simulation (25 Hz - ONLY runs in SIMULATION mode)
  useEffect(() => {
    if (bleMode === 'SIMULATION' && isStreaming && connectionState === 'SIMULATING') {
      streamIntervalRef.current = setInterval(() => {
        setStreamSeq((prev) => {
          const nextSeq = (prev + 1) & 0xFF;
          
          // Generate mock raw sensor data matching the current packet's severity
          let mockAx = Math.floor((Math.random() - 0.5) * 120);
          let mockAy = 1000 + Math.floor((Math.random() - 0.5) * 120);
          let mockAz = Math.floor((Math.random() - 0.5) * 120);

          if (currentPacketRef.current.anomalyScore > 128) {
            // Add massive chaotic motion if active anomaly simulation is running
            mockAx += Math.floor((Math.random() - 0.5) * 2000);
            mockAy += Math.floor((Math.random() - 0.5) * 2000);
            mockAz += Math.floor((Math.random() - 0.5) * 2000);
          }

          const rawBytes = generateMockPacket('SENSOR', {
            seq: nextSeq,
            ax: mockAx,
            ay: mockAy,
            az: mockAz,
            anomalyScore: currentPacketRef.current.anomalyScore,
          });

          const parsed = parseIncomingPacket(rawBytes);
          if (parsed) {
            // Under simulation, SENSOR packets feed the graph
            setStreamData((prevData) => {
              const newData = [...prevData, parsed];
              if (newData.length > 50) newData.shift();
              return newData;
            });
          }
          return nextSeq;
        });
      }, 40); // 25 Hz = 40ms
    } else {
      clearInterval(streamIntervalRef.current);
    }
    return () => clearInterval(streamIntervalRef.current);
  }, [isStreaming, connectionState, bleMode]);

  // 2. Slow Heartbeat Status simulation (Every 5 seconds - ONLY runs in SIMULATION mode)
  useEffect(() => {
    if (bleMode === 'SIMULATION' && connectionState === 'SIMULATING') {
      statusIntervalRef.current = setInterval(() => {
        const rawBytes = generateMockPacket('STATUS', {
          battery: batteryPctRef.current,
          wearConfidence: wearConfidenceRef.current,
          avgAnomaly: Math.floor(threatScoreRef.current * 255),
        });
        const parsed = parseIncomingPacket(rawBytes);
        if (parsed) {
          setUptime(parsed.uptime);
          // Apply wear status from parsed status packet
          setWearConfidence(parsed.wearConfidence);
          handleIncomingPacket(parsed);
        }
      }, 5000);
    } else {
      clearInterval(statusIntervalRef.current);
    }
    return () => clearInterval(statusIntervalRef.current);
  }, [connectionState, bleMode]);

  // 2b. TinyML Live 2 Hz Feature simulation (ONLY runs in SIMULATION mode)
  useEffect(() => {
    if (bleMode === 'SIMULATION' && connectionState === 'SIMULATING') {
      featureSimIntervalRef.current = setInterval(() => {
        const rawBytes = generateMockPacket('FEATURE', {
          seq: streamSeqRef.current,
          anomalyScore: currentPacketRef.current.anomalyScore,
          wearConfidence: wearConfidenceRef.current,
          motionState: currentPacketRef.current.motionState,
          dominantFreq: currentPacketRef.current.dominantFreq,
          zcr: currentPacketRef.current.zcr,
          spectralEntropy: currentPacketRef.current.spectralEntropy,
          eigenvalueRatio: currentPacketRef.current.eigenvalueRatio,
          peakAccel: currentPacketRef.current.peakAccel,
          anomalyDuration: currentPacketRef.current.anomalyDuration,
        });
        const parsed = parseIncomingPacket(rawBytes);
        if (parsed) {
          handleIncomingPacket(parsed);
        }
      }, 500); // 2 Hz
    } else {
      clearInterval(featureSimIntervalRef.current);
    }
    return () => clearInterval(featureSimIntervalRef.current);
  }, [connectionState, bleMode]);

  // last logged threat score ref — used to throttle context log spam
  const lastLoggedScoreRef = useRef(-1);

  // 3. Recalculate threat score when packet or context variables change
  useEffect(() => {
    // Merge standalone wearConfidence state into packet for ContextEngine.
    // This avoids calling setCurrentPacket from STATUS handler (which causes infinite loops)
    // while still giving the engine the correct wear suppression value.
    const packetForEngine = { ...currentPacket, wearConfidence };

    const { score, explanation } = computeThreatScoreDetailed(packetForEngine, {
      location,
      timeOfDay,
      postAnomalyStillness,
    });

    let finalScore = score;
    if (cooldownActive) {
      finalScore *= 0.6; // Reduced sensitivity cooldown
    }

    setThreatScore(finalScore);

    // Throttle context logs: only emit when score changes by >2% to avoid flooding the terminal.
    const scoreDelta = Math.abs(finalScore - lastLoggedScoreRef.current);
    if (scoreDelta >= 0.02 || lastLoggedScoreRef.current < 0) {
      lastLoggedScoreRef.current = finalScore;
      if (explanation && explanation.length > 0) {
        explanation.forEach(msg => addLog(msg, 'CONTEXT'));
        addLog(`▶ Final threat: ${Math.round(finalScore * 100)}% (TinyML raw: ${currentPacket.anomalyScore}/255)`, 'CONTEXT');
        addLog('─────────────────────────────────────────', 'CONTEXT');
      }
    }

    // Trigger Emergency sequences if threat level crossed
    if (finalScore >= 0.72 && !showAlertModal && !isDispatched) {
      addLog(`🚨 EMERGENCY THREAT DETECTED: Score ${Math.round(finalScore * 100)}% >= 72%. Triggering countdown.`, 'SYSTEM');
      triggerEmergencyPreAlert();
    }
  }, [currentPacket, wearConfidence, location, timeOfDay, postAnomalyStillness, cooldownActive]);

  // 4. BLE Bluetooth Manager logic
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
        null, 
        null, 
        (error, device) => {
          if (error) {
            console.error('[BLE] Scan error:', error);
            setBleError(error.message);
            setConnectionState('DISCONNECTED');
            return;
          }

          if (device) {
            const isSafeBand = 
              device.name === 'SafeBand-ESP32' || 
              device.name === 'SafeBand-IMU' ||
              (device.serviceUUIDs && device.serviceUUIDs.includes(SERVICE_UUID));

            if (isSafeBand) {
              setDevices((prevDevices) => {
                if (prevDevices.some((d) => d.id === device.id)) {
                  return prevDevices;
                }
                return [...prevDevices, {
                  id: device.id,
                  name: device.name || 'SafeBand-ESP32',
                  rssi: device.rssi
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

  const connectToDevice = async (deviceId) => {
    stopScanning();
    setConnectionState('CONNECTING');
    setBleError(null);

    try {
      if (!bleManagerRef.current) throw new Error('BleManager not initialized');
      
      console.log('[BLE] Connecting to device:', deviceId);
      const device = await bleManagerRef.current.connectToDevice(deviceId, { autoConnect: false });
      
      console.log('[BLE] Connected. Waiting for connection to stabilize...');
      await new Promise((resolve) => setTimeout(resolve, 800));

      // Negotiate a larger MTU before service discovery.
      // Default ATT payload is only 20 bytes; the SENSOR packet is 22 bytes,
      // which causes BLE fragmentation and corrupts the XOR checksum.
      try {
        await device.requestMTU(64);
        console.log('[BLE] MTU negotiated to 64 bytes.');
        addLog('MTU negotiated: 64 bytes — packet fragmentation prevented.', 'SYSTEM');
      } catch (mtuErr) {
        // Non-fatal: iOS manages MTU automatically; some Android versions may ignore this.
        console.warn('[BLE] MTU negotiation failed (non-fatal):', mtuErr.message);
        addLog(`MTU negotiation warning: ${mtuErr.message}`, 'SYSTEM');
      }

      console.log('[BLE] Discovering services and characteristics...');
      const discoveredDevice = await device.discoverAllServicesAndCharacteristics();
      
      setActiveDevice(discoveredDevice);
      setConnectionState('CONNECTED');
      setDevices([]);

      // Read device info for logging
      try {
        const charInfo = await discoveredDevice.readCharacteristicForService(
          SERVICE_UUID,
          CHAR_UUID_DEVICE_INFO
        );
        if (charInfo && charInfo.value) {
          const rawString = decodeBase64ToString(charInfo.value);
          console.log('[BLE] Connected Device Info:', rawString);
        }
      } catch (err) {
        console.warn('[BLE] Read firmware version failed:', err);
      }

      // Auto start streaming on connection
      const startStreamBase64 = encodeSingleByteBase64(0x01);
      await discoveredDevice.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHAR_UUID_COMMAND,
        startStreamBase64
      );
      setIsStreaming(true);

      // Notification handler factory — no RAW hex logging (was flooding terminal)
      const makeNotifyHandler = (charName) => {
        let subscription = null;
        let active = true;
        const handler = (error, characteristic) => {
          if (!active) return;
          if (error) {
            active = false;
            if (error.errorCode !== 2) { // Ignore tear-down errors on disconnect
              console.error(`[BLE] ${charName} notification error:`, error.message);
              addLog(`BLE error on ${charName}: ${error.message}`, 'SYSTEM');
            }
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
          if (characteristic && characteristic.value) {
            const bytes = base64ToUint8Array(characteristic.value);
            const parsed = parseIncomingPacket(bytes);
            if (parsed) handleIncomingPacket(parsed);
          }
        };
        return {
          handler,
          setSubscription: (sub) => { subscription = sub; }
        };
      };

      // Enumerate characteristics directly from the discovered service.
      // Using .monitor() on the characteristic OBJECT (not UUID string lookup) bypasses
      // the Android GATT cache UUID resolution bug that caused FEATURE "not found" errors.
      let discoveredChars = [];
      try {
        discoveredChars = await discoveredDevice.characteristicsForService(SERVICE_UUID);
        addLog(`GATT: Discovered ${discoveredChars.length} characteristics in service.`, 'SYSTEM');
      } catch (charErr) {
        addLog(`GATT enumeration failed: ${charErr.message} — falling back to UUID monitor.`, 'SYSTEM');
      }

      // Build a UUID → characteristic object map
      const charByUUID = {};
      for (const c of discoveredChars) {
        charByUUID[c.uuid.toLowerCase()] = c;
      }

      // Subscribe to each notify characteristic by object reference
      const NOTIFY_TARGETS = [
        { uuid: CHAR_UUID_EVENT,   name: 'EVENT'   },
        { uuid: CHAR_UUID_STATUS,  name: 'STATUS'  },
        { uuid: CHAR_UUID_SENSOR,  name: 'SENSOR'  },
        { uuid: CHAR_UUID_FEATURE, name: 'FEATURE' },
      ];

      let monitoredCount = 0;
      for (const { uuid, name } of NOTIFY_TARGETS) {
        const char = charByUUID[uuid.toLowerCase()];
        const helper = makeNotifyHandler(name);
        if (char) {
          const sub = char.monitor(helper.handler);
          helper.setSubscription(sub);
          monitoredCount++;
        } else {
          // Fallback: try UUID-based monitor in case characteristicsForService was empty
          try {
            const sub = discoveredDevice.monitorCharacteristicForService(SERVICE_UUID, uuid, helper.handler);
            helper.setSubscription(sub);
            monitoredCount++;
          } catch (monErr) {
            addLog(`WARNING: ${name} char not found in service (UUID: ${uuid.slice(0,8)}...)`, 'SYSTEM');
          }
        }
      }

      addLog(`Connected. Monitoring ${monitoredCount}/4 characteristics (EVENT, STATUS, SENSOR, FEATURE).`, 'SYSTEM');

      // Register device disconnect callback
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

  const sendBleCommand = async (commandByte) => {
    if (connectionState !== 'CONNECTED' || !activeDevice) {
      console.log('[BLE] Command skipped: No active connection.');
      return false;
    }

    try {
      const base64Value = encodeSingleByteBase64(commandByte);
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

  // Toggles streaming on/off
  const toggleStreaming = async () => {
    const nextStreamingState = !isStreaming;
    setIsStreaming(nextStreamingState);
    if (bleMode === 'REAL' && connectionState === 'CONNECTED') {
      await sendBleCommand(nextStreamingState ? 0x01 : 0x02);
    }
  };

  // 5. Timer decay for "Stillness Table Rest" simulation
  const startWearDecay = () => {
    setConnectionState('CONNECTED');
    setWearConfidence(100);
    clearTimeout(decayTimeoutRef.current);
    
    let step = 0;
    const interval = setInterval(() => {
      step++;
      setWearConfidence((prev) => {
        const next = Math.max(prev - 20, 0);
        if (next === 0) {
          clearInterval(interval);
        }
        return next;
      });
      // Feed motionless normal packets to the tracker
      processSimulatedPacket('NORMAL');
    }, 2000);
  };

  // 6. BLE packet feed processor
  const processSimulatedPacket = async (type) => {
    if (bleMode === 'REAL' && connectionState === 'CONNECTED') {
      let command = null;
      if (type === 'FALL') command = 0x0A;
      else if (type === 'STRUGGLE') command = 0x09;
      else if (type === 'NORMAL') command = 0x08;
      else if (type === 'SEIZURE') command = 0x08; // firmware maps to walking/normal
      
      if (command !== null) {
        await sendBleCommand(command);
      }
      return;
    }

    const rawBytes = generateMockPacket(type, {
      seq: streamSeq + 1,
      wearConfidence: wearConfidence,
    });
    const parsed = parseIncomingPacket(rawBytes);
    if (parsed) {
      setCurrentPacket(parsed);
      setBatteryPct(parsed.battery);
      setWearConfidence(parsed.wearConfidence);
    }
  };

  // Trigger calibration countdown
  const startCalibration = async () => {
    if (bleMode === 'REAL' && connectionState === 'CONNECTED') {
      const success = await sendBleCommand(0x05);
      if (!success) return;
    }

    setIsCalibrating(true);
    setCalibrationProgress(0);
    let progress = 0;
    const interval = setInterval(() => {
      progress += 10;
      setCalibrationProgress(progress);
      if (progress >= 100) {
        clearInterval(interval);
        setIsCalibrating(false);
      }
    }, 1000); // 10 seconds total
  };

  // Trigger emergencyOverlay
  const triggerEmergencyPreAlert = () => {
    setShowAlertModal(true);
    setAlertCountdown(15);
    setIsDispatched(false);

    // Flashing and vibration sequence
    alertIntervalRef.current = setInterval(() => {
      setBeepingFlash((prev) => !prev);
      Vibration.vibrate(400);

      setAlertCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(alertIntervalRef.current);
          executeEmergencyDispatch();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const executeEmergencyDispatch = () => {
    clearInterval(alertIntervalRef.current);
    setIsDispatched(true);
    setBeepingFlash(false);
    Vibration.vibrate([100, 500, 100, 500]);
  };

  const cancelEmergency = async () => {
    clearInterval(alertIntervalRef.current);
    setShowAlertModal(false);
    setIsDispatched(false);
    setBeepingFlash(false);
    
    if (bleMode === 'REAL' && connectionState === 'CONNECTED') {
      await sendBleCommand(0xFF); // Cancel emergency command
      await sendBleCommand(0x04); // Acknowledge alert command
    }

    // CRITICAL: Reset current packet metrics to normal ranges so the threat engine
    // doesn't immediately re-trigger once the 20s cooldown expires
    setCurrentPacket({
      anomalyScore: 20,
      anomalyDuration: 0,
      motionState: (1 << 1), // Periodic (normal walk)
      peakAccel: 1020,
      dominantFreq: 1.5,
      eigenvalueRatio: 500,
      zcr: 30,
      spectralEntropy: 110,
      wearConfidence: wearConfidence,
    });

    addLog('Alert cancelled by user. Packet metrics reset to NORMAL. Cooldown started (20s).', 'SYSTEM');

    // Log false alarm & start 5-minute sensitivity cooldown (represented as 20s in app for demo)
    setCooldownActive(true);
    setCooldownTime(20);
    setPostAnomalyStillness(false);

    // In simulation, also feed a normal packet so the graph clears
    if (bleMode === 'SIMULATION') {
      processSimulatedPacket('NORMAL');
    }

    const timer = setInterval(() => {
      setCooldownTime((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          setCooldownActive(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const threatLevel = getThreatLevel(threatScore);

  return (
    <SafeAreaView style={styles.mainContainer}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        
        {/* Mode Toggle Button Row */}
        <View style={styles.modeToggleRow}>
          <TouchableOpacity 
            style={[styles.modeToggleBtn, bleMode === 'SIMULATION' && styles.modeToggleBtnActive]} 
            onPress={() => {
              setBleMode('SIMULATION');
              setConnectionState('SIMULATING');
              handleDisconnect();
              setBleError(null);
            }}
          >
            <Text style={[styles.modeToggleText, bleMode === 'SIMULATION' && styles.modeToggleTextActive]}>🖥️ Simulation Mode</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.modeToggleBtn, bleMode === 'REAL' && styles.modeToggleBtnActive]} 
            onPress={() => {
              setBleMode('REAL');
              setConnectionState('DISCONNECTED');
              setBleError(null);
            }}
          >
            <Text style={[styles.modeToggleText, bleMode === 'REAL' && styles.modeToggleTextActive]}>🔌 Real BLE Mode</Text>
          </TouchableOpacity>
        </View>

        {/* Header - Connection Panel */}
        <View style={styles.glassHeader}>
          <View>
            <Text style={styles.subtext}>SafeBand Connection ({bleMode})</Text>
            <View style={styles.row}>
              <View style={[styles.statusRing, { 
                backgroundColor: 
                  connectionState === 'DISCONNECTED' ? '#EF4444' : 
                  connectionState === 'SCANNING' || connectionState === 'CONNECTING' ? '#F59E0B' : 
                  '#10B981' 
              }]} />
              <Text style={styles.titleText}>{connectionState}</Text>
            </View>
          </View>
          <View style={styles.alignRight}>
            <Text style={styles.subtext}>Battery</Text>
            <Text style={styles.batteryText}>{batteryPct}%</Text>
          </View>
        </View>

        {/* BLE Scanning Control Panel (Only in Real BLE Mode) */}
        {bleMode === 'REAL' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Bluetooth Device Scanner</Text>
            {bleError && (
              <View style={styles.errorAlert}>
                <Text style={styles.errorAlertText}>⚠️ {bleError}</Text>
              </View>
            )}

            {connectionState === 'DISCONNECTED' && (
              <TouchableOpacity style={styles.scanActionBtn} onPress={startScanning}>
                <Text style={styles.scanActionBtnText}>🔍 Scan for SafeBand-ESP32</Text>
              </TouchableOpacity>
            )}

            {connectionState === 'SCANNING' && (
              <View>
                <View style={[styles.row, { justifyContent: 'center', marginVertical: 12 }]}>
                  <ActivityIndicator size="small" color="#3B82F6" style={{ marginRight: 8 }} />
                  <Text style={styles.scanningLabel}>Scanning for active BLE peripherals...</Text>
                </View>
                
                {devices.length === 0 ? (
                  <Text style={styles.noDevicesText}>No devices found yet. Verify device is advertising.</Text>
                ) : (
                  devices.map((dev) => (
                    <View key={dev.id} style={styles.bleDeviceItem}>
                      <View>
                        <Text style={styles.bleDeviceNameText}>{dev.name}</Text>
                        <Text style={styles.bleDeviceIdText}>ID: {dev.id} | RSSI: {dev.rssi} dBm</Text>
                      </View>
                      <TouchableOpacity style={styles.bleDeviceConnectBtn} onPress={() => connectToDevice(dev.id)}>
                        <Text style={styles.bleDeviceConnectText}>Connect</Text>
                      </TouchableOpacity>
                    </View>
                  ))
                )}

                <TouchableOpacity style={[styles.scanActionBtn, { backgroundColor: '#EF4444', marginTop: 12 }]} onPress={stopScanning}>
                  <Text style={styles.scanActionBtnText}>Stop Scan</Text>
                </TouchableOpacity>
              </View>
            )}

            {connectionState === 'CONNECTING' && (
              <View style={[styles.row, { justifyContent: 'center', paddingVertical: 16 }]}>
                <ActivityIndicator size="large" color="#3B82F6" style={{ marginRight: 12 }} />
                <Text style={styles.connectingLabel}>Pairing and subscribing to services...</Text>
              </View>
            )}

            {connectionState === 'CONNECTED' && (
              <View>
                <Text style={styles.connectedDeviceLabel}>Connected to BLE peripheral successfully.</Text>
                {activeDevice && (
                  <Text style={styles.connectedDeviceIdText}>MAC/ID: {activeDevice.id}</Text>
                )}
                <TouchableOpacity style={[styles.scanActionBtn, { backgroundColor: '#EF4444', marginTop: 12 }]} onPress={handleDisconnect}>
                  <Text style={styles.scanActionBtnText}>🔌 Disconnect Device</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* Global Calibration & State details */}
        <View style={styles.miniStatsRow}>
          <Text style={styles.miniStat}>Uptime: {uptime} mins</Text>
          <Text style={styles.miniStat}>Wear Confidence: {wearConfidence}%</Text>
          <Text style={styles.miniStat}>
            {wearConfidence > 40 ? '✅ Worn' : '⚠️ Unworn'}
          </Text>
        </View>

        {/* TinyML Live Score Bar — shows raw ML anomaly score and motion state */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>⚡ Live TinyML Anomaly Score</Text>
          <View style={{ marginBottom: 8 }}>
            {/* Score bar background */}
            <View style={{ height: 22, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 11, overflow: 'hidden' }}>
              <View style={{
                height: 22,
                width: `${Math.min((currentPacket.anomalyScore / 255) * 100, 100)}%`,
                borderRadius: 11,
                backgroundColor:
                  currentPacket.anomalyScore > 180 ? '#B91C1C' :
                  currentPacket.anomalyScore > 128 ? '#EF4444' :
                  currentPacket.anomalyScore > 80  ? '#F59E0B' : '#10B981',
              }} />
              {/* Threshold marker at 128/255 = 50.2% */}
              <View style={{ position: 'absolute', left: '50%', top: 0, width: 2, height: 22, backgroundColor: '#FFFFFF', opacity: 0.6 }} />
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
              <Text style={{ color: '#64748B', fontSize: 10 }}>0 (Normal)</Text>
              <Text style={{ color: '#FFFFFF', fontSize: 11, fontWeight: 'bold' }}>
                {currentPacket.anomalyScore} / 255
                {currentPacket.anomalyScore > 128 ? ' ⚠️ FLAGGED' : ' ✓ Normal'}
              </Text>
              <Text style={{ color: '#64748B', fontSize: 10 }}>255 (Max)</Text>
            </View>
          </View>
          {/* Motion state badge row */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {[
              { bit: 0, label: 'STILL',       color: '#64748B' },
              { bit: 1, label: 'PERIODIC',    color: '#3B82F6' },
              { bit: 2, label: 'APERIODIC',   color: '#F59E0B' },
              { bit: 3, label: 'HIGH-IMPACT', color: '#EF4444' },
              { bit: 4, label: 'RESTRAINED',  color: '#8B5CF6' },
            ].map(({ bit, label, color }) => {
              const active = (currentPacket.motionState & (1 << bit)) !== 0;
              return (
                <View key={bit} style={{
                  paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
                  backgroundColor: active ? color + '33' : 'rgba(255,255,255,0.03)',
                  borderWidth: 1, borderColor: active ? color : 'rgba(255,255,255,0.06)',
                }}>
                  <Text style={{ color: active ? color : '#374151', fontSize: 10, fontWeight: '700' }}>{label}</Text>
                </View>
              );
            })}
            <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
              <Text style={{ color: '#64748B', fontSize: 10 }}>Dur: {(currentPacket.anomalyDuration * 0.1).toFixed(1)}s</Text>
            </View>
            <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
              <Text style={{ color: '#64748B', fontSize: 10 }}>Freq: {currentPacket.dominantFreq?.toFixed(1) ?? '?'}Hz</Text>
            </View>
          </View>
        </View>

        {/* Threat Score Gauge Card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Context Engine Threat Score</Text>
          <View style={styles.gaugeContainer}>
            <Svg height="160" width="160" viewBox="0 0 100 100">
              {/* Background Arc */}
              <Circle
                cx="50"
                cy="50"
                r="40"
                stroke="#1E293B"
                strokeWidth="10"
                fill="transparent"
                strokeDasharray="251"
                strokeDashoffset="62"
                strokeLinecap="round"
                transform="rotate(-225 50 50)"
              />
              {/* Glowing Active Arc */}
              <Circle
                cx="50"
                cy="50"
                r="40"
                stroke={threatLevel.color}
                strokeWidth="10"
                fill="transparent"
                strokeDasharray="251"
                strokeDashoffset={251 - (189 * threatScore)}
                strokeLinecap="round"
                transform="rotate(-225 50 50)"
              />
            </Svg>
            <View style={styles.gaugeCenterText}>
              <Text style={styles.gaugeScoreText}>{Math.round(threatScore * 100)}%</Text>
              <Text style={[styles.gaugeLevelText, { color: threatLevel.color }]}>
                {threatLevel.name}
              </Text>
            </View>
          </View>

          <Text style={styles.gaugeActionText}>Action: {threatLevel.action}</Text>

          {/* List of active multipliers */}
          <View style={styles.multiplierList}>
            <Text style={styles.multiplierItem}>
              • Raw Motion Anomaly: {Math.round(currentPacket.anomalyScore / 1.28)}%
            </Text>
            <Text style={styles.multiplierItem}>
              • Location modifier: {location === 'HOME' ? '×0.55 (Home)' : location === 'KNOWN_SAFE' ? '×0.65 (Safe)' : location === 'UNKNOWN_ISOLATED' ? '×1.35 (Isolated)' : '×1.00 (Urban)'}
            </Text>
            <Text style={styles.multiplierItem}>
              • Time modifier: {timeOfDay === 'NIGHT_RISK' ? '×1.20 (Night)' : timeOfDay === 'LATE_NIGHT' ? '×1.15 (Late Night)' : timeOfDay === 'DAYTIME' ? '×0.90 (Day)' : '×1.00'}
            </Text>
            {postAnomalyStillness && (
              <Text style={[styles.multiplierItem, { color: '#EF4444' }]}>
                • Post-Anomaly Stillness detected (+0.15 score bonus)
              </Text>
            )}
            {cooldownActive && (
              <Text style={[styles.multiplierItem, { color: '#3B82F6' }]}>
                • Cooldown Active: Threat score scaled to 60% ({cooldownTime}s remaining)
              </Text>
            )}
          </View>
        </View>

        {/* Real-time Scrolling Sensor Graph */}
        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.cardTitle}>Live Sensor Graph (25 Hz)</Text>
            <TouchableOpacity onPress={toggleStreaming}>
              <Text style={styles.linkText}>{isStreaming ? 'Pause Stream' : 'Resume Stream'}</Text>
            </TouchableOpacity>
          </View>

          {/* SVG canvas for drawing streams */}
          <View style={styles.graphContainer}>
            <Svg height="140" width={width - 48}>
              {/* Threshold line at 128 (middle axis) */}
              <Line x1="0" y1="70" x2={width - 48} y2="70" stroke="#EF4444" strokeWidth="1.5" strokeDasharray="4,4" />
              <Text style={styles.thresholdTextLabel}>anomaly threshold (128)</Text>

              {/* Draw raw resultant accel stream (blue) */}
              {streamData.length > 1 && (
                <Path
                  d={streamData.reduce((path, p, idx) => {
                    const x = (idx / 49) * (width - 48);
                    // Accel Y gravity sits around 1000. Normalize visual display:
                    const y = 70 - ((p.resultant - 1000) * 0.04);
                    return path + `${idx === 0 ? 'M' : 'L'} ${x} ${y}`;
                  }, '')}
                  fill="none"
                  stroke="#3B82F6"
                  strokeWidth="2"
                />
              )}

              {/* Draw anomaly score overlay (red shaded area) */}
              {streamData.length > 1 && (
                <Path
                  d={streamData.reduce((path, p, idx) => {
                    const x = (idx / 49) * (width - 48);
                    const y = 140 - (p.anomalyScore * 0.54); // Scaled from 0-255 to fit height
                    return path + `${idx === 0 ? 'M' : 'L'} ${x} ${y}`;
                  }, '') + ` L ${width - 48} 140 L 0 140 Z`}
                  fill="rgba(239, 68, 68, 0.15)"
                  stroke="rgba(239, 68, 68, 0.4)"
                  strokeWidth="1.5"
                />
              )}
            </Svg>
          </View>
          <View style={styles.rowBetween}>
            <View style={styles.row}>
              <View style={[styles.graphLegendPin, { backgroundColor: '#3B82F6' }]} />
              <Text style={styles.legendText}>Resultant Accel (mg)</Text>
            </View>
            <View style={styles.row}>
              <View style={[styles.graphLegendPin, { backgroundColor: 'rgba(239, 68, 68, 0.5)' }]} />
              <Text style={styles.legendText}>Anomaly Score (scaled)</Text>
            </View>
          </View>
        </View>

        {/* Environmental Context Configurator */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Location & Environmental Context</Text>
          <Text style={styles.subtext}>Modulate these variables to test risk multipliers:</Text>
          
          <Text style={styles.sectionLabel}>Geolocation geofence:</Text>
          <View style={styles.row}>
            {['HOME', 'UNKNOWN_URBAN', 'UNKNOWN_ISOLATED'].map((loc) => (
              <TouchableOpacity
                key={loc}
                style={[styles.segmentBtn, location === loc && styles.segmentBtnActive]}
                onPress={() => setLocation(loc)}
              >
                <Text style={[styles.segmentBtnText, location === loc && styles.segmentBtnTextActive]}>
                  {loc.replace('_', ' ')}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Time of day:</Text>
          <View style={styles.row}>
            {['DAYTIME', 'MORNING', 'NIGHT_RISK'].map((time) => (
              <TouchableOpacity
                key={time}
                style={[styles.segmentBtn, timeOfDay === time && styles.segmentBtnActive]}
                onPress={() => setTimeOfDay(time)}
              >
                <Text style={[styles.segmentBtnText, timeOfDay === time && styles.segmentBtnTextActive]}>
                  {time.replace('_', ' ')}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.rowBetween}>
            <Text style={styles.sectionLabel}>Post-Anomaly Stillness:</Text>
            <TouchableOpacity
              style={[styles.toggleBtn, postAnomalyStillness && styles.toggleBtnActive]}
              onPress={() => setPostAnomalyStillness(!postAnomalyStillness)}
            >
              <Text style={styles.toggleBtnText}>{postAnomalyStillness ? 'ACTIVE (+0.15)' : 'INACTIVE'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Active Simulation Controllers */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{bleMode === 'REAL' ? 'SafeBand Hardware Command Board' : 'SafeBand Telemetry Simulator'}</Text>
          <Text style={styles.subtext}>
            {bleMode === 'REAL' 
              ? 'Send commands to change mock motion patterns on the physical firmware:' 
              : 'Trigger events to verify Context Engine & Alert state machine:'}
          </Text>
          
          <View style={styles.simulationGrid}>
            <TouchableOpacity style={[styles.simBtn, { borderLeftColor: '#EF4444' }]} onPress={() => processSimulatedPacket('FALL')}>
              <Text style={styles.simBtnText}>🚨 {bleMode === 'REAL' ? 'Trigger Fall Mode' : 'Simulate Fall'}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.simBtn, { borderLeftColor: '#F59E0B' }]} onPress={() => processSimulatedPacket('STRUGGLE')}>
              <Text style={styles.simBtnText}>✊ {bleMode === 'REAL' ? 'Trigger Struggle Mode' : 'Simulate Struggle'}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.simBtn, { borderLeftColor: '#3B82F6' }]} onPress={() => processSimulatedPacket('SEIZURE')}>
              <Text style={styles.simBtnText}>⚡ {bleMode === 'REAL' ? 'Trigger Seizure Mode' : 'Simulate Seizure'}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.simBtn, { borderLeftColor: '#10B981' }]} onPress={() => processSimulatedPacket('NORMAL')}>
              <Text style={styles.simBtnText}>🚶 {bleMode === 'REAL' ? 'Trigger Walk Mode' : 'Simulate Walk'}</Text>
            </TouchableOpacity>

            {bleMode === 'SIMULATION' && (
              <TouchableOpacity style={[styles.simBtn, { borderLeftColor: '#6B7280' }]} onPress={startWearDecay}>
                <Text style={styles.simBtnText}>📴 Table Still Rest</Text>
              </TouchableOpacity>
            )}

            {bleMode === 'SIMULATION' && (
              <TouchableOpacity style={[styles.simBtn, { borderLeftColor: '#EF4444' }]} onPress={() => setConnectionState(connectionState === 'DISCONNECTED' ? 'SIMULATING' : 'DISCONNECTED')}>
                <Text style={styles.simBtnText}>🔌 Toggle BLE link</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Calibration controls */}
        <TouchableOpacity style={styles.calibrateLargeBtn} onPress={startCalibration} disabled={isCalibrating}>
          {isCalibrating ? (
            <Text style={styles.calibrateLargeBtnText}>Calibrating Alignment... {calibrationProgress}%</Text>
          ) : (
            <Text style={styles.calibrateLargeBtnText}>📐 Calibrate Wrist Alignment (Command 0x05)</Text>
          )}
        </TouchableOpacity>

        {/* Emergency Contacts Card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Emergency Contacts (SMS Priority)</Text>
          <View style={styles.contactItem}>
            <View>
              <Text style={styles.contactName}>Jane Doe (Primary)</Text>
              <Text style={styles.contactPhone}>+1 (555) 019-2831 (Verified)</Text>
            </View>
            <Text style={styles.notifyBadge}>SMS</Text>
          </View>
          <View style={styles.contactItem}>
            <View>
              <Text style={styles.contactName}>John Smith</Text>
              <Text style={styles.contactPhone}>+1 (555) 012-9844 (Verified)</Text>
            </View>
            <Text style={styles.notifyBadge}>SMS + Call</Text>
          </View>
        </View>

        {/* ─── Diagnostics / Debug Terminal ─────────────────────────── */}
        <View style={styles.terminalCard}>

          {/* Header row: title + count badge + toggle */}
          <TouchableOpacity
            style={styles.terminalHeader}
            onPress={() => setShowLogs((prev) => !prev)}
            activeOpacity={0.75}
          >
            <View style={styles.row}>
              <Text style={styles.terminalTitle}>🖥️ Diagnostics Terminal</Text>
              <View style={styles.terminalBadge}>
                <Text style={styles.terminalBadgeText}>{logs.length}</Text>
              </View>
            </View>
            <View style={styles.row}>
              {logs.length > 0 && (
                <TouchableOpacity
                  onPress={(e) => { e.stopPropagation(); setLogs([]); }}
                  style={styles.terminalClearBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.terminalClearBtnText}>CLEAR</Text>
                </TouchableOpacity>
              )}
              <Text style={styles.terminalChevron}>{showLogs ? '▲' : '▼'}</Text>
            </View>
          </TouchableOpacity>

          {showLogs && (
            <View>
              {/* Filter chips */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.terminalChipRow}
                contentContainerStyle={{ paddingRight: 8 }}
              >
                {['ALL', 'TINYML', 'CONTEXT', 'SYSTEM'].map((f) => {
                  const chipColors = {
                    ALL:     '#6B7280',
                    TINYML:  '#3B82F6',
                    CONTEXT: '#8B5CF6',
                    SYSTEM:  '#10B981',
                  };
                  const active = logFilter === f;
                  return (
                    <TouchableOpacity
                      key={f}
                      style={[
                        styles.terminalChip,
                        active && { backgroundColor: chipColors[f] + '33', borderColor: chipColors[f] },
                      ]}
                      onPress={() => setLogFilter(f)}
                    >
                      <Text style={[
                        styles.terminalChipText,
                        active && { color: chipColors[f] },
                      ]}>{f}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              {/* Log entries */}
              <ScrollView
                style={styles.terminalScrollArea}
                nestedScrollEnabled
                showsVerticalScrollIndicator={false}
              >
                {logs
                  .filter((l) => logFilter === 'ALL' || l.category === logFilter)
                  .slice(0, 150)
                  .map((entry) => {
                    const catColor = {
                      TINYML:  '#60A5FA',
                      CONTEXT: '#A78BFA',
                      RAW:     '#FCD34D',
                      SYSTEM:  '#34D399',
                    }[entry.category] || '#9CA3AF';
                    return (
                      <View key={entry.id} style={styles.terminalLogRow}>
                        <Text style={[styles.terminalLogTime, { color: catColor }]}>
                          [{entry.time}]
                        </Text>
                        <Text style={styles.terminalLogCategory}>
                          <Text style={{ color: catColor }}>{entry.category} </Text>
                          <Text style={styles.terminalLogMessage}>{entry.message}</Text>
                        </Text>
                      </View>
                    );
                  })}
                {logs.filter((l) => logFilter === 'ALL' || l.category === logFilter).length === 0 && (
                  <Text style={styles.terminalEmptyText}>
                    No {logFilter === 'ALL' ? '' : logFilter + ' '}logs yet. Start streaming or connect BLE.
                  </Text>
                )}
              </ScrollView>
            </View>
          )}
        </View>

      </ScrollView>

      {/* Emergency Overlay Modal */}
      <Modal visible={showAlertModal} transparent animationType="fade">
        <View style={[styles.overlayBg, beepingFlash && styles.overlayBgFlash]}>
          <SafeAreaView style={styles.overlayContainer}>
            
            {!isDispatched ? (
              // Countdown State
              <View style={styles.alignCenter}>
                <Text style={styles.overlayAlertHeader}>🚨 HIGH THREAT DETECTED</Text>
                <Text style={styles.overlaySubheader}>Possible physical danger or fall detected.</Text>
                
                {/* Large countdown circle */}
                <View style={styles.countdownWrapper}>
                  <Text style={styles.countdownNum}>{alertCountdown}</Text>
                  <Text style={styles.countdownSec}>seconds</Text>
                </View>

                <Text style={styles.alertExplanation}>
                  SafeBand context engine threat score reached **{Math.round(threatScore * 100)}%**. 
                  Emergency messages will be dispatched automatically when the timer expires.
                </Text>

                <TouchableOpacity style={styles.cancelBtn} onPress={cancelEmergency}>
                  <Text style={styles.cancelBtnText}>I'M SAFE (CANCEL ALERT)</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.helpNowBtn} onPress={executeEmergencyDispatch}>
                  <Text style={styles.helpNowBtnText}>HELP ME NOW (SEND NOW)</Text>
                </TouchableOpacity>
              </View>
            ) : (
              // Dispatched state
              <View style={styles.alignCenter}>
                <Text style={styles.overlayAlertHeader}>🚨 ALERTS DISPATCHED</Text>
                
                <View style={styles.dispatchedCircle}>
                  <Text style={styles.dispatchedIcon}>📨</Text>
                </View>

                <Text style={styles.dispatchedSubheader}>SMS messages sent to all emergency contacts.</Text>

                {/* Dispatch report detail */}
                <View style={styles.dispatchReportCard}>
                  <Text style={styles.reportItem}>• User Profile: Jane Smith (Location Shared)</Text>
                  <Text style={styles.reportItem}>• Coordinates: 12.9716° N, 77.5946° E</Text>
                  <Text style={styles.reportItem}>• Mode: Autoencoder Fall Pattern Match</Text>
                  <Text style={styles.reportItem}>• Contact: Jane Doe [SMS SENT]</Text>
                  <Text style={styles.reportItem}>• Contact: John Smith [SMS SENT + CALL QUEUED]</Text>
                </View>

                <TouchableOpacity style={[styles.cancelBtn, { backgroundColor: '#10B981', borderColor: '#10B981' }]} onPress={cancelEmergency}>
                  <Text style={styles.cancelBtnText}>DISMISS (RESOLVE THREAT)</Text>
                </TouchableOpacity>
              </View>
            )}

          </SafeAreaView>
        </View>
      </Modal>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  modeToggleRow: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderRadius: 12,
    padding: 4,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  modeToggleBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 8,
  },
  modeToggleBtnActive: {
    backgroundColor: '#1E293B',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  modeToggleText: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
  },
  modeToggleTextActive: {
    color: '#FFFFFF',
  },
  scanActionBtn: {
    backgroundColor: '#3B82F6',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanActionBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: 'bold',
  },
  scanningLabel: {
    color: '#94A3B8',
    fontSize: 13,
  },
  noDevicesText: {
    color: '#64748B',
    fontSize: 12,
    textAlign: 'center',
    marginVertical: 12,
  },
  bleDeviceItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.01)',
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.03)',
  },
  bleDeviceNameText: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: 'bold',
  },
  bleDeviceIdText: {
    color: '#64748B',
    fontSize: 11,
    marginTop: 2,
  },
  bleDeviceConnectBtn: {
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    borderColor: '#3B82F6',
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  bleDeviceConnectText: {
    color: '#3B82F6',
    fontSize: 12,
    fontWeight: 'bold',
  },
  connectingLabel: {
    color: '#94A3B8',
    fontSize: 14,
  },
  connectedDeviceLabel: {
    color: '#10B981',
    fontSize: 14,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 4,
  },
  connectedDeviceIdText: {
    color: '#64748B',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 8,
  },
  errorAlert: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderColor: '#EF4444',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
  },
  errorAlertText: {
    color: '#EF4444',
    fontSize: 12,
    fontWeight: '600',
  },
  mainContainer: {
    flex: 1,
    backgroundColor: '#070A13',
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  glassHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginTop: 20,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  statusRing: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  titleText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  batteryText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#10B981',
  },
  alignRight: {
    alignItems: 'end',
  },
  miniStatsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 12,
  },
  miniStat: {
    color: '#94A3B8',
    fontSize: 12,
  },
  card: {
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
    borderColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#F8FAFC',
    marginBottom: 12,
  },
  subtext: {
    color: '#64748B',
    fontSize: 12,
    marginBottom: 4,
  },
  gaugeContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 180,
  },
  gaugeCenterText: {
    position: 'absolute',
    alignItems: 'center',
  },
  gaugeScoreText: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  gaugeLevelText: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 4,
  },
  gaugeActionText: {
    color: '#94A3B8',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 16,
  },
  multiplierList: {
    backgroundColor: 'rgba(255, 255, 255, 0.01)',
    borderRadius: 12,
    padding: 12,
  },
  multiplierItem: {
    color: '#64748B',
    fontSize: 12,
    marginBottom: 6,
  },
  sectionLabel: {
    color: '#94A3B8',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 8,
  },
  segmentBtn: {
    flex: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
    borderColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginRight: 6,
  },
  segmentBtnActive: {
    backgroundColor: '#3B82F6',
    borderColor: '#3B82F6',
  },
  segmentBtnText: {
    color: '#64748B',
    fontSize: 11,
    fontWeight: '600',
  },
  segmentBtnTextActive: {
    color: '#FFFFFF',
  },
  toggleBtn: {
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
    borderColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  toggleBtnActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    borderColor: '#EF4444',
  },
  toggleBtnText: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: 'bold',
  },
  simulationGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  simBtn: {
    width: '48%',
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
    borderLeftWidth: 4,
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
  },
  simBtnText: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '600',
  },
  calibrateLargeBtn: {
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    borderColor: '#3B82F6',
    borderWidth: 1.5,
    borderRadius: 16,
    padding: 16,
    alignItems: 'center',
    marginBottom: 16,
  },
  calibrateLargeBtnText: {
    color: '#3B82F6',
    fontSize: 14,
    fontWeight: 'bold',
  },
  contactItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.01)',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  contactName: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: 'bold',
  },
  contactPhone: {
    color: '#64748B',
    fontSize: 11,
    marginTop: 2,
  },
  notifyBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    color: '#F8FAFC',
    fontSize: 10,
    fontWeight: 'bold',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  linkText: {
    color: '#3B82F6',
    fontSize: 13,
    fontWeight: '600',
  },
  graphContainer: {
    height: 140,
    marginVertical: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
    borderRadius: 12,
  },
  thresholdTextLabel: {
    fill: '#EF4444',
    fontSize: 10,
    x: 10,
    y: 65,
  },
  graphLegendPin: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  legendText: {
    color: '#64748B',
    fontSize: 11,
  },
  // Overlay CSS details
  overlayBg: {
    flex: 1,
    backgroundColor: '#7F1D1D',
    justifyContent: 'center',
  },
  overlayBgFlash: {
    backgroundColor: '#B91C1C',
  },
  overlayContainer: {
    alignItems: 'center',
    padding: 24,
  },
  alignCenter: {
    alignItems: 'center',
  },
  overlayAlertHeader: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '900',
    textAlign: 'center',
    marginBottom: 8,
  },
  overlaySubheader: {
    color: '#FCA5A5',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 24,
  },
  countdownWrapper: {
    width: 160,
    height: 160,
    borderRadius: 80,
    borderWidth: 6,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 24,
  },
  countdownNum: {
    color: '#FFFFFF',
    fontSize: 54,
    fontWeight: 'bold',
  },
  countdownSec: {
    color: '#FCA5A5',
    fontSize: 12,
    fontWeight: 'bold',
    marginTop: -4,
  },
  alertExplanation: {
    color: '#FEE2E2',
    textAlign: 'center',
    fontSize: 14,
    lineHeight: 22,
    marginHorizontal: 16,
    marginBottom: 32,
  },
  cancelBtn: {
    backgroundColor: '#EF4444',
    borderColor: '#FFFFFF',
    borderWidth: 2,
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 32,
    width: width - 80,
    alignItems: 'center',
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
  },
  cancelBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
  helpNowBtn: {
    backgroundColor: 'transparent',
    paddingVertical: 12,
  },
  helpNowBtnText: {
    color: '#FECACA',
    fontSize: 14,
    textDecorationLine: 'underline',
    fontWeight: '600',
  },
  dispatchedCircle: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 32,
  },
  dispatchedIcon: {
    fontSize: 60,
  },
  dispatchedSubheader: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 16,
  },
  dispatchReportCard: {
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
    borderRadius: 16,
    padding: 16,
    width: width - 48,
    marginBottom: 32,
  },
  reportItem: {
    color: '#FECACA',
    fontSize: 13,
    marginBottom: 8,
    lineHeight: 18,
  },

  // ─── Debug Terminal styles ────────────────────────────────────────────
  terminalCard: {
    marginHorizontal: 16,
    marginBottom: 24,
    borderRadius: 18,
    backgroundColor: '#0D1117',
    borderWidth: 1,
    borderColor: '#21262D',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.45,
    shadowRadius: 12,
    elevation: 8,
  },
  terminalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#161B22',
    borderBottomWidth: 1,
    borderBottomColor: '#21262D',
  },
  terminalTitle: {
    color: '#E6EDF3',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.3,
    marginRight: 8,
  },
  terminalBadge: {
    backgroundColor: '#21262D',
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  terminalBadgeText: {
    color: '#8B949E',
    fontSize: 11,
    fontWeight: '600',
  },
  terminalClearBtn: {
    marginRight: 12,
    backgroundColor: '#21262D',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  terminalClearBtnText: {
    color: '#EF4444',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  terminalChevron: {
    color: '#8B949E',
    fontSize: 13,
    fontWeight: '700',
  },
  terminalChipRow: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#21262D',
  },
  terminalChip: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#30363D',
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginRight: 6,
    backgroundColor: 'transparent',
  },
  terminalChipText: {
    color: '#8B949E',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  terminalScrollArea: {
    maxHeight: 320,
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 8,
  },
  terminalLogRow: {
    marginBottom: 5,
    flexDirection: 'column',
  },
  terminalLogTime: {
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    opacity: 0.7,
    marginBottom: 1,
  },
  terminalLogCategory: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    lineHeight: 16,
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  terminalLogMessage: {
    color: '#CDD9E5',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  terminalEmptyText: {
    color: '#484F58',
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: 24,
    fontStyle: 'italic',
  },
});
