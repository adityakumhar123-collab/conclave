// =============================================================================
// ContextEngine.js — Behavioral Familiarity Scoring & Threat Assessment
// =============================================================================

import {
  initDatabase,
  getIsoDateString,
  getIsoTimeString
} from './Database.js';
import { LocationEngine } from './LocationEngine.js';
import { MotionEngine } from './MotionEngine.js';

// Helper: Convert time string "HH:MM:SS" to seconds since midnight
export function timeStrToSeconds(tStr) {
  if (!tStr) return 0;
  const parts = tStr.split(':').map(Number);
  const h = parts[0] || 0;
  const m = parts[1] || 0;
  const s = parts[2] || 0;
  return h * 3600 + m * 60 + s;
}

// Helper: Convert seconds since midnight to "HH:MM:SS" time string
export function secondsToTimeStr(sec) {
  const totalSec = Math.max(0, sec);
  const h = Math.floor(totalSec / 3600) % 24;
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Helper: Calculate Haversine distance in meters
export function getHaversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371000;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Fetch observations for a window size (in seconds) ending at timeStr on dateStr
export function fetchWindowObservations(db, dateStr, timeStr, windowSizeSec) {
  const targetSec = timeStrToSeconds(timeStr);
  const startSec = targetSec - windowSizeSec;
  let rows = [];
  try {
    if (startSec >= 0) {
      const startT = secondsToTimeStr(startSec);
      rows = db.getAllSync(`
        SELECT * FROM observations 
        WHERE date = ? AND time >= ? AND time <= ?
        ORDER BY time ASC;
      `, [dateStr, startT, timeStr]);
    } else {
      // Cross midnight boundary
      const prevDateObj = new Date(new Date(dateStr).getTime() - 86400000);
      const prevDateStr = getIsoDateString(prevDateObj);
      const startT = secondsToTimeStr(86400 + startSec);

      const rowsPrev = db.getAllSync(`
        SELECT * FROM observations 
        WHERE date = ? AND time >= ?
        ORDER BY time ASC;
      `, [prevDateStr, startT]);

      const rowsToday = db.getAllSync(`
        SELECT * FROM observations 
        WHERE date = ? AND time <= ?
        ORDER BY time ASC;
      `, [dateStr, timeStr]);

      rows = [...rowsPrev, ...rowsToday];
    }
  } catch (e) {
    console.warn(`[ContextEngine] fetchWindowObservations failed for ${dateStr} at ${timeStr}:`, e);
  }

  return rows.map(r => ({
    ...r,
    cluster_distribution: typeof r.cluster_distribution === 'string' ? JSON.parse(r.cluster_distribution) : r.cluster_distribution,
    reconstruction_scores: typeof r.reconstruction_scores === 'string' ? JSON.parse(r.reconstruction_scores) : r.reconstruction_scores,
    embeddings: typeof r.embeddings === 'string' ? JSON.parse(r.embeddings) : r.embeddings,
    motion_features: typeof r.motion_features === 'string' ? JSON.parse(r.motion_features) : r.motion_features
  }));
}

// Helper: Extract flat arrays of scores, embeddings, and RMS values from observations list
export function extractArraysFromObservations(observations) {
  const scores = [];
  const embeddings = [];
  const rmsValues = [];

  observations.forEach(obs => {
    const obsScores = obs.reconstruction_scores || [];
    const obsEmbeddings = obs.embeddings || [];
    const obsFeatures = obs.motion_features || [];

    scores.push(...obsScores);
    embeddings.push(...obsEmbeddings);
    obsFeatures.forEach(feat => {
      let rms = 0;
      if (feat.twelveFeatures && feat.twelveFeatures.length > 1) {
        rms = feat.twelveFeatures[1];
      } else {
        rms = (feat.peakAccel || 0) / 101.97162;
      }
      rmsValues.push(rms);
    });
  });

  return { scores, embeddings, rmsValues };
}

// Compute Non-History Metrics (Drift, Intensity, Volatility, Persistence, Average Anomaly)
export function computeNonHistoryMetrics(scores, embeddings, rmsValues) {
  if (scores.length === 0) {
    return { A_norm: 0, D_norm: 0, I_norm: 0, V_norm: 0, P_norm: 0, score: 0 };
  }
  const meanAnomaly = scores.reduce((a, b) => a + b, 0) / scores.length;
  const A_norm = Math.min(1.0, Math.max(0.0, meanAnomaly / 1.1214));

  let driftSum = 0;
  let driftCount = 0;
  for (let i = 0; i < embeddings.length - 1; i++) {
    const e1 = embeddings[i];
    const e2 = embeddings[i+1];
    if (e1 && e2) {
      let sumSq = 0;
      for (let j = 0; j < 16; j++) {
        const diff = e1[j] - e2[j];
        sumSq += diff * diff;
      }
      driftSum += Math.sqrt(sumSq);
      driftCount++;
    }
  }
  const avgDrift = driftCount > 0 ? driftSum / driftCount : 0.0;
  const D_norm = Math.min(1.0, Math.max(0.0, avgDrift / 5.0));

  const meanRms = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
  const I_norm = Math.min(1.0, Math.max(0.0, meanRms / 2.0));

  let variance = 0.0;
  if (rmsValues.length > 1) {
    const sqDiffSum = rmsValues.reduce((sum, val) => sum + (val - meanRms) ** 2, 0);
    variance = sqDiffSum / (rmsValues.length - 1);
  }
  const V_norm = Math.min(1.0, Math.max(0.0, variance / 1.5));

  const persistentCount = scores.filter(s => s > 1.01309).length;
  const P_norm = persistentCount / scores.length;

  const score = 0.20 * A_norm + 0.20 * D_norm + 0.15 * I_norm + 0.25 * V_norm + 0.20 * P_norm;

  return { A_norm, D_norm, I_norm, V_norm, P_norm, score };
}

// Bhattacharyya Coefficient between discrete probability distributions
export function computeBhattacharyya(p, q) {
  const keys = new Set([...Object.keys(p || {}), ...Object.keys(q || {})]);
  let sum = 0.0;
  for (const key of keys) {
    const valP = p[key] || 0.0;
    const valQ = q[key] || 0.0;
    sum += Math.sqrt(valP * valQ);
  }
  return sum;
}

// Resolve dominant cluster key of an observation
export function getDominantCluster(obs) {
  if (!obs || !obs.cluster_distribution) return null;
  let maxVal = -1;
  let dominantKey = null;
  for (const [key, val] of Object.entries(obs.cluster_distribution)) {
    if (val > maxVal) {
      maxVal = val;
      dominantKey = key;
    }
  }
  return dominantKey;
}

// Dom cluster sequence similarity
export function computeSequenceSimilarity(seqCurr, seqHist) {
  const N = Math.min(seqCurr.length, seqHist.length);
  if (N === 0) return 0.0;
  let matches = 0;
  for (let i = 1; i <= N; i++) {
    if (seqCurr[seqCurr.length - i] === seqHist[seqHist.length - i]) {
      matches++;
    }
  }
  return matches / N;
}

// Cosine Similarity helper
export function cosineSimilarity(a, b) {
  let dot = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0.0 || normB === 0.0) return 0.0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Compile a 48-dimensional summary vector (mean, std, min, max of 12 features) over observations
export function computeSummary48D(observations) {
  const summaries = [];
  const featureLists = Array.from({ length: 12 }, () => []);

  observations.forEach(obs => {
    const obsFeatures = obs.motion_features || [];
    obsFeatures.forEach(feat => {
      let vector = feat.twelveFeatures;
      if (!vector || vector.length < 12) {
        vector = [
          0, (feat.peakAccel || 0) / 101.97162, 0, 0,
          (feat.zcr || 0) / 255.0, (feat.dominantFreq || 0), (feat.spectralEntropy || 0) / 255.0,
          0, 0, (feat.eigenvalueRatio || 0) / 1000.0, 0, 0
        ];
      }
      for (let i = 0; i < 12; i++) {
        featureLists[i].push(vector[i] || 0.0);
      }
    });
  });

  for (let i = 0; i < 12; i++) {
    const list = featureLists[i];
    if (list.length === 0) {
      summaries.push(0, 0, 0, 0);
      continue;
    }
    const sum = list.reduce((a, b) => a + b, 0);
    const mean = sum / list.length;
    const min = Math.min(...list);
    const max = Math.max(...list);
    const sqDiffSum = list.reduce((a, b) => a + (b - mean) ** 2, 0);
    const std = Math.sqrt(sqDiffSum / list.length);

    summaries.push(mean, std, min, max);
  }

  return summaries;
}

class ContextEngineClass {
  constructor() {
    this.logs = [];
    this.cachedHist3s = 0.0;
    this.cachedHist3m = 0.0;
    this.cachedHist5m = 0.0;
    this.cachedFinal3m = 0.0;
    this.cachedFinal5m = 0.0;
    this.hasHistoryData = false;
  }

  runInference(packet, gpsCoords = null, overrideDate = null, overrideTime = null) {
    this.logs = [];
    const dateStr = overrideDate || getIsoDateString();
    const timeStr = overrideTime || getIsoTimeString();

    this.logs.push(`Assessment started at ${dateStr} ${timeStr}`);

    const db = initDatabase();

    // 1. Fetch current observations of the last 5 minutes (300 seconds)
    const currentWindowObs = fetchWindowObservations(db, dateStr, timeStr, 300);
    if (currentWindowObs.length === 0) {
      this.logs.push("No current observations in SQLite. Skipping history calculation.");
      return {
        familiarityLevel1: 0.0,
        familiarityLevel2: 0.0,
        familiarityLevel3: 0.0,
        familiarityFinal: 0.0,
        explanation: this.logs
      };
    }

    this.logs.push(`Retrieved ${currentWindowObs.length} current observations in the 5m window.`);

    // Extract window lists
    const targetSec = timeStrToSeconds(timeStr);
    const win3sObs = currentWindowObs.filter(o => targetSec - timeStrToSeconds(o.time) <= 3);
    const win3mObs = currentWindowObs.filter(o => targetSec - timeStrToSeconds(o.time) <= 180);
    const win5mObs = currentWindowObs;

    // Get location coordinates for Location Familiarity
    const lat = gpsCoords ? gpsCoords.latitude : (LocationEngine.currentGps ? LocationEngine.currentGps.latitude : null);
    const lon = gpsCoords ? gpsCoords.longitude : (LocationEngine.currentGps ? LocationEngine.currentGps.longitude : null);
    const locFam = (lat !== null && lon !== null) ? LocationEngine.estimateFamiliarity(lat, lon) : 0.0;
    this.logs.push(`On-demand Location Familiarity computed: ${locFam.toFixed(3)}`);

    // Calculate dates list for history
    const dateToday = new Date(dateStr);
    const datesHistory = [
      getIsoDateString(new Date(dateToday.getTime() - 86400000)),       // D-1
      getIsoDateString(new Date(dateToday.getTime() - 86400000 * 7)),   // D-7
      getIsoDateString(new Date(dateToday.getTime() - 86400000 * 15))  // D-15
    ];

    // Windows mapping for calculations
    const windows = [
      { name: '3s', obs: win3sObs, duration: 3 },
      { name: '3m', obs: win3mObs, duration: 180 },
      { name: '5m', obs: win5mObs, duration: 300 }
    ];

    const results = {};
    let validHistFoundTotal = false;

    windows.forEach(w => {
      // Current non-history score
      const currentArrays = extractArraysFromObservations(w.obs);
      const nonHistResult = computeNonHistoryMetrics(currentArrays.scores, currentArrays.embeddings, currentArrays.rmsValues);
      const S_non_hist = nonHistResult.score;

      // Current distribution
      let currDist = {};
      if (w.name === '3s') {
        currDist = w.obs.length > 0 ? w.obs[w.obs.length - 1].cluster_distribution : {};
      } else {
        const keys = new Set();
        w.obs.forEach(o => {
          if (o.cluster_distribution) Object.keys(o.cluster_distribution).forEach(k => keys.add(k));
        });
        keys.forEach(k => {
          const sum = w.obs.reduce((a, b) => a + (b.cluster_distribution[k] || 0.0), 0);
          currDist[k] = sum / w.obs.length;
        });
      }

      // Dominant cluster sequence
      const seqCurr = w.obs.map(o => getDominantCluster(o)).filter(c => c !== null);

      // Fetch history windows
      const historyWindows = [];
      datesHistory.forEach(hDate => {
        const obsHist = fetchWindowObservations(db, hDate, timeStr, w.duration);
        if (obsHist.length > 0) {
          historyWindows.push({ date: hDate, obs: obsHist });
        }
      });

      let S_hist = 0.0;

      if (historyWindows.length > 0) {
        validHistFoundTotal = true;

        // Bhattacharyya Similarity
        let sumBC = 0.0;
        historyWindows.forEach(hw => {
          let histDist = {};
          if (w.name === '3s') {
            histDist = hw.obs[hw.obs.length - 1].cluster_distribution || {};
          } else {
            const keys = new Set();
            hw.obs.forEach(o => {
              if (o.cluster_distribution) Object.keys(o.cluster_distribution).forEach(k => keys.add(k));
            });
            keys.forEach(k => {
              const sum = hw.obs.reduce((a, b) => a + (b.cluster_distribution[k] || 0.0), 0);
              histDist[k] = sum / hw.obs.length;
            });
          }
          sumBC += computeBhattacharyya(currDist, histDist);
        });
        const BC_avg = sumBC / historyWindows.length;

        // Sequence Similarity
        let sumSeq = 0.0;
        historyWindows.forEach(hw => {
          const seqHist = hw.obs.map(o => getDominantCluster(o)).filter(c => c !== null);
          sumSeq += computeSequenceSimilarity(seqCurr, seqHist);
        });
        const Seq_sim = sumSeq / historyWindows.length;

        // Features Similarity
        let Feat_sim = 0.0;
        if (w.name === '3s') {
          const allHistObs = [];
          historyWindows.forEach(hw => allHistObs.push(...hw.obs));
          
          const get12D = (obs) => {
            const feat = obs.motion_features ? obs.motion_features[0] : null;
            if (feat && feat.twelveFeatures && feat.twelveFeatures.length >= 12) {
              return feat.twelveFeatures;
            }
            return [
              0, (feat ? (feat.peakAccel || 0) / 101.97162 : 0), 0, 0,
              (feat ? (feat.zcr || 0) / 255.0 : 0), (feat ? (feat.dominantFreq || 0) : 0), (feat ? (feat.spectralEntropy || 0) / 255.0 : 0),
              0, 0, (feat ? (feat.eigenvalueRatio || 0) / 1000.0 : 0), 0, 0
            ];
          };

          const currVec12D = w.obs.length > 0 ? get12D(w.obs[w.obs.length - 1]) : Array(12).fill(0);
          const histVecs12D = allHistObs.map(o => get12D(o));

          if (histVecs12D.length > 0) {
            const means = Array(12).fill(0);
            for (let i = 0; i < 12; i++) {
              means[i] = histVecs12D.reduce((sum, vec) => sum + (vec[i] || 0.0), 0) / histVecs12D.length;
            }
            const stds = Array(12).fill(0);
            for (let i = 0; i < 12; i++) {
              const sqDiff = histVecs12D.reduce((sum, vec) => sum + ((vec[i] || 0.0) - means[i]) ** 2, 0);
              stds[i] = Math.sqrt(sqDiff / histVecs12D.length);
            }

            const normCurr = currVec12D.map((v, i) => (v - means[i]) / (stds[i] + 1e-6));
            const normHists = histVecs12D.map(vec => vec.map((v, i) => (v - means[i]) / (stds[i] + 1e-6)));

            let simSum = 0;
            normHists.forEach(nHist => {
              simSum += cosineSimilarity(normCurr, nHist);
            });
            Feat_sim = simSum / normHists.length;
          }
        } else {
          const currSummary = computeSummary48D(w.obs);
          let sumCos = 0.0;
          historyWindows.forEach(hw => {
            const histSummary = computeSummary48D(hw.obs);
            sumCos += cosineSimilarity(currSummary, histSummary);
          });
          Feat_sim = sumCos / historyWindows.length;
        }

        S_hist = 1.0 - (0.30 * BC_avg + 0.25 * Seq_sim + 0.25 * Feat_sim + 0.20 * locFam);
        this.logs.push(`Window ${w.name}: S_hist=${S_hist.toFixed(3)} (BC=${BC_avg.toFixed(2)}, Seq=${Seq_sim.toFixed(2)}, Feat=${Feat_sim.toFixed(2)})`);
      } else {
        S_hist = 0.0;
        this.logs.push(`Window ${w.name}: No baseline history found. S_hist forced to 0.0`);
      }

      const S_final_W = 0.70 * S_non_hist + 0.30 * S_hist;
      results[w.name] = { S_non_hist, S_hist, S_final_W };
    });

    this.cachedHist3s = results['3s'].S_hist;
    this.cachedHist3m = results['3m'].S_hist;
    this.cachedHist5m = results['5m'].S_hist;
    this.cachedFinal3m = results['3m'].S_final_W;
    this.cachedFinal5m = results['5m'].S_final_W;
    this.hasHistoryData = validHistFoundTotal;

    const S_final = (results['3s'].S_final_W + results['3m'].S_final_W + results['5m'].S_final_W) / 3.0;
    this.logs.push(`ContextEngine Tick: Fused S_final = ${S_final.toFixed(3)} (3s: ${results['3s'].S_final_W.toFixed(2)}, 3m: ${results['3m'].S_final_W.toFixed(2)}, 5m: ${results['5m'].S_final_W.toFixed(2)})`);

    return {
      familiarityLevel1: results['3s'].S_final_W,
      familiarityLevel2: results['3m'].S_final_W,
      familiarityLevel3: results['5m'].S_final_W,
      familiarityFinal: S_final,
      explanation: this.logs
    };
  }
}

export const ContextEngine = new ContextEngineClass();

export function computeThreatScoreDetailed(packet, contextConfig = {}) {
  const logs = [];

  const buffer = MotionEngine.buffer || [];
  const packets = [...buffer];
  if (packets.length === 0 || packets[packets.length - 1].sequenceId !== packet.sequenceId) {
    packets.push(packet);
  }
  if (packets.length > 10) packets.shift();

  const scores = packets.map(p => p.anomalyScore);
  const embeddings = packets.map(p => p.motionEmbedding);
  const rmsValues = packets.map(p => {
    if (p.twelveFeatures && p.twelveFeatures.length > 1) {
      return p.twelveFeatures[1];
    }
    return (p.peakAccel || 0) / 101.97162;
  });

  const nonHistResult = computeNonHistoryMetrics(scores, embeddings, rmsValues);
  const S_non_hist_3s = nonHistResult.score;

  logs.push(`Real-time 3s Non-History Score: ${S_non_hist_3s.toFixed(3)}`);
  logs.push(`  Anomaly: ${nonHistResult.A_norm.toFixed(2)}, Drift: ${nonHistResult.D_norm.toFixed(2)}, Intensity: ${nonHistResult.I_norm.toFixed(2)}, Volatility: ${nonHistResult.V_norm.toFixed(2)}, Persistence: ${nonHistResult.P_norm.toFixed(2)}`);

  const S_hist_3s = ContextEngine.cachedHist3s;
  let S_final_3s = 0.70 * S_non_hist_3s + 0.30 * S_hist_3s;

  let S_final_3m = ContextEngine.cachedFinal3m;
  let S_final_5m = ContextEngine.cachedFinal5m;

  if (!ContextEngine.hasHistoryData) {
    S_final_3s = 0.70 * S_non_hist_3s;
    if (S_final_3m === 0) S_final_3m = 0.70 * S_non_hist_3s;
    if (S_final_5m === 0) S_final_5m = 0.70 * S_non_hist_3s;
  }

  let S_final = (S_final_3s + S_final_3m + S_final_5m) / 3.0;

  const { cooldownActive = false } = contextConfig;
  if (cooldownActive) {
    S_final *= 0.6;
    S_final_3s *= 0.6;
    S_final_3m *= 0.6;
    S_final_5m *= 0.6;
    logs.push(`Cooldown Active: Threat scores scaled to 60%`);
  }

  const wear = packet.wearConfidence !== undefined ? packet.wearConfidence : 100;
  if (wear < 40) {
    S_final = 0.0;
    S_final_3s = 0.0;
    S_final_3m = 0.0;
    S_final_5m = 0.0;
    logs.push(`Wear Confidence ${wear}% < 40%: SUPPRESSED to 0.0`);
  }

  const finalScore = Math.min(Math.max(S_final, 0.0), 1.0);
  logs.push(`Final Fused Threat Score S_final: ${finalScore.toFixed(3)} (3s: ${S_final_3s.toFixed(2)}, 3m: ${S_final_3m.toFixed(2)}, 5m: ${S_final_5m.toFixed(2)})`);

  return {
    score: finalScore,
    score3s: Math.min(Math.max(S_final_3s, 0.0), 1.0),
    score3m: Math.min(Math.max(S_final_3m, 0.0), 1.0),
    score5m: Math.min(Math.max(S_final_5m, 0.0), 1.0),
    explanation: logs
  };
}

export function getThreatLevel(score) {
  if (score < 0.40) return { name: 'NORMAL', color: '#10B981', action: 'Log event silently' };
  if (score < 0.55) return { name: 'LOW_ALERT', color: '#3B82F6', action: 'Phone haptic warning' };
  if (score < 0.72) return { name: 'ELEVATED', color: '#F59E0B', action: 'Screen notification, start countdown' };
  if (score < 0.88) return { name: 'HIGH', color: '#EF4444', action: 'Full-screen overlay alert (15s cancel)' };
  return { name: 'CRITICAL', color: '#B91C1C', action: 'Immediate emergency dispatch' };
}
