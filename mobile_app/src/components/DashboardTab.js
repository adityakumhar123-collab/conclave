import React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import styles from './styles';

const DashboardTab = React.memo(({
  connectionState,
  batteryPct,
  uptime,
  wearConfidence,
  currentPacket,
  threatScore,
  cooldownActive,
  cooldownTime,
  location,
  setLocation,
  timeOfDay,
  setTimeOfDay,
  postAnomalyStillness,
  setPostAnomalyStillness,
  isStreaming,
  toggleStreaming,
  renderedGraph,
  bleError,
  startScanning,
  devices,
  connectToDevice,
  stopScanning,
  activeDevice,
  handleDisconnect,
  logs,
  logFilter,
  showLogs,
  setShowLogs,
  setLogs,
  handleFilterChange,
  logsHistoryRef,
  renderedLogs,
  threatLevel
}) => {
  return (
    <>
      {/* Header - Connection Panel */}
      <View style={styles.glassHeader}>
        <View>
          <Text style={styles.subtext}>SafeBand Connection</Text>
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

      {/* BLE Scanning Control Panel */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Bluetooth Device Scanner</Text>
        {bleError && (
          <View style={styles.errorAlert}>
            <Text style={styles.errorAlertText}>⚠️ {bleError}</Text>
          </View>
        )}

        {connectionState === 'DISCONNECTED' && (
          <TouchableOpacity delayPressIn={0} style={styles.scanActionBtn} onPress={startScanning}>
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
                  <TouchableOpacity delayPressIn={0} style={styles.bleDeviceConnectBtn} onPress={() => connectToDevice(dev.id)}>
                    <Text style={styles.bleDeviceConnectText}>Connect</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}

            <TouchableOpacity delayPressIn={0} style={[styles.scanActionBtn, { backgroundColor: '#EF4444', marginTop: 12 }]} onPress={stopScanning}>
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
            <TouchableOpacity delayPressIn={0} style={[styles.scanActionBtn, { backgroundColor: '#EF4444', marginTop: 12 }]} onPress={handleDisconnect}>
              <Text style={styles.scanActionBtnText}>🔌 Disconnect Device</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

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
          <TouchableOpacity delayPressIn={0} onPress={toggleStreaming}>
            <Text style={styles.linkText}>{isStreaming ? 'Pause Stream' : 'Resume Stream'}</Text>
          </TouchableOpacity>
        </View>

        {/* SVG canvas for drawing streams */}
        {renderedGraph}
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
              delayPressIn={0}
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
              delayPressIn={0}
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
            delayPressIn={0}
            style={[styles.toggleBtn, postAnomalyStillness && styles.toggleBtnActive]}
            onPress={() => setPostAnomalyStillness(!postAnomalyStillness)}
          >
            <Text style={styles.toggleBtnText}>{postAnomalyStillness ? 'ACTIVE (+0.15)' : 'INACTIVE'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ─── Diagnostics / Debug Terminal ─────────────────────────── */}
      <View style={styles.terminalCard}>
        {/* Header row: title + count badge + toggle */}
        <TouchableOpacity
          delayPressIn={0}
          style={styles.terminalHeader}
          onPress={() => {
            const nextShowLogs = !showLogs;
            setShowLogs(nextShowLogs);
            if (nextShowLogs) {
              setLogs(
                logsHistoryRef.current
                  .filter((l) => logFilter === 'ALL' || l.category === logFilter || l.category === 'SYSTEM')
                  .slice(0, 250)
              );
            } else {
              setLogs([]);
            }
          }}
          activeOpacity={0.75}
        >
          <View style={styles.row}>
            <Text style={styles.terminalTitle}>🖥️ Diagnostics Terminal</Text>
            <View style={styles.terminalBadge}>
              <Text style={styles.terminalBadgeText}>{logs.length}</Text>
            </View>
          </View>
          <View style={styles.row}>
            {logsHistoryRef.current.length > 0 && (
              <TouchableOpacity
                delayPressIn={0}
                onPress={(e) => { e.stopPropagation(); setLogs([]); logsHistoryRef.current = []; }}
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
                    delayPressIn={0}
                    key={f}
                    style={[
                      styles.terminalChip,
                      active && { backgroundColor: chipColors[f] + '33', borderColor: chipColors[f] },
                    ]}
                    onPress={() => handleFilterChange(f)}
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
              {renderedLogs}
            </ScrollView>
          </View>
        )}
      </View>
    </>
  );
});

export default DashboardTab;
