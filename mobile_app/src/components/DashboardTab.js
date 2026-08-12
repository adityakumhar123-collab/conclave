import React, { useState, useEffect, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, ScrollView, Platform, Alert } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';
import styles from './styles';
import { LocationEngine } from '../LocationEngine';

// Jacobi eigenvalue algorithm for symmetric matrix (Covariance matrix)
function jacobiEigenvalue(A, maxIter = 50) {
  const n = A.length;
  const V = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  );

  const mat = A.map(row => [...row]);

  for (let iter = 0; iter < maxIter; iter++) {
    let p = 0;
    let q = 1;
    let maxVal = Math.abs(mat[0][1]);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(mat[i][j]) > maxVal) {
          maxVal = Math.abs(mat[i][j]);
          p = i;
          q = j;
        }
      }
    }

    if (maxVal < 1e-6) break;

    const ap = mat[p][p];
    const aq = mat[q][q];
    const apq = mat[p][q];

    const theta = 0.5 * Math.atan2(2 * apq, aq - ap);
    const c = Math.cos(theta);
    const s = Math.sin(theta);

    mat[p][p] = c * c * ap - 2 * s * c * apq + s * s * aq;
    mat[q][q] = s * s * ap + 2 * s * c * apq + c * c * aq;
    mat[p][q] = 0;
    mat[q][p] = 0;

    for (let i = 0; i < n; i++) {
      if (i !== p && i !== q) {
        const aip = mat[i][p];
        const aiq = mat[i][q];
        mat[i][p] = c * aip - s * aiq;
        mat[p][i] = mat[i][p];
        mat[i][q] = s * aip + c * aiq;
        mat[q][i] = mat[i][q];
      }
    }

    for (let i = 0; i < n; i++) {
      const vip = V[i][p];
      const viq = V[i][q];
      V[i][p] = c * vip - s * viq;
      V[i][q] = s * vip + c * viq;
    }
  }

  const eigenvalues = mat.map((row, i) => row[i]);
  return { eigenvalues, eigenvectors: V };
}

// Compute PCA and project data onto top 2 PCs
function computePCA(data) {
  const N = data.length;
  const D = data[0].length;

  const means = Array(D).fill(0);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < D; j++) {
      means[j] += data[i][j];
    }
  }
  for (let j = 0; j < D; j++) {
    means[j] /= N;
  }

  const centered = data.map(row => row.map((val, j) => val - means[j]));

  const Cov = Array.from({ length: D }, () => Array(D).fill(0));
  for (let i = 0; i < D; i++) {
    for (let j = i; j < D; j++) {
      let sum = 0;
      for (let k = 0; k < N; k++) {
        sum += centered[k][i] * centered[k][j];
      }
      const val = sum / (N - 1 || 1);
      Cov[i][j] = val;
      Cov[j][i] = val;
    }
  }

  const { eigenvalues, eigenvectors } = jacobiEigenvalue(Cov);

  const indexedEigenvalues = eigenvalues.map((val, idx) => ({ val: Math.abs(val), idx }));
  indexedEigenvalues.sort((a, b) => b.val - a.val);

  const pc1Idx = indexedEigenvalues[0].idx;
  const pc2Idx = indexedEigenvalues[1].idx;

  const pc1 = eigenvectors.map(row => row[pc1Idx]);
  const pc2 = eigenvectors.map(row => row[pc2Idx]);

  return centered.map(row => {
    let x = 0;
    let y = 0;
    for (let j = 0; j < D; j++) {
      x += row[j] * pc1[j];
      y += row[j] * pc2[j];
    }
    return { x, y };
  });
}

const DashboardTab = React.memo(({
  connectionState,
  batteryPct,
  uptime,
  wearConfidence,
  currentPacket,
  threatScore,
  cooldownActive,
  cooldownTime,
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
  threatLevel,
  threatScore3s = 0.0,
  threatScore3m = 0.0,
  threatScore5m = 0.0,
  famLevel1 = 1.0,
  famLevel2 = 1.0,
  famFinal = 1.0,
  onTestAlert
}) => {
  const [showPca, setShowPca] = useState(false);
  const [embeddingHistory, setEmbeddingHistory] = useState([]);
  const lastSeqIdRef = useRef(null);
  const lastEmbStrRef = useRef(null);

  // Accumulate embedding history up to 50 samples (only when PCA is toggled ON)
  useEffect(() => {
    if (!showPca) return; // Stop background accumulation completely when toggled OFF for zero performance overhead

    if (currentPacket && currentPacket.motionEmbedding && currentPacket.motionEmbedding.length > 0) {
      const embStr = JSON.stringify(currentPacket.motionEmbedding);
      // Double check sequenceId and array values to avoid duplicates
      if (currentPacket.sequenceId !== lastSeqIdRef.current || embStr !== lastEmbStrRef.current) {
        lastSeqIdRef.current = currentPacket.sequenceId;
        lastEmbStrRef.current = embStr;

        setEmbeddingHistory(prev => {
          const next = [...prev, {
            embedding: currentPacket.motionEmbedding,
            motionState: currentPacket.motionState,
            anomalyScore: currentPacket.anomalyScore,
            id: Date.now() + Math.random().toString()
          }];
          if (next.length > 50) {
            next.shift();
          }
          return next;
        });
      }
    }
  }, [currentPacket, showPca]);

  // Clear history on disconnect or toggle off
  useEffect(() => {
    if (connectionState === 'DISCONNECTED') {
      setEmbeddingHistory([]);
      lastSeqIdRef.current = null;
      lastEmbStrRef.current = null;
    }
  }, [connectionState]);

  // Reset PCA history (Refresh)
  const handleResetPca = () => {
    setEmbeddingHistory([]);
    lastSeqIdRef.current = null;
    lastEmbStrRef.current = null;
  };

  // Compute PCA points whenever the history changes (only when PCA is toggled ON)
  const pcaPoints = useMemo(() => {
    if (!showPca || embeddingHistory.length < 20) return [];
    try {
      const data = embeddingHistory.map(h => h.embedding);
      const projected = computePCA(data);

      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      projected.forEach(p => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      });

      const rangeX = maxX - minX || 1e-4;
      const rangeY = maxY - minY || 1e-4;

      return projected.map((p, idx) => {
        const h = embeddingHistory[idx];
        const scaledX = ((p.x - minX) / rangeX) * 180 + 40;
        const scaledY = 160 - ((p.y - minY) / rangeY) * 120;
        return {
          id: h.id,
          x: scaledX,
          y: scaledY,
          motionState: h.motionState,
          anomalyScore: h.anomalyScore,
          isNewest: idx === embeddingHistory.length - 1,
          opacity: 0.15 + 0.85 * (idx / (embeddingHistory.length - 1 || 1)),
        };
      });
    } catch (err) {
      console.warn("PCA projection failed:", err);
      return [];
    }
  }, [embeddingHistory, showPca]);

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
              width: `${Math.min((currentPacket.anomalyScore / 1.1214) * 100, 100)}%`,
              borderRadius: 11,
              backgroundColor:
                wearConfidence < 40 ? '#64748B' :
                  currentPacket.anomalyScore > 1.10 ? '#B91C1C' :
                    currentPacket.anomalyScore > 1.013 ? '#EF4444' :
                      currentPacket.anomalyScore > 0.60 ? '#F59E0B' : '#10B981',
            }} />
            {/* Threshold marker at 1.01309 / 1.1214 = 90.3% */}
            <View style={{ position: 'absolute', left: '90.3%', top: 0, width: 2, height: 22, backgroundColor: '#FFFFFF', opacity: 0.6 }} />
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
            <Text style={{ color: '#64748B', fontSize: 10 }}>0.000 (Normal)</Text>
            <Text style={{ color: '#FFFFFF', fontSize: 11, fontWeight: 'bold' }}>
              {currentPacket.anomalyScore.toFixed(4)} / 1.1214
              {wearConfidence < 40 ? ' ✓ Unworn' : (currentPacket.anomalyScore > 1.01309 ? ' ⚠️ FLAGGED' : ' ✓ Normal')}
            </Text>
            <Text style={{ color: '#64748B', fontSize: 10 }}>1.1214 (Max)</Text>
          </View>
        </View>
        {/* Motion state badge row */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
          {[
            { bit: 0, label: 'STILL', color: '#64748B' },
            { bit: 1, label: 'PERIODIC', color: '#3B82F6' },
            { bit: 2, label: 'APERIODIC', color: '#F59E0B' },
            { bit: 3, label: 'HIGH-IMPACT', color: '#EF4444' },
            { bit: 4, label: 'RESTRAINED', color: '#8B5CF6' },
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

        {/* 16-Dimensional Motion Embedding Visualisation */}
        {currentPacket.motionEmbedding && currentPacket.motionEmbedding.length > 0 && (
          <View style={{
            marginTop: 10,
            padding: 8,
            backgroundColor: 'rgba(255,255,255,0.02)',
            borderRadius: 8,
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.05)'
          }}>
            <Text style={{ color: '#94A3B8', fontSize: 10, fontWeight: '700', marginBottom: 4 }}>🧬 Live Motion Embedding (16-dim):</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
              {currentPacket.motionEmbedding.map((val, idx) => (
                <View key={idx} style={{
                  minWidth: 26,
                  paddingVertical: 2,
                  backgroundColor: 'rgba(16, 185, 129, 0.05)',
                  borderRadius: 4,
                  borderWidth: 1,
                  borderColor: 'rgba(16, 185, 129, 0.2)',
                  alignItems: 'center'
                }}>
                  <Text style={{ color: '#10B981', fontSize: 9, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', fontWeight: 'bold' }}>
                    {val >= 0 ? `+${val.toFixed(2)}` : val.toFixed(2)}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}
      </View>

      {/* Standalone Card: PCA Space */}
      <View style={styles.card}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={styles.cardTitle}>🧬 Live Motion PCA Space</Text>
          <TouchableOpacity
            onPress={() => setShowPca(!showPca)}
            style={{
              backgroundColor: 'rgba(255,255,255,0.06)',
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.1)'
            }}
          >
            <Text style={{ color: '#E2E8F0', fontSize: 10, fontWeight: '700' }}>
              {showPca ? 'Hide PCA Plot ✕' : 'Show PCA Plot 📊'}
            </Text>
          </TouchableOpacity>
        </View>

        {showPca && (
          <View style={{ marginTop: 12 }}>
            {embeddingHistory.length < 20 ? (
              <View style={{ paddingVertical: 20, alignItems: 'center' }}>
                <ActivityIndicator size="small" color="#10B981" />
                <Text style={{ color: '#94A3B8', fontSize: 11, marginTop: 8, textAlign: 'center' }}>
                  Gathering motion embeddings...
                </Text>
                <Text style={{ color: '#64748B', fontSize: 10, marginTop: 2 }}>
                  {embeddingHistory.length} / 20 samples minimum
                </Text>
                {/* Horizontal progress bar */}
                <View style={{ width: '80%', height: 4, backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 2, marginTop: 8, overflow: 'hidden' }}>
                  <View style={{ width: `${(embeddingHistory.length / 20) * 100}%`, height: '100%', backgroundColor: '#10B981' }} />
                </View>
              </View>
            ) : (
              <View>
                <View style={{
                  backgroundColor: 'rgba(0,0,0,0.2)',
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: 'rgba(255,255,255,0.05)',
                  alignItems: 'center',
                  padding: 10
                }}>
                  <Svg height="200" width="260">
                    {/* Grid lines */}
                    <Line x1="30" y1="30" x2="230" y2="30" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
                    <Line x1="30" y1="100" x2="230" y2="100" stroke="rgba(255,255,255,0.05)" strokeWidth="1" strokeDasharray="4 4" />
                    <Line x1="30" y1="170" x2="230" y2="170" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />

                    <Line x1="30" y1="30" x2="30" y2="170" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
                    <Line x1="130" y1="30" x2="130" y2="170" stroke="rgba(255,255,255,0.05)" strokeWidth="1" strokeDasharray="4 4" />
                    <Line x1="230" y1="30" x2="230" y2="170" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />

                    {/* Projected points */}
                    {pcaPoints.map((pt) => {
                      let color = '#10B981'; // default green
                      if (pt.motionState & (1 << 0)) color = '#64748B'; // still
                      else if (pt.motionState & (1 << 3)) color = '#EF4444'; // high-impact
                      else if (pt.motionState & (1 << 1)) color = '#3B82F6'; // periodic
                      else if (pt.motionState & (1 << 2)) color = '#F59E0B'; // aperiodic
                      else if (pt.motionState & (1 << 4)) color = '#8B5CF6'; // restrained

                      return (
                        <Circle
                          key={pt.id}
                          cx={pt.x}
                          cy={pt.y}
                          r={pt.isNewest ? 7 : 4}
                          fill={color}
                          opacity={pt.opacity}
                          stroke={pt.isNewest ? '#FFFFFF' : 'none'}
                          strokeWidth={pt.isNewest ? 1.5 : 0}
                        />
                      );
                    })}
                  </Svg>
                </View>

                {/* Legend & stats */}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 10 }}>
                  {[
                    { label: 'Still', color: '#64748B' },
                    { label: 'Periodic', color: '#3B82F6' },
                    { label: 'Aperiodic', color: '#F59E0B' },
                    { label: 'High-Impact', color: '#EF4444' },
                    { label: 'Restrained', color: '#8B5CF6' }
                  ].map(({ label, color }) => (
                    <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
                      <Text style={{ color: '#64748B', fontSize: 10 }}>{label}</Text>
                    </View>
                  ))}
                </View>

                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                  <Text style={{ color: '#64748B', fontSize: 9 }}>
                    Plotted: {embeddingHistory.length} / 50 samples (idle when hidden)
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <TouchableOpacity
                      onPress={handleResetPca}
                      style={{ padding: 4 }}
                    >
                      <Text style={{ color: '#3B82F6', fontSize: 10, fontWeight: '700' }}>🔄 Refresh</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={handleResetPca}
                      style={{ padding: 4 }}
                    >
                      <Text style={{ color: '#EF4444', fontSize: 10, fontWeight: '700' }}>🧹 Clear</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            )}
          </View>
        )}
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

        {/* Three horizontal mini-progress bars */}
        <View style={{ marginTop: 16, gap: 10 }}>
          <Text style={{ color: '#E2E8F0', fontSize: 11, fontWeight: '700' }}>Window Threat Scores Breakdown:</Text>
          
          {/* 3s Window */}
          <View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
              <Text style={{ color: '#94A3B8', fontSize: 10 }}>• 3-Second Window (Live)</Text>
              <Text style={{ color: '#E2E8F0', fontSize: 10, fontWeight: 'bold' }}>{Math.round(threatScore3s * 100)}%</Text>
            </View>
            <View style={{ height: 6, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 3, overflow: 'hidden' }}>
              <View style={{ height: '100%', width: `${threatScore3s * 100}%`, backgroundColor: '#EF4444' }} />
            </View>
          </View>

          {/* 3m Window */}
          <View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
              <Text style={{ color: '#94A3B8', fontSize: 10 }}>• 3-Minute Window (Short-term)</Text>
              <Text style={{ color: '#E2E8F0', fontSize: 10, fontWeight: 'bold' }}>{Math.round(threatScore3m * 100)}%</Text>
            </View>
            <View style={{ height: 6, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 3, overflow: 'hidden' }}>
              <View style={{ height: '100%', width: `${threatScore3m * 100}%`, backgroundColor: '#F59E0B' }} />
            </View>
          </View>

          {/* 5m Window */}
          <View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
              <Text style={{ color: '#94A3B8', fontSize: 10 }}>• 5-Minute Window (Long-term)</Text>
              <Text style={{ color: '#E2E8F0', fontSize: 10, fontWeight: 'bold' }}>{Math.round(threatScore5m * 100)}%</Text>
            </View>
            <View style={{ height: 6, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 3, overflow: 'hidden' }}>
              <View style={{ height: '100%', width: `${threatScore5m * 100}%`, backgroundColor: '#3B82F6' }} />
            </View>
          </View>
        </View>

        {/* Multipliers & context status */}
        <View style={[styles.multiplierList, { marginTop: 14 }]}>
          <Text style={styles.multiplierItem}>
            • Current Location node: {LocationEngine.activeVisit ? `Node #${LocationEngine.activeVisit.location_node_id}` : 'Outside Geofence'}
          </Text>
          <Text style={[styles.multiplierItem, { color: '#60A5FA', fontWeight: 'bold' }]}>
            • Location Familiarity Score: {Math.round(famFinal * 100)}%
          </Text>
          {cooldownActive && (
            <Text style={[styles.multiplierItem, { color: '#3B82F6' }]}>
              • Cooldown Active: Threat score scaled to 60% ({cooldownTime}s remaining)
            </Text>
          )}
        </View>

        {/* Manual Test Alert Button */}
        <TouchableOpacity
          delayPressIn={0}
          onPress={() => {
            if (onTestAlert) {
              onTestAlert();
            } else {
              Alert.alert('Test Alert', 'onTestAlert not wired up yet.');
            }
          }}
          style={{
            marginTop: 16,
            paddingVertical: 12,
            borderRadius: 10,
            backgroundColor: 'rgba(239, 68, 68, 0.12)',
            borderWidth: 1,
            borderColor: '#EF4444',
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#EF4444', fontWeight: '700', fontSize: 13 }}>🚨 Test Alert</Text>
        </TouchableOpacity>
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
                  ALL: '#6B7280',
                  TINYML: '#3B82F6',
                  CONTEXT: '#8B5CF6',
                  SYSTEM: '#10B981',
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
