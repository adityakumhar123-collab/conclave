import { useState, useEffect, useRef } from 'react';
import { Platform, PermissionsAndroid } from 'react-native';
import {
  parseIncomingPacket,
  SERVICE_UUID,
  CHAR_UUID_EVENT,
  CHAR_UUID_COMMAND,
  CHAR_UUID_DEVICE_INFO,
  CHAR_UUID_STATUS,
  CHAR_UUID_SENSOR,
  CHAR_UUID_FEATURE,
  base64ToUint8Array,
  encodeSingleByteBase64,
} from '../BleService';

// Helper to decode Base64 characteristics value into a raw string
function decodeBase64ToString(base64) {
  const bytes = base64ToUint8Array(base64);
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return str;
}

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

export default function useBle(activeTab, addLog) {
  const [connectionState, setConnectionState] = useState('DISCONNECTED'); // 'DISCONNECTED', 'SCANNING', 'CONNECTING', 'CONNECTED'
  const [devices, setDevices] = useState([]);
  const [activeDevice, setActiveDevice] = useState(null);
  const [bleError, setBleError] = useState(null);

  // SafeBand device state
  const [wearConfidence, setWearConfidence] = useState(100);
  const [batteryPct, setBatteryPct] = useState(98);
  const [uptime, setUptime] = useState(12);

  // Real-time sensor streaming data (for graph)
  const [isStreaming, setIsStreaming] = useState(true);
  const [streamData, setStreamData] = useState([]); // Holds last 50 points of accel x, y, z & anomaly score

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

  const bleManagerRef = useRef(null);
  const activeTabRef = useRef(activeTab);
  const lastGraphUpdateRef = useRef(0);

  // Sync ref
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  // BleManager Lifecycle
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

  // Packet Handler Utility
  const handleIncomingPacket = (parsed) => {
    if (parsed.type === 'SENSOR') {
      if (isStreaming && activeTabRef.current === 'DASHBOARD') {
        const now = Date.now();
        if (now - lastGraphUpdateRef.current > 200) {
          lastGraphUpdateRef.current = now;
          setStreamData((prevData) => {
            const newData = [...prevData, parsed];
            if (newData.length > 50) newData.shift();
            return newData;
          });
        }
      }
      if (Math.random() < 0.10) {
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
      if (parsed.wearConfidence !== undefined) setWearConfidence(parsed.wearConfidence);
      if (parsed.uptime !== undefined) setUptime(parsed.uptime);

      addLog(`Heartbeat: Battery=${parsed.battery}% Wear=${parsed.wearConfidence}% Uptime=${parsed.uptime}m AvgAnomaly=${parsed.avgAnomaly} Inference=${parsed.inferenceRate}Hz`, 'TINYML');
    }
  };

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

      try {
        await device.requestMTU(64);
        console.log('[BLE] MTU negotiated to 64 bytes.');
        addLog('MTU negotiated: 64 bytes — packet fragmentation prevented.', 'SYSTEM');
      } catch (mtuErr) {
        console.warn('[BLE] MTU negotiation failed (non-fatal):', mtuErr.message);
        addLog(`MTU negotiation warning: ${mtuErr.message}`, 'SYSTEM');
      }

      console.log('[BLE] Discovering services and characteristics...');
      const discoveredDevice = await device.discoverAllServicesAndCharacteristics();

      setActiveDevice(discoveredDevice);
      setConnectionState('CONNECTED');
      setDevices([]);

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

      const startStreamBase64 = encodeSingleByteBase64(0x01);
      await discoveredDevice.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHAR_UUID_COMMAND,
        startStreamBase64
      );
      setIsStreaming(true);

      const makeNotifyHandler = (charName) => {
        let subscription = null;
        let active = true;
        const handler = (error, characteristic) => {
          if (!active) return;
          if (error) {
            active = false;
            if (error.errorCode !== 2) {
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

      let discoveredChars = [];
      try {
        discoveredChars = await discoveredDevice.characteristicsForService(SERVICE_UUID);
        addLog(`GATT: Discovered ${discoveredChars.length} characteristics in service.`, 'SYSTEM');
      } catch (charErr) {
        addLog(`GATT enumeration failed: ${charErr.message} — falling back to UUID monitor.`, 'SYSTEM');
      }

      const charByUUID = {};
      for (const c of discoveredChars) {
        charByUUID[c.uuid.toLowerCase()] = c;
      }

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

  const toggleStreaming = async () => {
    const nextStreamingState = !isStreaming;
    setIsStreaming(nextStreamingState);
    if (connectionState === 'CONNECTED') {
      await sendBleCommand(nextStreamingState ? 0x01 : 0x02);
    }
  };

  return {
    connectionState,
    devices,
    activeDevice,
    bleError,
    wearConfidence,
    batteryPct,
    uptime,
    isStreaming,
    streamData,
    currentPacket,
    setStreamData,
    setCurrentPacket,
    setWearConfidence,
    setBatteryPct,
    setUptime,
    startScanning,
    stopScanning,
    connectToDevice,
    handleDisconnect,
    sendBleCommand,
    toggleStreaming,
  };
}
