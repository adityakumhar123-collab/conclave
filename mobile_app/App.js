// =============================================================================
// App.js — Root Coordinator, UI Orchestrator, & Event Wiring
// =============================================================================
//
// DRY RUN / ARCHITECTURE OVERVIEW
// --------------------------------
// App.js is the root component of the SafeBand React Native mobile app.
// It initializes and wires together the BLE connection hook (useBle), the
// SQLite database hook (useDatabase), and the emergency notification dispatcher
// hook (useEmergency). It renders the navigation tab layout and switches
// between the four primary dashboard/utility views.
//
// WHO CALLS THIS:
//   → Expo App Entry (index.js / AppEntry.js) loads this as the root component on launch.
//
// CHILD COMPONENTS INSTANTIATED INSIDE IT:
//   - DashboardTab.js       — Main telemetry metrics, status gauges, log terminal, device scanning
//   - ContactsTab.js        — Listing of saved emergency contacts
//   - TemplatesTab.js       — Configuration of custom alert notification templates
//   - SettingsTab.js        — Twilio/Resend keys, PIN locks, background tasks, cleanup
//   - ContactFormModal.js   — Add/Edit contact overlay form
//   - TemplateFormModal.js  — Add/Edit template overlay form
//   - Background overlays   — 15s Countdown alert overlay, PIN verification screen, and status alerts
//
// DATA LIFE-CYCLE & DUAL TIMER LOOPS:
//
//   1. High-Rate Real-Time Flow (2 Hz BLE FEATURE updates):
//      - useBle receives a FEATURE packet via BLE every 500ms.
//      - App.js runs a `useEffect` loop that recalculates the threat score:
//        `computeThreatScoreDetailed(currentPacket, { familiarityScore })`
//      - If the computed threat score exceeds the safety limit (0.72) and no alert
//        is currently active/cooldown is off, it locks `alertTriggeredRef.current = true`
//        and starts the 15-second countdown modal.
//
//   2. Moderate-Rate Background Flow (3-second Context Engine updates):
//      - A background interval timer runs every 3 seconds to execute:
//        `ContextEngine.runInference(packet)`
//      - This queries historical SQLite tables (`observations`, `episodes`) to compute the
//        current 3-level behavioral familiarity score. Decoupling this heavier DB process
//        from the 2 Hz BLE stream prevents UI lagging or missing packets.
//
// GPS LOCATION UPDATES (watchPositionAsync):
//   - On mount, App.js requests GPS permissions and subscribes to location changes.
//   - Every GPS change is pushed to `LocationEngine.onLocationUpdate()` to update
//     geofencing visits, candidates, and current position coordinates.
//
// SECURITY PIN LOGIC:
//   - The keypad modal on lines 581–661 intercepts dismiss attempts if PIN is enabled.
//   - Entering `real_pin` calls `cancelEmergency()` (genuine cancel).
//   - Entering `fake_pin` calls `executeEmergencyDispatch(true)` (silent alert / coercion mode).
//
// BUGS / NOTES:
//   ⚠ The `currentPacketRef` and `wearConfidenceRef` are initialized as refs but updated
//     directly in the render body (lines 79–80). In React, writing to refs during
//     rendering can cause subtle timing issues or render mismatches. A safer practice is
//     to update them inside a `useEffect` keyed on the state changes.
//   ⚠ The 3-second context timer interval (lines 334–348) has an empty dependency array `[]`.
//     It captures initial values of refs, which works correctly because refs bypass closure stale locks.
// =============================================================================

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Modal,
  Dimensions,
  Vibration,
  Platform,
  Alert,
  Animated,
  Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Line, Text as SvgText } from 'react-native-svg';

import { ContextEngine, computeThreatScoreDetailed, getThreatLevel } from './src/ContextEngine';
import * as Location from 'expo-location';
import { LocationEngine } from './src/LocationEngine.js';
import { EpisodeEngine } from './src/EpisodeEngine.js';
import { BackgroundServices } from './src/BackgroundServices.js';

// Modular Component & Styles imports
import ContactsTab from './src/components/ContactsTab';
import TemplatesTab from './src/components/TemplatesTab';
import SettingsTab from './src/components/SettingsTab';
import DashboardTab from './src/components/DashboardTab';
import DatabaseTab from './src/components/DatabaseTab';
import styles from './src/components/styles';
import { saveSetting } from './src/Database';

// Hooks & Modals imports
import useBle from './src/hooks/useBle';
import useDatabase from './src/hooks/useDatabase';
import useEmergency from './src/hooks/useEmergency';
import ContactFormModal from './src/components/ContactFormModal';
import TemplateFormModal from './src/components/TemplateFormModal';

const { width } = Dimensions.get('window');

export default function App() {
  const insets = useSafeAreaInsets();
  const alertTriggeredRef = useRef(false);



  const [threatScore, setThreatScore] = useState(0.05);
  const [famLevel1, setFamLevel1] = useState(1.0);
  const [famLevel2, setFamLevel2] = useState(1.0);
  const [famFinal, setFamFinal] = useState(1.0);

  // Diagnostics Terminal log state
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(true); // Default open to show diagnostics
  const [logFilter, setLogFilter] = useState('CONTEXT'); // 'ALL', 'TINYML', 'CONTEXT', 'SYSTEM'

  // Form modals and tab selections
  const [activeTab, setActiveTab] = useState('DASHBOARD');
  const [editingContact, setEditingContact] = useState(null);
  const [showContactModal, setShowContactModal] = useState(false);

  const [editingTemplate, setEditingTemplate] = useState(null);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [templateSelection, setTemplateSelection] = useState({ start: 0, end: 0 });

  // Animated keyboard translation value to slide overlays up on Android without layout jitter
  const keyboardOffset = useRef(new Animated.Value(0)).current;

  // References
  const logsHistoryRef = useRef([]);
  const logFilterRef = useRef('CONTEXT');
  const activeTabRef = useRef(activeTab);
  const showLogsRef = useRef(showLogs);

  const currentPacketRef = useRef(currentPacket);
  const wearConfidenceRef = useRef(wearConfidence);

  currentPacketRef.current = currentPacket;
  wearConfidenceRef.current = wearConfidence;

  // Keep refs synchronized
  logFilterRef.current = logFilter;
  activeTabRef.current = activeTab;
  showLogsRef.current = showLogs;

  // Log appending helpers
  const addLog = (message, category = 'SYSTEM') => {
    const time = new Date().toLocaleTimeString();
    const newLog = { id: Math.random().toString(), time, message, category };

    logsHistoryRef.current = [newLog, ...logsHistoryRef.current].slice(0, 250);

    if (showLogsRef.current) {
      if (logFilterRef.current === 'ALL' || category === logFilterRef.current || category === 'SYSTEM') {
        setLogs((prev) => [newLog, ...prev].slice(0, 250));
      }
    }
  };

  const addLogs = (newLogsArray) => {
    const time = new Date().toLocaleTimeString();
    const formatted = newLogsArray.map(({ message, category }) => ({
      id: Math.random().toString(),
      time,
      message,
      category: category || 'SYSTEM'
    }));

    logsHistoryRef.current = [...formatted, ...logsHistoryRef.current].slice(0, 250);

    if (showLogsRef.current) {
      const visible = formatted.filter(
        (l) => logFilterRef.current === 'ALL' || l.category === logFilterRef.current || l.category === 'SYSTEM'
      );
      if (visible.length > 0) {
        setLogs((prev) => [...visible, ...prev].slice(0, 250));
      }
    }
  };

  const handleFilterChange = (newFilter) => {
    setLogFilter(newFilter);
    logFilterRef.current = newFilter;
    if (showLogsRef.current) {
      setLogs(
        logsHistoryRef.current
          .filter((l) => newFilter === 'ALL' || l.category === newFilter || l.category === 'SYSTEM')
      );
    }
  };

  // Initialize Location Engine and start watching GPS on mount
  useEffect(() => {
    let subscription = null;

    async function startLocationTracking() {
      try {
        LocationEngine.initialize();
        EpisodeEngine.initialize();

        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          addLog('[GPS] Location permission denied — geofencing disabled.', 'SYSTEM');
          return;
        }

        subscription = await Location.watchPositionAsync({
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 3000,
          distanceInterval: 5
        }, (loc) => {
          if (loc && loc.coords) {
            LocationEngine.onLocationUpdate({
              latitude: loc.coords.latitude,
              longitude: loc.coords.longitude,
              accuracy: loc.coords.accuracy
            });
          }
        });

        addLog('[GPS] Geofencing active. Watching location.', 'SYSTEM');
      } catch (err) {
        console.warn('[Location] Tracking initialization failed:', err);
        addLog(`[GPS] Initialization failed: ${err.message}`, 'SYSTEM');
      }
    }

    startLocationTracking();

    const watchdogInterval = setInterval(() => {
      LocationEngine.checkWatchdog();
    }, 3000);

    return () => {
      if (subscription) subscription.remove();
      clearInterval(watchdogInterval);
    };
  }, []);

  // Keyboard offset animation listeners
  useEffect(() => {
    const showSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => {
        const targetOffset = Platform.OS === 'android' ? 100 : 0;
        Animated.timing(keyboardOffset, {
          toValue: targetOffset,
          duration: Platform.OS === 'ios' ? e.duration : 150,
          useNativeDriver: true,
        }).start();
      }
    );
    const hideSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      (e) => {
        Animated.timing(keyboardOffset, {
          toValue: 0,
          duration: Platform.OS === 'ios' ? e.duration : 150,
          useNativeDriver: true,
        }).start();
      }
    );

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  // Initialize hooks
  const {
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
  } = useBle(activeTab, addLog);

  const {
    contacts,
    templates,
    dbSettings,
    twilioBalance,
    twilioBalanceError,
    globalConstraintWarning,
    loadDatabaseData,
    checkTwilioBalance,
    handleSaveContact,
    handleDeleteContact,
    handleSaveTemplate,
    handleDeleteTemplate,
    handleToggleGlobalChannel,
    setDbSettings,
  } = useDatabase(addLog);

  const handleRunReclustering = () => {
    try {
      const ver = BackgroundServices.runClusteringService(3);
      if (ver) {
        addLog(`[CLUSTERING] Reclustering run successful. Generated Version ${ver} centroids.`, 'SYSTEM');
        // Start background batch reassignment
        let hasMore = true;
        const interval = setInterval(() => {
          try {
            hasMore = BackgroundServices.runHistoricalReassignment(100);
            if (!hasMore) {
              clearInterval(interval);
              addLog('[CLUSTERING] Historical reassignment completed successfully.', 'SYSTEM');
            } else {
              addLog('[CLUSTERING] Historical reassignment batch completed.', 'SYSTEM');
            }
          } catch (err) {
            clearInterval(interval);
            addLog(`[CLUSTERING] Reassignment error: ${err.message}`, 'SYSTEM');
          }
        }, 1000);
      } else {
        addLog(`[CLUSTERING] Reclustering skipped or aborted by validation gates.`, 'SYSTEM');
      }
    } catch (e) {
      addLog(`[CLUSTERING] Failed: ${e.message}`, 'SYSTEM');
    }
  };

  const handleRunCleanup = () => {
    try {
      const stats = BackgroundServices.runDatabaseCleanup();
      if (stats) {
        addLog(`[DB] Database cleanup: deleted ${stats.deletedObservations} observations, ${stats.deletedTimelines} timelines, and ${stats.deletedInferences} inferences.`, 'SYSTEM');
      }
    } catch (e) {
      addLog(`[DB] Cleanup failed: ${e.message}`, 'SYSTEM');
    }
  };

  const {
    showAlertModal,
    alertCountdown,
    isDispatched,
    beepingFlash,
    dispatchStatuses,
    cooldownActive,
    cooldownActiveRef,
    cooldownTime,
    pinEntryMode,
    enteredPin,
    pinError,
    setPinEntryMode,
    setEnteredPin,
    setPinError,
    triggerEmergencyPreAlert,
    executeEmergencyDispatch,
    cancelEmergency,
    setCooldownActive,
    setCooldownTime,
  } = useEmergency({
    dbSettings,
    contacts,
    templates,
    sendBleCommand,
    currentPacket,
    setCurrentPacket,
    wearConfidence,
    setWearConfidence,
    setBatteryPct,
    setUptime,
    addLog,
    addLogs,
    checkTwilioBalance,
    connectionState,
    alertTriggeredRef,
  });

  const lastLoggedScoreRef = useRef(-1);

  // ===========================================================================
  // TIMER LOOP 1: 3-Second Context Inference (Heavy DB Operations)
  // Decoupled from the 2 Hz BLE stream to prevent lagging.
  // Periodically extracts recent observations/episodes and compares them
  // against historical 30-day baseline data to compute familiarity (L1, L2, L3).
  // ===========================================================================
  useEffect(() => {
    const timer = setInterval(() => {
      // Build current telemetry packet from refs to avoid capture of stale state
      const packetForEngine = { ...currentPacketRef.current, wearConfidence: wearConfidenceRef.current };
      try {
        // Query SQLite and run spatial/temporal/behavioral comparison
        const famResult = ContextEngine.runInference(packetForEngine);
        setFamLevel1(famResult.familiarityLevel1);
        setFamLevel2(famResult.familiarityLevel2);
        setFamFinal(famResult.familiarityFinal);
      } catch (err) {
        console.warn('[Context Timer] Inference failed:', err);
      }
    }, 3000); // 3-second tick rate

    return () => clearInterval(timer); // Release timer on unmount
  }, []);

  // ===========================================================================
  // EVALUATION LOOP 2: 2 Hz Threat Score Recalculation (Lightweight Math Only)
  // Runs whenever a new BLE feature packet is received, wear confidence updates,
  // or the 3-second familiarity score changes.
  // Performs the step-by-step threat scaling, applies duration/motion weights,
  // logs results, and triggers the 15-second pre-alert countdown if score >= 72%.
  // ===========================================================================
  useEffect(() => {
    // Merge packet fields and wear confidence state
    const packetForEngine = { ...currentPacket, wearConfidence };

    // Compute base threat score and explanation logs
    const { score, explanation } = computeThreatScoreDetailed(packetForEngine, {
      familiarityScore: famFinal,
    });

    let finalScore = score;
    // Suppress threat score by 40% if the user recently cancelled an alert
    if (cooldownActive || (cooldownActiveRef && cooldownActiveRef.current)) {
      finalScore *= 0.6;
    }

    setThreatScore(finalScore);

    // Logging throttle: only print to logs if score changed by at least 2%
    const scoreDelta = Math.abs(finalScore - lastLoggedScoreRef.current);
    if (scoreDelta >= 0.02 || lastLoggedScoreRef.current < 0) {
      lastLoggedScoreRef.current = finalScore;
      if (explanation && explanation.length > 0) {
        const batch = explanation.map(msg => ({ message: msg, category: 'CONTEXT' }));
        batch.push({ message: `▶ Final threat: ${Math.round(finalScore * 100)}% (TinyML raw: ${currentPacket.anomalyScore}/255)`, category: 'CONTEXT' });
        batch.push({ message: '─────────────────────────────────────────', category: 'CONTEXT' });
        addLogs(batch); // Log to local diagnostics terminal
      }
    }

    // Trigger alert modal if:
    //  - Threat score >= 72%
    //  - No alert is currently active (alertTriggeredRef.current is false)
    //  - Alerts are not already dispatched (isDispatched is false)
    //  - We are not in the 20-second post-cancel cooldown
    if (finalScore >= 0.72 && !alertTriggeredRef.current && !isDispatched && !cooldownActive && !(cooldownActiveRef && cooldownActiveRef.current)) {
      alertTriggeredRef.current = true; // Lock immediately to prevent double-triggers
      addLog(`🚨 EMERGENCY THREAT DETECTED: Score ${Math.round(finalScore * 100)}% >= 72%. Triggering countdown.`, 'SYSTEM');
      triggerEmergencyPreAlert(); // Show countdown UI
    }
  }, [currentPacket, wearConfidence, famFinal, cooldownActive]);

  const renderedLogs = useMemo(() => {
    if (!showLogs) return null;
    const filtered = logs.filter((l) => logFilter === 'ALL' || l.category === logFilter).slice(0, 50);
    if (filtered.length === 0) {
      return (
        <Text style={styles.terminalEmptyText}>
          No {logFilter === 'ALL' ? '' : logFilter + ' '}logs yet. Start streaming or connect BLE.
        </Text>
      );
    }
    return filtered.map((entry) => {
      const catColor = {
        TINYML: '#60A5FA',
        CONTEXT: '#A78BFA',
        RAW: '#FCD34D',
        SYSTEM: '#34D399',
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
    });
  }, [logs, logFilter, showLogs]);

  const renderedGraph = useMemo(() => {
    if (activeTab !== 'DASHBOARD') return null;
    return (
      <View style={styles.graphContainer}>
        <Svg height="140" width={width - 48}>
          {/* Threshold line at 128 (middle axis) */}
          <Line x1="0" y1="70" x2={width - 48} y2="70" stroke="#EF4444" strokeWidth="1.5" strokeDasharray="4,4" />
          <SvgText style={styles.thresholdTextLabel}>anomaly threshold (128)</SvgText>

          {/* Draw raw resultant accel stream (blue) */}
          {streamData.length > 1 && (
            <Path
              d={streamData.reduce((path, p, idx) => {
                const x = (idx / 49) * (width - 48);
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
    );
  }, [streamData, width, activeTab]);

  const threatLevel = getThreatLevel(threatScore);

  return (
    <View style={[styles.mainContainer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <StatusBar style="light" />
      {globalConstraintWarning && (
        <View style={styles.floatingWarning}>
          <Text style={styles.floatingWarningText}>
            ⚠️ At least one emergency response channel must be active to ensure your safety.
          </Text>
        </View>
      )}
      <ScrollView contentContainerStyle={styles.scrollContent}>

        {/* Twilio Balance Low/Exhausted Warnings */}
        {twilioBalance !== null && parseFloat(twilioBalance) < 0.50 && parseFloat(twilioBalance) > 0 && (
          <View style={[styles.errorAlert, { marginBottom: 12, backgroundColor: 'rgba(245, 158, 11, 0.15)', borderColor: '#F59E0B' }]}>
            <Text style={[styles.errorAlertText, { color: '#F59E0B' }]}>
              ⚠️ Twilio Credit Low: ${parseFloat(twilioBalance).toFixed(2)} remaining. Messages may fail soon!
            </Text>
          </View>
        )}
        {twilioBalance !== null && parseFloat(twilioBalance) === 0 && (
          <View style={[styles.errorAlert, { marginBottom: 12, backgroundColor: 'rgba(239, 68, 68, 0.15)', borderColor: '#EF4444' }]}>
            <Text style={[styles.errorAlertText, { color: '#EF4444' }]}>
              🚨 Twilio Credit Exhausted! SMS/WhatsApp alert dispatch will fail!
            </Text>
          </View>
        )}

        {/* App Navigation Tab Bar */}
        <View style={styles.tabContainer}>
          {[
            { id: 'DASHBOARD', label: '🏠 Dash' },
            { id: 'CONTACTS', label: '👥 Contacts' },
            { id: 'TEMPLATES', label: '📝 Templates' },
            { id: 'SETTINGS', label: '⚙️ Settings' },
            { id: 'DATABASE', label: '📁 DB' }
          ].map((tab) => (
            <TouchableOpacity
              delayPressIn={0}
              key={tab.id}
              style={[styles.tabButton, activeTab === tab.id && styles.tabButtonActive]}
              onPress={() => setActiveTab(tab.id)}
            >
              <Text style={[styles.tabButtonText, activeTab === tab.id && styles.tabButtonTextActive]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {activeTab === 'DASHBOARD' && (
          <DashboardTab
            connectionState={connectionState}
            batteryPct={batteryPct}
            uptime={uptime}
            wearConfidence={wearConfidence}
            currentPacket={currentPacket}
            threatScore={threatScore}
            cooldownActive={cooldownActive}
            cooldownTime={cooldownTime}
            famLevel1={famLevel1}
            famLevel2={famLevel2}
            famFinal={famFinal}
            isStreaming={isStreaming}
            toggleStreaming={toggleStreaming}
            renderedGraph={renderedGraph}
            bleError={bleError}
            startScanning={startScanning}
            devices={devices}
            connectToDevice={connectToDevice}
            stopScanning={stopScanning}
            activeDevice={activeDevice}
            handleDisconnect={handleDisconnect}
            logs={logs}
            logFilter={logFilter}
            showLogs={showLogs}
            setShowLogs={setShowLogs}
            setLogs={setLogs}
            handleFilterChange={handleFilterChange}
            logsHistoryRef={logsHistoryRef}
            renderedLogs={renderedLogs}
            threatLevel={threatLevel}
          />
        )}

        {activeTab === 'CONTACTS' && (
          <ContactsTab
            contacts={contacts}
            templates={templates}
            setEditingContact={setEditingContact}
            setShowContactModal={setShowContactModal}
            handleDeleteContact={handleDeleteContact}
          />
        )}

        {activeTab === 'TEMPLATES' && (
          <TemplatesTab
            templates={templates}
            setEditingTemplate={setEditingTemplate}
            setShowTemplateModal={setShowTemplateModal}
            handleDeleteTemplate={handleDeleteTemplate}
          />
        )}

        {activeTab === 'SETTINGS' && (
          <SettingsTab
            dbSettings={dbSettings}
            saveSetting={saveSetting}
            setDbSettings={setDbSettings}
            twilioBalance={twilioBalance}
            twilioBalanceError={twilioBalanceError}
            checkTwilioBalance={checkTwilioBalance}
            handleToggleGlobalChannel={handleToggleGlobalChannel}
            handleRunReclustering={handleRunReclustering}
            handleRunCleanup={handleRunCleanup}
          />
        )}

        {activeTab === 'DATABASE' && (
          <DatabaseTab />
        )}

      </ScrollView>

      {/* Emergency Overlay Modal */}
      <Modal visible={showAlertModal} transparent animationType="fade">
        <View style={[styles.overlayBg, beepingFlash && styles.overlayBgFlash]}>
          <View style={[styles.overlayContainer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>

            {pinEntryMode ? (
              // PIN Entry screen lock
              <View style={styles.alignCenter}>
                <Text style={styles.overlayAlertHeader}>🔒 PIN VERIFICATION</Text>
                <Text style={styles.overlaySubheader}>Resolve threat or authorize dismissal.</Text>

                {/* Dots representation of entered PIN */}
                <View style={{ flexDirection: 'row', gap: 16, marginVertical: 32 }}>
                  {[0, 1, 2, 3].map((idx) => (
                    <View key={idx} style={{
                      width: 20, height: 20, borderRadius: 10,
                      backgroundColor: enteredPin.length > idx ? '#FFFFFF' : 'transparent',
                      borderWidth: 2, borderColor: '#FFFFFF'
                    }} />
                  ))}
                </View>

                {pinError && (
                  <Text style={[styles.errorAlertText, { color: '#FECACA', marginBottom: 16 }]}>
                    ❌ {pinError}
                  </Text>
                )}

                {/* Keypad Grid layout */}
                <View style={{ width: 280, gap: 12 }}>
                  {[
                    ['1', '2', '3'],
                    ['4', '5', '6'],
                    ['7', '8', '9'],
                    ['CLR', '0', 'ESC']
                  ].map((row, rIdx) => (
                    <View key={rIdx} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      {row.map((btn) => (
                        <TouchableOpacity
                          delayPressIn={0}
                          key={btn}
                          style={{
                            width: 75, height: 75, borderRadius: 38,
                            backgroundColor: 'rgba(255, 255, 255, 0.1)',
                            borderColor: 'rgba(255, 255, 255, 0.2)',
                            borderWidth: 1,
                            alignItems: 'center', justifyContent: 'center'
                          }}
                          onPress={async () => {
                            if (btn === 'CLR') {
                              setEnteredPin(prev => prev.slice(0, -1));
                              setPinError(null);
                            } else if (btn === 'ESC') {
                              setPinEntryMode(false);
                              setEnteredPin('');
                              setPinError(null);
                            } else {
                              const nextPin = enteredPin + btn;
                              if (nextPin.length <= 4) {
                                setEnteredPin(nextPin);
                                setPinError(null);
                              }

                              if (nextPin.length === 4) {
                                if (nextPin === dbSettings.real_pin) {
                                  cancelEmergency();
                                } else if (nextPin === dbSettings.fake_pin) {
                                  // Fake PIN - silent alert
                                  executeEmergencyDispatch(true);
                                  setShowAlertModal(false);
                                } else {
                                  Vibration.vibrate(200);
                                  setEnteredPin('');
                                  setPinError('Incorrect Security PIN');
                                }
                              }
                            }
                          }}
                        >
                          <Text style={{ color: '#FFFFFF', fontSize: 20, fontWeight: 'bold' }}>{btn}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  ))}
                </View>
              </View>
            ) : !isDispatched ? (
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

                <TouchableOpacity delayPressIn={0} style={styles.cancelBtn} onPress={() => {
                  if (dbSettings.pin_enabled === '1') {
                    setPinEntryMode(true);
                    setEnteredPin('');
                    setPinError(null);
                  } else {
                    cancelEmergency();
                  }
                }}>
                  <Text style={styles.cancelBtnText}>I'M SAFE (CANCEL ALERT)</Text>
                </TouchableOpacity>

                <TouchableOpacity delayPressIn={0} style={styles.helpNowBtn} onPress={() => executeEmergencyDispatch(false)}>
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

                <Text style={styles.dispatchedSubheader}>Executing parallel transmission to emergency contacts...</Text>

                {/* Real-time dispatch status report card */}
                <ScrollView style={[styles.dispatchReportCard, { maxHeight: 180, marginBottom: 24 }]} contentContainerStyle={{ gap: 10 }}>
                  {dispatchStatuses.map((conStatus) => (
                    <View key={conStatus.contactId} style={{ borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)', paddingBottom: 6 }}>
                      <Text style={[styles.contactName, { color: '#FFFFFF', marginBottom: 4 }]}>
                        👤 {conStatus.name}
                      </Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                        {conStatus.channels.map((chan, chIdx) => {
                          const badgeBg =
                            chan.status === 'Sent' || chan.status === 'Handed-off' ? '#10B98133' :
                              chan.status === 'Sending' ? '#F59E0B33' :
                                chan.status === 'Failed' ? '#EF444433' : 'rgba(255,255,255,0.05)';
                          const badgeBorder =
                            chan.status === 'Sent' || chan.status === 'Handed-off' ? '#10B981' :
                              chan.status === 'Sending' ? '#F59E0B' :
                                chan.status === 'Failed' ? '#EF4444' : 'rgba(255,255,255,0.1)';
                          const badgeText =
                            chan.status === 'Sent' ? '✓ Sent' :
                              chan.status === 'Handed-off' ? '✓ Opened' :
                                chan.status === 'Failed' ? `✗ Fail: ${chan.error}` :
                                  chan.status === 'Sending' ? 'Sending...' : 'Queued';

                          return (
                            <View key={chIdx} style={{
                              paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6,
                              backgroundColor: badgeBg, borderColor: badgeBorder, borderWidth: 1
                            }}>
                              <Text style={{ color: badgeBorder, fontSize: 10, fontWeight: '700' }}>
                                {chan.type}: {badgeText}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    </View>
                  ))}
                </ScrollView>

                <TouchableOpacity delayPressIn={0} style={[styles.cancelBtn, { backgroundColor: '#10B981', borderColor: '#10B981' }]} onPress={() => {
                  if (dbSettings.pin_enabled === '1') {
                    setPinEntryMode(true);
                    setEnteredPin('');
                    setPinError(null);
                  } else {
                    cancelEmergency();
                  }
                }}>
                  <Text style={styles.cancelBtnText}>DISMISS (RESOLVE THREAT)</Text>
                </TouchableOpacity>
              </View>
            )}

          </View>
        </View>
      </Modal>

      <ContactFormModal
        showContactModal={showContactModal}
        setShowContactModal={setShowContactModal}
        editingContact={editingContact}
        setEditingContact={setEditingContact}
        handleSaveContact={() => handleSaveContact(editingContact, setEditingContact, setShowContactModal)}
        templates={templates}
        keyboardOffset={keyboardOffset}
      />

      <TemplateFormModal
        showTemplateModal={showTemplateModal}
        setShowTemplateModal={setShowTemplateModal}
        editingTemplate={editingTemplate}
        setEditingTemplate={setEditingTemplate}
        handleSaveTemplate={() => handleSaveTemplate(editingTemplate, setEditingTemplate, setShowTemplateModal)}
        templateSelection={templateSelection}
        setTemplateSelection={setTemplateSelection}
        keyboardOffset={keyboardOffset}
      />

    </View>
  );
}
