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

import { computeThreatScoreDetailed, getThreatLevel } from './src/ContextEngine';

// Modular Component & Styles imports
import ContactsTab from './src/components/ContactsTab';
import TemplatesTab from './src/components/TemplatesTab';
import SettingsTab from './src/components/SettingsTab';
import DashboardTab from './src/components/DashboardTab';
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

  // Environmental context settings (user-modifiable for testing multipliers)
  const [location, setLocation] = useState('UNKNOWN_URBAN'); // 'HOME', 'UNKNOWN_URBAN', 'UNKNOWN_ISOLATED'
  const [timeOfDay, setTimeOfDay] = useState('MORNING'); // 'MORNING', 'NIGHT_RISK', 'LATE_NIGHT', 'DAYTIME'
  const [postAnomalyStillness, setPostAnomalyStillness] = useState(false);

  const [threatScore, setThreatScore] = useState(0.05);

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

  const {
    showAlertModal,
    alertCountdown,
    isDispatched,
    beepingFlash,
    dispatchStatuses,
    cooldownActive,
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
  });

  const lastLoggedScoreRef = useRef(-1);

  // Recalculate threat score when packet or context variables change
  useEffect(() => {
    const packetForEngine = { ...currentPacket, wearConfidence };

    const { score, explanation } = computeThreatScoreDetailed(packetForEngine, {
      location,
      timeOfDay,
      postAnomalyStillness,
    });

    let finalScore = score;
    if (cooldownActive) {
      finalScore *= 0.6;
    }

    setThreatScore(finalScore);

    const scoreDelta = Math.abs(finalScore - lastLoggedScoreRef.current);
    if (scoreDelta >= 0.02 || lastLoggedScoreRef.current < 0) {
      lastLoggedScoreRef.current = finalScore;
      if (explanation && explanation.length > 0) {
        const batch = explanation.map(msg => ({ message: msg, category: 'CONTEXT' }));
        batch.push({ message: `▶ Final threat: ${Math.round(finalScore * 100)}% (TinyML raw: ${currentPacket.anomalyScore}/255)`, category: 'CONTEXT' });
        batch.push({ message: '─────────────────────────────────────────', category: 'CONTEXT' });
        addLogs(batch);
      }
    }

    if (finalScore >= 0.72 && !showAlertModal && !isDispatched) {
      addLog(`🚨 EMERGENCY THREAT DETECTED: Score ${Math.round(finalScore * 100)}% >= 72%. Triggering countdown.`, 'SYSTEM');
      triggerEmergencyPreAlert();
    }
  }, [currentPacket, wearConfidence, location, timeOfDay, postAnomalyStillness, cooldownActive]);

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
            { id: 'SETTINGS', label: '⚙️ Settings' }
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
            location={location}
            setLocation={setLocation}
            timeOfDay={timeOfDay}
            setTimeOfDay={setTimeOfDay}
            postAnomalyStillness={postAnomalyStillness}
            setPostAnomalyStillness={setPostAnomalyStillness}
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
          />
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
