// Context Engine to assess threat levels based on SafeBand telemetry and environmental context.

export function computeThreatScoreDetailed(packet, contextConfig = {}) {
  const logs = [];
  const {
    location = 'UNKNOWN_URBAN', // 'HOME', 'KNOWN_SAFE', 'UNKNOWN_URBAN', 'UNKNOWN_ISOLATED'
    timeOfDay = 'MORNING', // 'NIGHT_RISK', 'MORNING', 'DAYTIME', 'EVENING', 'LATE_NIGHT'
    postAnomalyStillness = false,
  } = contextConfig;

  // 1. Base Motion Evidence
  // Anomaly score is scaled relative to the 3-sigma threshold (128 = threshold boundary)
  const normalizedScore = packet.anomalyScore / 128.0;
  logs.push(`Raw anomaly score: ${packet.anomalyScore} (Normalized: ${normalizedScore.toFixed(3)})`);
  
  // Weights based on motion state bitmask:
  // Bit 0: Still, Bit 1: Periodic, Bit 2: Aperiodic, Bit 3: High-Impact, Bit 4: Restrained
  let patternWeight = 0.40; // Default weight for UNKNOWN
  let patternName = 'UNKNOWN';
  const isStill = (packet.motionState & (1 << 0)) !== 0;
  const isPeriodic = (packet.motionState & (1 << 1)) !== 0;
  const isAperiodic = (packet.motionState & (1 << 2)) !== 0;
  const isHighImpact = (packet.motionState & (1 << 3)) !== 0;
  const isRestrained = (packet.motionState & (1 << 4)) !== 0;

  if (isHighImpact && packet.eigenvalueRatio > 700) {
    patternWeight = 0.80; // FALL_CANDIDATE
    patternName = 'FALL_CANDIDATE';
  } else if (isAperiodic && packet.anomalyDuration > 60) {
    patternWeight = 0.75; // STRUGGLE_CANDIDATE
    patternName = 'STRUGGLE_CANDIDATE';
  } else if (isPeriodic && packet.spectralEntropy < 100) {
    patternWeight = 0.70; // SEIZURE_CANDIDATE
    patternName = 'SEIZURE_CANDIDATE';
  } else if (isRestrained || (isStill && packet.anomalyDuration > 50)) {
    patternWeight = 0.65; // PINNED_CANDIDATE
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

  // 2. Apply Temporal Duration Factor
  // Duration is in 100ms units
  const durationSec = packet.anomalyDuration * 0.1;

  // Score-proportional minimum: ensures a high-confidence TinyML detection (score near 255)
  // registers on the threat gauge even when duration data is unavailable (FEATURE packets missing).
  // At score=0   → minFactor=0.00 (no spurious threat from zero-score packets)
  // At score=128 → minFactor=0.28 (threshold boundary — small but non-zero)
  // At score=255 → minFactor=0.55 (max-confidence detection always shows ≥ LOW_ALERT)
  const scoreConfidence = packet.anomalyScore / 255;
  const minDurationFactor = scoreConfidence * 0.55;

  let durationFactor = minDurationFactor;
  if (durationSec < 1.5) {
    durationFactor = Math.max(minDurationFactor, 0.10); // Transient — use score minimum
  } else if (durationSec < 3.0) {
    durationFactor = Math.max(minDurationFactor, 0.35);
  } else if (durationSec < 6.0) {
    durationFactor = Math.max(minDurationFactor, 0.60);
  } else if (durationSec < 12.0) {
    durationFactor = Math.max(minDurationFactor, 0.80);
  } else {
    durationFactor = Math.max(minDurationFactor, 0.95); // Sustained anomaly
  }
  threatScore *= durationFactor;
  logs.push(`Anomaly Duration: ${durationSec.toFixed(1)}s | Score confidence: ${Math.round(scoreConfidence*100)}% | DurationFactor: ${durationFactor.toFixed(2)}, threat score: ${threatScore.toFixed(3)}`);

  // 3. Post-Anomaly Stillness Bonus
  if (postAnomalyStillness) {
    threatScore += 0.15;
    logs.push(`Post-Anomaly Stillness active, threat score (+0.15): ${threatScore.toFixed(3)}`);
  }

  // 4. Location Context Multiplier
  let locationMultiplier = 1.00;
  if (location === 'HOME') locationMultiplier = 0.55;
  else if (location === 'KNOWN_SAFE') locationMultiplier = 0.65;
  else if (location === 'UNKNOWN_ISOLATED') locationMultiplier = 1.35;
  threatScore *= locationMultiplier;
  if (locationMultiplier !== 1.0) {
    logs.push(`Location: ${location} (Multiplier: ${locationMultiplier}), threat score: ${threatScore.toFixed(3)}`);
  }

  // 5. Time of Day Multiplier
  let timeMultiplier = 1.00;
  if (timeOfDay === 'NIGHT_RISK') timeMultiplier = 1.20;
  else if (timeOfDay === 'DAYTIME') timeMultiplier = 0.90;
  else if (timeOfDay === 'LATE_NIGHT') timeMultiplier = 1.15;
  threatScore *= timeMultiplier;
  if (timeMultiplier !== 1.0) {
    logs.push(`Time of Day: ${timeOfDay} (Multiplier: ${timeMultiplier}), threat score: ${threatScore.toFixed(3)}`);
  }

  // 6. Wear Confidence Multiplier & Suppression
  if (packet.wearConfidence < 40) {
    threatScore = 0.0; // Complete suppression if unworn
    logs.push(`Wear Confidence degraded to ${packet.wearConfidence}% (BELOW 40%), FULL ALARM SUPPRESSION applied (threat = 0)`);
  } else if (packet.wearConfidence < 60) {
    threatScore *= 0.50; // High discount for low confidence
    logs.push(`Wear Confidence degraded to ${packet.wearConfidence}%, applying 0.50 discount, threat score: ${threatScore.toFixed(3)}`);
  } else if (packet.wearConfidence < 80) {
    threatScore *= 0.80;
    logs.push(`Wear Confidence slightly degraded to ${packet.wearConfidence}%, applying 0.80 discount, threat score: ${threatScore.toFixed(3)}`);
  }

  // Clamp threat score to range [0.0, 1.0]
  const finalScore = Math.min(Math.max(threatScore, 0.0), 1.0);
  logs.push(`Final threat score (clamped [0-1]): ${finalScore.toFixed(3)}`);

  return {
    score: finalScore,
    explanation: logs
  };
}

export function computeThreatScore(packet, contextConfig = {}) {
  return computeThreatScoreDetailed(packet, contextConfig).score;
}

export function getThreatLevel(score) {
  if (score < 0.40) return { name: 'NORMAL', color: '#10B981', action: 'Log event silently' };
  if (score < 0.55) return { name: 'LOW_ALERT', color: '#3B82F6', action: 'Phone haptic warning' };
  if (score < 0.72) return { name: 'ELEVATED', color: '#F59E0B', action: 'Screen notification, start countdown' };
  if (score < 0.88) return { name: 'HIGH', color: '#EF4444', action: 'Full-screen overlay alert (15s cancel)' };
  return { name: 'CRITICAL', color: '#B91C1C', action: 'Immediate emergency dispatch' };
}
