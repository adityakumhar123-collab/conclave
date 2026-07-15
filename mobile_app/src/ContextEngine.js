// =============================================================================
// ContextEngine.js — Behavioral Familiarity Scoring & Threat Assessment
// =============================================================================
//
// DRY RUN / ARCHITECTURE OVERVIEW
// --------------------------------
// ContextEngine answers the question: "Given what the wristband is detecting,
// how dangerous is the situation — considering where the user is, what time it
// is, and how their behavior compares to their historical baseline?"
//
// It has TWO distinct parts:
//   1. ContextEngineClass.runInference()  — Computes a "familiarity score" (0–1)
//      by comparing the current 15-minute behavioral window to historical data
//      across 3 temporal scales:
//        Level 1: Last 15–30 minutes (is this UNUSUAL for the current session?)
//        Level 2: Earlier today (is this UNUSUAL for this time of day today?)
//        Level 3: Last 7 days at this time (is this UNUSUAL historically?)
//
//   2. computeThreatScoreDetailed()  — Takes a BLE FEATURE/EVENT packet + the
//      familiarity score and computes a 0.0–1.0 threat score. This score drives
//      the Context Engine Gauge on the dashboard and the emergency alert trigger.
//
// WHO CALLS THIS:
//   → App.js calls computeThreatScoreDetailed() on every FEATURE/EVENT packet
//     (2 Hz) to update the dashboard threat gauge.
//   → App.js may call ContextEngine.runInference() periodically or on demand
//     for the full familiarity assessment (more expensive DB query).
//
// FILES USED:
//   → Database.js for: initDatabase (direct SQL), storeInference, getIsoDateString,
//                       getIsoTimeString
//   → LocationEngine.js for: LocationEngine.activeVisit, LocationEngine.currentGps
//
// OUTPUT:
//   → computeThreatScoreDetailed() → { score: 0.0–1.0, explanation: string[] }
//   → getThreatLevel(score)        → { name, color, action }
//   → ContextEngine.runInference() → { familiarityLevel1/2/3/Final, explanation[] }
//
// FAMILIARITY SCORE COMPUTATION (3-Level Hierarchical Comparison):
//
//   Each level compares the CURRENT 15-minute behavioral window (winT) against
//   a reference window from a different time period using computeSimilarity().
//
//   computeSimilarity(winA, winB) returns a composite score:
//     motionSim    = Cosine similarity of cluster_distribution dicts (0–1)
//     locationSim  = 1.0 if same node, or exp(-dist/20m) based on GPS distance
//     temporalSim  = Gaussian time difference × day-type match (weekday/weekend)
//     jointSim     = motionSim × locationSim
//     windowSim    = (motionSim + locationSim + temporalSim + jointSim) / 4.0
//
//   Level weights in the final familiarity score:
//     finalFamiliarity = 0.2 × L1 + 0.3 × L2 + 0.5 × L3
//     (Historical 7-day similarity is weighted most heavily — most reliable signal)
//
// THREAT SCORE PIPELINE (computeThreatScoreDetailed):
//   1. Normalize anomaly MAE score against the calibrated threshold (1.01309)
//   2. Apply pattern weight based on motion state bitmask:
//      - High-Impact + linear fall (eigenvalue > 700) → 0.80 weight
//      - Aperiodic + long duration (> 8s) + high accel (> 1400mg) → 0.75 weight (struggle)
//      - Periodic + low spectral entropy → 0.70 weight (seizure-like)
//      - Restrained + long stillness → 0.65 weight (pinned/restrained)
//      - Walking/still → 0.20–0.40 weight (normal range)
//   3. Apply duration factor: short burst (< 1.5s) = low weight, sustained (> 12s) = high
//   4. Add +0.15 if anomalous AND suddenly still (post-fall collapse detection)
//   5. Modulate by familiarity: unfamiliar location amplifies threat, familiar dampens
//      formula: threatScore × (1.3 - 0.6 × familiarityScore)
//   6. Apply wear confidence penalty: < 40% confidence → suppress to 0 (device removed)
//   7. Clamp to [0.0, 1.0]
//
// BUGS / NOTES:
//   ⚠ computeThreatScoreDetailed() comment block numbers its steps as 1,2,3,4,7
//     (skipping 5 and 6). This suggests steps 5 and 6 were removed during
//     development but the numbering was not updated. Minor cosmetic issue.
//   ⚠ getLocationNodeIdAt() calls initDatabase() on every invocation. Since
//     initDatabase() is idempotent (returns cached db after first call), this is
//     safe but adds a tiny overhead for every location lookup.
//   ⚠ Level 3 historical comparison fetches ALL observations from the last 7 days
//     at the matching time window across ALL past dates. If the user has used the
//     device for many months, this query could return many rows. The groupByDate
//     logic then runs N DB queries (one per unique date). For large datasets this
//     could become slow. A pre-aggregated summary table would be more efficient.
// =============================================================================

import {
  initDatabase,
  getIsoDateString,
  getIsoTimeString
} from './Database.js';
import { LocationEngine } from './LocationEngine.js';


// Helper: Convert time string "HH:MM:SS" to seconds since midnight
export function timeStrToSeconds(tStr) {
  if (!tStr) return 0;
  const [h, m, s] = tStr.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

// Helper: Convert seconds since midnight to "HH:MM:SS" time string
export function secondsToTimeStr(sec) {
  const totalSec = Math.max(0, sec);
  const h = Math.floor(totalSec / 3600) % 24;
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Helper: Determine weekday/weekend day classification
export function getDayType(dateStr) {
  const day = new Date(dateStr).getDay();
  return (day === 0 || day === 6) ? 'WEEKEND' : 'WEEKDAY';
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

// Helper: Query Location Visit Node ID at specific date & time
export function getLocationNodeIdAt(dateStr, timeStr) {
  try {
    const db = initDatabase();
    const row = db.getFirstSync(`
      SELECT location_node_id FROM location_visits
      WHERE (enter_date < ? OR (enter_date = ? AND enter_time <= ?))
        AND (exit_date IS NULL OR exit_date > ? OR (exit_date = ? AND exit_time >= ?))
      ORDER BY enter_date DESC, enter_time DESC
      LIMIT 1;
    `, [dateStr, dateStr, timeStr, dateStr, dateStr, timeStr]);
    return row ? row.location_node_id : null;
  } catch (e) {
    return null;
  }
}

// 1. Context Window Construction
export function buildContextWindow(dateStr, timeStr, windowSizeMinutes = 15, locationNodeId = null, gpsCoords = null) {
  const db = initDatabase();
  const targetSec = timeStrToSeconds(timeStr);
  const startSec = targetSec - windowSizeMinutes * 60;

  let rawObs = [];
  try {
    if (startSec >= 0) {
      const startT = secondsToTimeStr(startSec);
      rawObs = db.getAllSync(`
        SELECT * FROM observations 
        WHERE date = ? AND time >= ? AND time <= ?
        ORDER BY date ASC, time ASC;
      `, [dateStr, startT, timeStr]);
    } else {
      // Cross midnight boundary
      const prevDateObj = new Date(new Date(dateStr).getTime() - 86400000);
      const prevDateStr = getIsoDateString(prevDateObj);
      const startT = secondsToTimeStr(86400 + startSec);

      const rowsPrev = db.getAllSync(`
        SELECT * FROM observations 
        WHERE date = ? AND time >= ?
        ORDER BY date ASC, time ASC;
      `, [prevDateStr, startT]);

      const rowsToday = db.getAllSync(`
        SELECT * FROM observations 
        WHERE date = ? AND time <= ?
        ORDER BY date ASC, time ASC;
      `, [dateStr, timeStr]);

      rawObs = [...rowsPrev, ...rowsToday];
    }
  } catch (e) {
    console.warn('[ContextEngine] Failed to build context window observations:', e);
  }

  const parsedObs = rawObs.map(row => ({
    ...row,
    cluster_distribution: typeof row.cluster_distribution === 'string' ? JSON.parse(row.cluster_distribution) : row.cluster_distribution,
    motion_features: typeof row.motion_features === 'string' ? JSON.parse(row.motion_features) : row.motion_features
  }));

  // Compile average motion distribution
  const avgDistribution = {};
  if (parsedObs.length > 0) {
    const keys = new Set();
    parsedObs.forEach(obs => {
      if (obs.cluster_distribution) {
        Object.keys(obs.cluster_distribution).forEach(k => keys.add(k));
      }
    });
    for (const key of keys) {
      let sum = 0;
      parsedObs.forEach(obs => {
        sum += obs.cluster_distribution[key] || 0.0;
      });
      avgDistribution[key] = sum / parsedObs.length;
    }
  }

  // Resolve location node
  let resolvedNodeId = locationNodeId;
  if (resolvedNodeId === null) {
    resolvedNodeId = getLocationNodeIdAt(dateStr, timeStr);
  }

  return {
    date: dateStr,
    time: timeStr,
    observations: parsedObs,
    avgDistribution,
    locationNodeId: resolvedNodeId,
    gpsCoords
  };
}

// 2. Motion Cosine Similarity
export function getMotionSimilarity(p1, p2) {
  const keys = new Set([...Object.keys(p1 || {}), ...Object.keys(p2 || {})]);
  if (keys.size === 0) return 1.0;

  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;

  for (const key of keys) {
    const valA = p1[key] || 0.0;
    const valB = p2[key] || 0.0;
    dotProduct += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }

  if (normA === 0.0 && normB === 0.0) return 1.0;
  if (normA === 0.0 || normB === 0.0) return 0.0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// 3. Location Similarity with decay
export function getLocationSimilarity(nodeAId, gpsA, nodeBId, gpsB) {
  if (nodeAId !== null && nodeBId !== null && nodeAId === nodeBId) {
    return 1.0;
  }

  let latA = gpsA ? gpsA.latitude : null;
  let lonA = gpsA ? gpsA.longitude : null;
  let latB = gpsB ? gpsB.latitude : null;
  let lonB = gpsB ? gpsB.longitude : null;

  try {
    const db = initDatabase();
    if (nodeAId !== null && (latA === null || lonA === null)) {
      const nodeA = db.getFirstSync('SELECT center_latitude, center_longitude FROM location_nodes WHERE location_node_id = ?;', [nodeAId]);
      if (nodeA) {
        latA = nodeA.center_latitude;
        lonA = nodeA.center_longitude;
      }
    }
    if (nodeBId !== null && (latB === null || lonB === null)) {
      const nodeB = db.getFirstSync('SELECT center_latitude, center_longitude FROM location_nodes WHERE location_node_id = ?;', [nodeBId]);
      if (nodeB) {
        latB = nodeB.center_latitude;
        lonB = nodeB.center_longitude;
      }
    }
  } catch (e) {
    // Fail silently, fallback below
  }

  if (latA !== null && lonA !== null && latB !== null && lonB !== null) {
    const dist = getHaversineDistance(latA, lonA, latB, lonB);
    return Math.exp(-dist / 20.0); // decay distance scale is 20m
  }

  return 0.5; // Fallback
}

// 4. Temporal Similarity
export function getTemporalSimilarity(timeA, dateA, timeB, dateB) {
  // Gaussian time difference similarity
  const secA = timeStrToSeconds(timeA);
  const secB = timeStrToSeconds(timeB);
  let diffSec = Math.abs(secA - secB);
  if (diffSec > 43200) {
    diffSec = 86400 - diffSec;
  }

  const sigma = 900.0; // 15 minutes tolerance
  const timeSim = Math.exp(-(diffSec * diffSec) / (2 * sigma * sigma));

  // Day type similarity
  const typeA = getDayType(dateA);
  const typeB = getDayType(dateB);

  let daySim = 1.0;
  if (typeA === 'WEEKDAY' && typeB === 'WEEKEND') {
    daySim = 0.8;
  } else if (typeA === 'WEEKEND' && typeB === 'WEEKDAY') {
    daySim = 0.6;
  }

  return timeSim * daySim;
}

// 5. Context Window Comparison
export function computeSimilarity(winA, winB) {
  const motionSim = getMotionSimilarity(winA.avgDistribution, winB.avgDistribution);
  const locationSim = getLocationSimilarity(winA.locationNodeId, winA.gpsCoords, winB.locationNodeId, winB.gpsCoords);
  const temporalSim = getTemporalSimilarity(winA.time, winA.date, winB.time, winB.date);
  const jointSim = motionSim * locationSim;

  const windowSim = (motionSim + locationSim + temporalSim + jointSim) / 4.0;

  return {
    motionSim,
    locationSim,
    temporalSim,
    jointSim,
    windowSim
  };
}

class ContextEngineClass {
  constructor() {
    this.logs = [];
  }

  runInference(packet, gpsCoords = null, overrideDate = null, overrideTime = null) {
    this.logs = [];
    const dateStr = overrideDate || getIsoDateString();
    const timeStr = overrideTime || getIsoTimeString();

    this.logs.push(`Assessment started at ${dateStr} ${timeStr}`);

    // Resolve location
    let locationNodeId = null;
    if (LocationEngine.activeVisit) {
      locationNodeId = LocationEngine.activeVisit.location_node_id;
    }

    // 1. Build Current Context Window
    const winT = buildContextWindow(dateStr, timeStr, 15, locationNodeId, gpsCoords || LocationEngine.currentGps);
    this.logs.push(`Built current window: ${winT.observations.length} observations.`);

    // 2. Compute Level 1 Familiarity (Active Session window compared to 15-30 mins ago)
    let level1 = 1.0;
    const prevTimeSec = timeStrToSeconds(timeStr) - 15 * 60;
    const prevTimeStr = secondsToTimeStr(prevTimeSec);
    const winPrev = buildContextWindow(dateStr, prevTimeStr, 15, null, null);

    if (winPrev.observations.length > 0) {
      const sim = computeSimilarity(winT, winPrev);
      level1 = sim.windowSim;
      this.logs.push(`Level 1 (Session) comparison with preceding window: ${level1.toFixed(3)}`);
    } else {
      this.logs.push(`Level 1 (Session): No preceding window, defaulted to 1.0`);
    }

    // 3. Compute Level 2 Familiarity (Earlier windows today)
    let level2 = 1.0;
    const earlierObs = [];
    try {
      const db = initDatabase();
      const limitTime = secondsToTimeStr(timeStrToSeconds(timeStr) - 15 * 60);
      const rows = db.getAllSync(`
        SELECT * FROM observations 
        WHERE date = ? AND time < ?
        ORDER BY time ASC;
      `, [dateStr, limitTime]);

      rows.forEach(r => {
        earlierObs.push({
          ...r,
          cluster_distribution: JSON.parse(r.cluster_distribution),
          motion_features: JSON.parse(r.motion_features)
        });
      });
    } catch (e) {
      // Ignore
    }

    if (earlierObs.length >= 10) {
      // segment into non-overlapping 15m intervals
      const blocks = [];
      let currentBlock = [];
      let lastSec = -1;

      for (const obs of earlierObs) {
        const oSec = timeStrToSeconds(obs.time);
        if (lastSec === -1 || oSec - lastSec < 15 * 60) {
          currentBlock.push(obs);
        } else {
          blocks.push(currentBlock);
          currentBlock = [obs];
        }
        lastSec = oSec;
      }
      if (currentBlock.length > 0) blocks.push(currentBlock);

      let sumSim = 0.0;
      let count = 0;
      blocks.forEach(block => {
        if (block.length > 0) {
          const winBlock = buildContextWindow(dateStr, block[block.length - 1].time, 15, null, null);
          const sim = computeSimilarity(winT, winBlock);
          sumSim += sim.windowSim;
          count++;
        }
      });

      if (count > 0) {
        level2 = sumSim / count;
        this.logs.push(`Level 2 (Today): Evaluated ${count} earlier blocks. Average Similarity: ${level2.toFixed(3)}`);
      }
    } else {
      this.logs.push(`Level 2 (Today): Insufficient earlier data today, defaulted to 1.0`);
    }

    // 4. Compute Level 3 Familiarity (Historical 30-day temporal window matching)
    let level3 = 0.5; // neutral fallback
    const histObs = [];
    try {
      const db = initDatabase();
      const targetSec = timeStrToSeconds(timeStr);
      const startSec = targetSec - 15 * 60;
      const endSec = targetSec + 15 * 60;

      let rows = [];
      if (startSec < 0) {
        rows = db.getAllSync(`
          SELECT * FROM observations 
          WHERE date < ? AND (time >= ? OR time <= ?)
          ORDER BY date ASC, time ASC;
        `, [dateStr, secondsToTimeStr(86400 + startSec), secondsToTimeStr(endSec)]);
      } else if (endSec >= 86400) {
        rows = db.getAllSync(`
          SELECT * FROM observations 
          WHERE date < ? AND (time >= ? OR time <= ?)
          ORDER BY date ASC, time ASC;
        `, [dateStr, secondsToTimeStr(startSec), secondsToTimeStr(endSec - 86400)]);
      } else {
        rows = db.getAllSync(`
          SELECT * FROM observations 
          WHERE date < ? AND time >= ? AND time <= ?
          ORDER BY date ASC, time ASC;
        `, [dateStr, secondsToTimeStr(startSec), secondsToTimeStr(endSec)]);
      }

      rows.forEach(r => {
        histObs.push({
          ...r,
          cluster_distribution: JSON.parse(r.cluster_distribution),
          motion_features: JSON.parse(r.motion_features)
        });
      });
    } catch (e) {
      // Ignore
    }

    // Group by unique date
    const groupedHist = {};
    histObs.forEach(obs => {
      if (!groupedHist[obs.date]) groupedHist[obs.date] = [];
      groupedHist[obs.date].push(obs);
    });

    const dates = Object.keys(groupedHist);
    if (dates.length > 0) {
      let sumSim = 0.0;
      let count = 0;

      dates.forEach(d => {
        const obsList = groupedHist[d];
        if (obsList.length > 0) {
          const winHist = buildContextWindow(d, obsList[obsList.length - 1].time, 15, null, null);
          const sim = computeSimilarity(winT, winHist);
          sumSim += sim.windowSim;
          count++;
        }
      });

      if (count > 0) {
        level3 = sumSim / count;
        this.logs.push(`Level 3 (7 Days): Evaluated ${count} historical days. Average Similarity: ${level3.toFixed(3)}`);
      }
    } else {
      this.logs.push(`Level 3 (7 Days): No historical matching time windows, defaulted to 0.5`);
    }

    // 5. Fuse final familiarity score
    const finalFamiliarity = 0.2 * level1 + 0.3 * level2 + 0.5 * level3;
    this.logs.push(`Final Familiarity Score Fused: ${finalFamiliarity.toFixed(3)} (L1: ${level1.toFixed(2)}, L2: ${level2.toFixed(2)}, L3: ${level3.toFixed(2)})`);

    return {
      familiarityLevel1: level1,
      familiarityLevel2: level2,
      familiarityLevel3: level3,
      familiarityFinal: finalFamiliarity,
      explanation: this.logs
    };
  }
}

export const ContextEngine = new ContextEngineClass();

// Standard threat assessment API mapping to Mobile Dashboard UI
export function computeThreatScoreDetailed(packet, contextConfig = {}) {
  const logs = [];
  const {
    familiarityScore = 1.0, // default familiarity keeps threat score down
  } = contextConfig;

  // 1. Base Motion Evidence
  const normalizedScore = packet.anomalyScore / 1.01309; // 1.01309 is the trigger threshold (DEFAULT_THRESHOLD)
  logs.push(`Raw anomaly score: ${packet.anomalyScore.toFixed(3)} (Normalized: ${normalizedScore.toFixed(3)})`);

  let patternWeight = 0.40;
  let patternName = 'UNKNOWN';
  const isStill = (packet.motionState & (1 << 0)) !== 0;
  const isPeriodic = (packet.motionState & (1 << 1)) !== 0;
  const isAperiodic = (packet.motionState & (1 << 2)) !== 0;
  const isHighImpact = (packet.motionState & (1 << 3)) !== 0;
  const isRestrained = (packet.motionState & (1 << 4)) !== 0;

  if (isHighImpact && packet.eigenvalueRatio > 700) {
    patternWeight = 0.80;
    patternName = 'FALL_CANDIDATE';
  } else if (isAperiodic && !isHighImpact && packet.anomalyDuration > 80 && packet.peakAccel > 1400) {
    patternWeight = 0.75;
    patternName = 'STRUGGLE_CANDIDATE';
  } else if (isPeriodic && packet.spectralEntropy < 100) {
    patternWeight = 0.70;
    patternName = 'SEIZURE_CANDIDATE';
  } else if (isRestrained || (isStill && packet.anomalyDuration > 50)) {
    patternWeight = 0.65;
    patternName = 'PINNED_CANDIDATE';
  } else if (isStill) {
    patternWeight = 0.20;
    patternName = 'STILL';
  } else if (isPeriodic) {
    patternWeight = 0.30;
    patternName = 'PERIODIC';
  } else if (isAperiodic) {
    patternWeight = 0.40;
    patternName = 'APERIODIC';
  }

  logs.push(`Motion State Mask: 0x${packet.motionState.toString(16).toUpperCase()} (${patternName}), weight: ${patternWeight}`);

  let threatScore = normalizedScore * patternWeight;
  logs.push(`Base threat score: ${threatScore.toFixed(3)}`);

  // 2. Anomaly Duration
  const durationSec = packet.anomalyDuration * 0.1;
  const scoreConfidence = packet.anomalyScore / 1.1265;
  const minDurationFactor = scoreConfidence * 0.55;

  let durationFactor = minDurationFactor;
  if (durationSec < 1.5) {
    durationFactor = Math.max(minDurationFactor, 0.10);
  } else if (durationSec < 3.0) {
    durationFactor = Math.max(minDurationFactor, 0.35);
  } else if (durationSec < 6.0) {
    durationFactor = Math.max(minDurationFactor, 0.60);
  } else if (durationSec < 12.0) {
    durationFactor = Math.max(minDurationFactor, 0.80);
  } else {
    durationFactor = Math.max(minDurationFactor, 0.95);
  }
  threatScore *= durationFactor;
  logs.push(`Anomaly Duration: ${durationSec.toFixed(1)}s | DurationFactor: ${durationFactor.toFixed(2)}`);

  // 3. Post-Anomaly Stillness (Real-time detection: anomaly > 0.79 and isStill)
  if (packet.anomalyScore > 0.79 && isStill) {
    threatScore += 0.15;
    logs.push(`Post-Anomaly Stillness detected (+0.15)`);
  }

  // 4. Familiarity Modulation (Amplify if unfamiliar, discount if familiar)
  // Formula: threatScore = threatScore * (1.3 - 0.6 * familiarityScore)
  const familiarityFactor = 1.3 - 0.6 * familiarityScore;
  threatScore *= familiarityFactor;
  logs.push(`Familiarity Modulation: F=${familiarityScore.toFixed(3)} | Factor=${familiarityFactor.toFixed(2)}`);

  // 5. Wear Confidence
  if (packet.wearConfidence < 40) {
    threatScore = 0.0;
    logs.push(`Wear Confidence ${packet.wearConfidence}% < 40%: SUPPRESSED`);
  } else if (packet.wearConfidence < 60) {
    threatScore *= 0.50;
    logs.push(`Wear Confidence ${packet.wearConfidence}%: 0.50 discount`);
  } else if (packet.wearConfidence < 80) {
    threatScore *= 0.80;
    logs.push(`Wear Confidence ${packet.wearConfidence}%: 0.80 discount`);
  }

  const finalScore = Math.min(Math.max(threatScore, 0.0), 1.0);
  logs.push(`Final threat score: ${finalScore.toFixed(3)}`);

  return {
    score: finalScore,
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
