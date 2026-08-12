import { createRequire } from 'module';
globalThis.require = createRequire(import.meta.url);

// Set in-memory SQLite database for clean, isolated Node.js testing
process.env.SAFEBAND_TEST_DB = ':memory:';

import {
  initDatabase,
  storeObservation,
  getLatestObservation,
  getIsoDateString,
  getIsoTimeString,
  getLocationNodes
} from './src/Database.js';
import { LocationEngine } from './src/LocationEngine.js';
import { MotionEngine } from './src/MotionEngine.js';
import {
  ContextEngine,
  computeThreatScoreDetailed,
  timeStrToSeconds,
  secondsToTimeStr
} from './src/ContextEngine.js';

// Setup utility to log test results with nice formatting
function logResult(name, passed, detail = '') {
  if (passed) {
    console.log(`\x1b[32m[PASS] ${name}\x1b[0m ${detail}`);
  } else {
    console.log(`\x1b[31m[FAIL] ${name}\x1b[0m ${detail}`);
    process.exitCode = 1;
  }
}

async function runTests() {
  console.log("==================================================");
  console.log("SafeBand Engine Integrity Test Suite");
  console.log("==================================================\n");

  // 1. Initialise the database schema in memory
  const db = initDatabase();
  logResult("Database Initialization", db !== null, "In-memory SQLite tables generated successfully.");

  // Seed mock motion clusters
  db.execSync(`
    INSERT INTO motion_clusters (cluster_id, cluster_version, centroid, covariance, visit_count, reconstruction_mean)
    VALUES 
      (1, 0, '[0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]', '[]', 10, 0.2),
      (2, 0, '[-0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5]', '[]', 5, 0.4);
  `);
  logResult("Clustering Seed", true, "Centroids loaded into motion_clusters.");

  // Helper to generate a dummy observation row with specific timestamp, motion clusters and features
  function buildDummyObservation(date, time, clusterId, features = null, score = 0.15) {
    const dist = {};
    dist[clusterId] = 1.0; // 100% of this cluster

    const twelve = features || [
      0.15, // std
      9.8,  // rms (resultant accel)
      0.0, 0.0,
      0.05, // zcr
      1.5,  // dom_freq
      0.45, // entropy
      0.1, 0.1,
      0.8,  // eigenvalueRatio
      2.5,  // total_variance
      0.02  // coupling
    ];

    const motionFeatures = Array.from({ length: 10 }, (_, idx) => ({
      sequenceId: idx,
      motionState: 0x82, // Worn & Periodic
      dominantFreq: twelve[5],
      zcr: Math.round(twelve[4] * 255.0),
      spectralEntropy: Math.round(twelve[6] * 255.0),
      eigenvalueRatio: Math.round(twelve[9] * 1000.0),
      wearConfidence: 100,
      peakAccel: Math.round(twelve[1] * 101.97162),
      anomalyDuration: 0,
      twelveFeatures: twelve
    }));

    return {
      date,
      time,
      embeddings: Array(10).fill(Array(16).fill(clusterId === 1 ? 0.1 : -0.5)),
      reconstruction_scores: Array(10).fill(score),
      motion_features: motionFeatures,
      cluster_distribution: dist,
      cluster_version: 0
    };
  }

  // ===========================================================================
  // TEST 1: Visit-Weighted Location Familiarity Extrapolation
  // ===========================================================================
  console.log("\n--- TEST 1: Location Familiarity Extrapolation ---");
  
  // Seed two known location nodes with different visit counts
  db.execSync(`
    INSERT INTO location_nodes (location_node_id, center_latitude, center_longitude, radius, visit_count)
    VALUES 
      (1, 37.7749, -122.4194, 20.0, 100), -- Home (100 visits)
      (2, 37.7891, -122.4014, 20.0, 20);   -- Cafe (20 visits)
  `);

  // Force known nodes to load in LocationEngine
  LocationEngine.knownNodes = getLocationNodes();

  // Scenario A: Inside Home node radius
  const famInside = LocationEngine.estimateFamiliarity(37.7749, -122.4194);
  logResult("Familiarity inside Home geofence", famInside === 1.0, `Score = ${famInside}`);

  // Scenario B: Extrapolated from Home (high visits) vs Cafe (low visits)
  // Position the user exactly 40 meters from Home node center
  const d_home = 40.0;
  // Exp decay = exp(-40 / (20 * 2)) = exp(-1) = 0.367879. Home relative visits = 100/100 = 1.0
  const famNearHome = LocationEngine.estimateFamiliarity(37.7749 + (40.0 / 111000.0), -122.4194);
  
  // Position the user exactly 40 meters from Cafe node center
  // Cafe relative visits = 20/100 = 0.20. Expected = 0.20 * exp(-1) = 0.07357
  const famNearCafe = LocationEngine.estimateFamiliarity(37.7891 + (40.0 / 111000.0), -122.4014);

  logResult("Familiarity near Home node (visit-weight 1.0)", famNearHome > 0.33 && famNearHome < 0.40, `Score = ${famNearHome.toFixed(4)}`);
  logResult("Familiarity near Cafe node (visit-weight 0.2)", famNearCafe > 0.06 && famNearCafe < 0.09, `Score = ${famNearCafe.toFixed(4)}`);

  // ===========================================================================
  // TEST 2: ContextEngine 3-Window Baseline Comparison & Threat Fusing
  // ===========================================================================
  console.log("\n--- TEST 2: Multi-Window Familiarity & Zero-Threat Fallback ---");
  
  const targetTime = "12:00:00";
  const todayStr = "2026-07-16";
  const yesterdayStr = "2026-07-15";
  const lastWeekStr = "2026-07-09";
  const twoWeeksStr = "2026-07-01";

  // Scenario A: Database is empty of history. Ensure zero-threat history fallback works!
  // Insert only TODAY's observations so we have a current window but zero history
  const todaySecs = timeStrToSeconds(targetTime);
  for (let s = todaySecs - 297; s <= todaySecs; s += 3) {
    const obsData = buildDummyObservation(todayStr, secondsToTimeStr(s), 1);
    storeObservation(obsData);
  }

  // Run inference for Case A (No history fallback)
  const packetNormal = { anomalyScore: 0.2, motionState: 0x02, wearConfidence: 100, dominantFreq: 1.5, eigenvalueRatio: 800, zcr: 12, spectralEntropy: 110, peakAccel: 980, anomalyDuration: 0, motionEmbedding: Array(16).fill(0.1) };
  
  // Force LocationEngine current GPS coordinates to match Home
  LocationEngine.currentGps = { latitude: 37.7749, longitude: -122.4194 };

  const infEmptyHistory = ContextEngine.runInference(packetNormal, null, todayStr, targetTime);
  logResult("History fallback presence check", ContextEngine.hasHistoryData === false, "Recognized that SQLite history is empty.");
  logResult("Fallback history scores (S_hist = 0.0)", ContextEngine.cachedHist3s === 0.0 && ContextEngine.cachedHist3m === 0.0 && ContextEngine.cachedHist5m === 0.0, "Forced historical threat scores to exactly 0.0.");

  // Scenario B: Seed historical data matching TODAY's behavior (cluster 1)
  const historyDates = [yesterdayStr, lastWeekStr, twoWeeksStr];
  historyDates.forEach(hDate => {
    const hSecs = timeStrToSeconds(targetTime);
    for (let s = hSecs - 297; s <= hSecs; s += 3) {
      const obsData = buildDummyObservation(hDate, secondsToTimeStr(s), 1);
      storeObservation(obsData);
    }
  });

  // Run inference (now historical data matches current behavior)
  const infMatchingHistory = ContextEngine.runInference(packetNormal, null, todayStr, targetTime);
  logResult("Historical baseline comparison match", ContextEngine.hasHistoryData === true, "Recognized that matching history exists in SQLite.");
  logResult("History scores with matching baseline", ContextEngine.cachedHist3s < 0.2 && ContextEngine.cachedHist3m < 0.2 && ContextEngine.cachedHist5m < 0.2, `Familiarity detected, S_hist ranges: L3s=${ContextEngine.cachedHist3s.toFixed(2)}, L3m=${ContextEngine.cachedHist3m.toFixed(2)}`);

  // Scenario C: Behavioral Deviation
  // Keep today's current window as cluster 1, but modify history to be cluster 2
  db.execSync("DELETE FROM observations WHERE date IN ('2026-07-15', '2026-07-09', '2026-07-01');");
  historyDates.forEach(hDate => {
    const hSecs = timeStrToSeconds(targetTime);
    for (let s = hSecs - 297; s <= hSecs; s += 3) {
      const obsData = buildDummyObservation(hDate, secondsToTimeStr(s), 2); // Cluster 2!
      storeObservation(obsData);
    }
  });

  const infBehavioralDeviation = ContextEngine.runInference(packetNormal, null, todayStr, targetTime);
  logResult("Behavioral Deviation Detection", ContextEngine.cachedHist3s > 0.50 && ContextEngine.cachedHist3m > 0.50, `Identified cluster change from 1 -> 2. S_hist scores: L3s=${ContextEngine.cachedHist3s.toFixed(3)}, L3m=${ContextEngine.cachedHist3m.toFixed(3)}`);

  // ===========================================================================
  // TEST 3: Real-Time 2 Hz Threat Score Calculations
  // ===========================================================================
  console.log("\n--- TEST 3: 2 Hz Real-Time Threat Score Pipeline ---");

  // Scenario A: Normal behavior
  // Reset database observations first so we have a clean slate for normal behavior
  db.execSync("DELETE FROM observations;");
  // Seed normal observations for today
  for (let s = todaySecs - 297; s <= todaySecs; s += 3) {
    storeObservation(buildDummyObservation(todayStr, secondsToTimeStr(s), 1));
  }
  // Run inference to cache normal baseline scores
  const packetNormal2Hz = {
    sequenceId: 10,
    anomalyScore: 0.15,
    motionState: 0x02,
    peakAccel: 980,
    dominantFreq: 1.5,
    zcr: 12,
    spectralEntropy: 110,
    eigenvalueRatio: 800,
    wearConfidence: 100,
    motionEmbedding: Array(16).fill(0.1)
  };
  ContextEngine.runInference(packetNormal2Hz, null, todayStr, targetTime);

  // Set buffer
  MotionEngine.buffer = Array.from({ length: 10 }, (_, idx) => ({
    sequenceId: idx,
    anomalyScore: 0.2,
    motionState: 0x02,
    peakAccel: 980,
    dominantFreq: 1.5,
    zcr: 12,
    spectralEntropy: 110,
    eigenvalueRatio: 800,
    wearConfidence: 100,
    motionEmbedding: Array(16).fill(0.1)
  }));

  const scoreNormal = computeThreatScoreDetailed(packetNormal2Hz);
  logResult("Normal threat score", scoreNormal.score < 0.25, `Fused threat = ${Math.round(scoreNormal.score * 100)}%`);

  // Scenario B: High Threat Anomaly Trigger (Fall Candidate with Behavioral Deviation)
  // Set location to totally unfamiliar
  LocationEngine.currentGps = { latitude: 0, longitude: 0 };

  // Clear database observations first
  db.execSync("DELETE FROM observations;");

  // Seed today's observations with high-impact, high-anomaly, varying features (to create volatility/drift)
  for (let s = todaySecs - 297; s <= todaySecs; s += 3) {
    const factor = (s - (todaySecs - 297)) / 300; // 0 to 1
    const valStd = 0.8 + factor * 0.4;
    const valRms = 22.0 + Math.sin(factor * 10) * 8.0;
    const valZcr = 0.15 + factor * 0.1;
    const valEntropy = 0.3 + factor * 0.2;
    const valVar = 6.0 + factor * 5.0;

    storeObservation(buildDummyObservation(todayStr, secondsToTimeStr(s), 1, [
      valStd, // std
      valRms, // rms
      0.5, 0.5, // skew, kurt
      valZcr, // zcr
      2.5, // dom_freq
      valEntropy, // entropy
      0.1, 0.1,
      0.95, // eigenvalueRatio
      valVar, // total_variance
      0.02 // coupling
    ], 1.10));
  }

  // Seed historical observations on D-1, D-7, D-15 with completely different behavior (cluster 2, normal features)
  historyDates.forEach(hDate => {
    const hSecs = timeStrToSeconds(targetTime);
    for (let s = hSecs - 297; s <= hSecs; s += 3) {
      storeObservation(buildDummyObservation(hDate, secondsToTimeStr(s), 2)); // Cluster 2!
    }
  });

  // Setup MotionEngine.buffer with high-impact, high-anomaly, varying features
  MotionEngine.buffer = Array.from({ length: 10 }, (_, idx) => ({
    sequenceId: idx,
    anomalyScore: 1.10 + idx * 0.01,
    motionState: 0x8A, // Worn, Periodic & High-Impact
    peakAccel: Math.round((22.0 + Math.sin(idx) * 8.0) * 101.97162),
    dominantFreq: 2.5,
    zcr: Math.round((0.15 + idx * 0.01) * 255.0),
    spectralEntropy: Math.round((0.3 + idx * 0.02) * 255.0),
    eigenvalueRatio: 950,
    wearConfidence: 100,
    motionEmbedding: Array(16).fill(0.1 + idx * 0.05) // varying embeddings for drift
  }));

  const packetAnomaly2Hz = {
    sequenceId: 10,
    anomalyScore: 1.19,
    motionState: 0x8A,
    peakAccel: 3000,
    dominantFreq: 2.5,
    zcr: 50,
    spectralEntropy: 85,
    eigenvalueRatio: 960,
    wearConfidence: 100,
    motionEmbedding: Array(16).fill(0.6)
  };

  // Run inference to update caches with high threat scores
  ContextEngine.runInference(packetAnomaly2Hz, null, todayStr, targetTime);

  const scoreAnomaly = computeThreatScoreDetailed(packetAnomaly2Hz);
  logResult("High threat fall score", scoreAnomaly.score > 0.70, `Fused threat = ${Math.round(scoreAnomaly.score * 100)}% (3s: ${Math.round(scoreAnomaly.score3s * 100)}%, 3m: ${Math.round(scoreAnomaly.score3m * 100)}%, 5m: ${Math.round(scoreAnomaly.score5m * 100)}%)`);

  // Scenario C: Wear Confidence suppression
  const packetUnworn = { ...packetAnomaly2Hz, wearConfidence: 30 }; // Less than 40%
  const scoreUnworn = computeThreatScoreDetailed(packetUnworn);
  logResult("Unworn threat score suppression", scoreUnworn.score === 0.0 && scoreUnworn.score3s === 0.0, `Suppressed threat = ${scoreUnworn.score}`);

  console.log("\n==================================================");
  console.log("All tests completed.");
  console.log("==================================================");
}

runTests().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
