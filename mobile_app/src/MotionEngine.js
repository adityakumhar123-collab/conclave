// =============================================================================
// MotionEngine.js — BLE Packet → Observation Builder
// =============================================================================
//
// DRY RUN / ARCHITECTURE OVERVIEW
// --------------------------------
// MotionEngine is a stateful singleton that sits between the BLE packet stream
// and the database. Its job is:
//   1. Accumulate incoming FEATURE/EVENT packets into a sliding window buffer
//   2. When the buffer reaches 10 packets (5 seconds of 2Hz data), "build" an
//      Observation: a structured snapshot of those 10 packets including raw
//      embeddings, reconstruction scores, signal features, and a cluster assignment.
//   3. Store the Observation to SQLite via storeObservation().
//   4. Return the Observation to useBle.js which forwards it to EpisodeEngine.
//
// WHO CALLS THIS:
//   → useBle.js calls MotionEngine.onBLEPacket(parsed) for every FEATURE or
//     EVENT packet received from the ESP32.
//   → useBle.js calls MotionEngine.initialize() on BLE connection established.
//
// OUTPUT:
//   → An Observation object (returned every 10 packets, null otherwise) is
//     consumed by EpisodeEngine.updateEpisode() and stored in the DB.
//
// TIMING / BUFFER MECHANICS:
//   - Firmware sends FEATURE packets at 2 Hz → 1 packet per 500ms
//   - Buffer holds 10 packets = 5 seconds of data
//   - Buffer slides by 6 packets (stride of 3s) → new Observation every 3s
//   - Observations are stored every 3s for the ContextEngine 15-minute windows
//
// CLUSTERING (Centroid Matching):
//   - MotionEngine loads cluster centroids from the `motion_clusters` DB table
//     (populated by a background clustering script, currently from the Python
//      training pipeline)
//   - For each observation, it computes the Euclidean distance from each of the
//     10 embeddings to each centroid
//   - Assigns each embedding to its nearest cluster (k-NN with k=1)
//   - Returns a normalized cluster_distribution dict: { "1": 0.7, "2": 0.3 }
//     indicating 70% of embeddings in this window were nearest to cluster 1.
//
// BUGS / NOTES:
//   ⚠ If no cluster centroids have been stored in the DB yet (fresh install,
//     or the clustering script hasn't run), clusterCache will be empty and
//     cluster_distribution will be {} (empty object). The ContextEngine will
//     treat this as an "unfamiliar" context, which is the safe default.
//   ⚠ Duplicate packet filtering uses lastProcessedSequenceId. Since sequenceId
//     wraps at 255, if TWO truly different packets somehow arrive with the same
//     sequenceId in sequence (rare edge case, but possible at wrap-around), one
//     will be silently dropped. This is unlikely to cause problems in practice.
// =============================================================================

import { 
  storeObservation,    // Writes Observation to the `observations` SQLite table
  getMotionClusters,   // Loads cluster centroids from `motion_clusters` table
  getIsoDateString,    // Formats current date as "YYYY-MM-DD"
  getIsoTimeString     // Formats current time as "HH:MM:SS"
} from './Database.js';

class MotionEngineClass {
  constructor() {
    // Sliding window buffer: holds the last N BLE FEATURE/EVENT packets
    this.buffer = [];

    // Cached cluster centroids loaded from SQLite. Each centroid is a 16D float array.
    // Used for nearest-cluster assignment during observation building.
    this.clusterCache = [];

    // Tracks which cluster schema version the centroids belong to.
    // If the training pipeline re-clusters with a new model, this version bumps,
    // and the DB migration drops old observations with the old cluster layout.
    this.currentClusterVersion = 0;

    // The sequenceId of the last successfully processed packet. Used to deduplicate
    // any packets that arrive twice due to BLE notification retransmission.
    this.lastProcessedSequenceId = -1;
  }

  // Called once when BLE connection is established (by useBle.js connectToDevice).
  // Resets the buffer and refreshes the centroid cache from the database.
  initialize() {
    this.buffer = [];
    this.lastProcessedSequenceId = -1;
    this.refreshCentroids(); // Load latest cluster centroids from SQLite
  }

  // Queries the `motion_clusters` table and caches the highest-version centroids
  // in memory (this.clusterCache) to avoid repeated DB queries on every packet.
  refreshCentroids() {
    try {
      const clusters = getMotionClusters(); // Returns only max-version clusters
      this.clusterCache = clusters || [];
      if (this.clusterCache.length > 0) {
        // Use the cluster_version of the first cluster entry as the reference version
        this.currentClusterVersion = this.clusterCache[0].cluster_version || 0;
      } else {
        this.currentClusterVersion = 0;
      }
      console.log(`[MotionEngine] Cache refreshed: Loaded ${this.clusterCache.length} centroids (Version: ${this.currentClusterVersion}).`);
    } catch (e) {
      console.warn('[MotionEngine] Failed to refresh centroids:', e);
      this.clusterCache = [];
      this.currentClusterVersion = 0;
    }
  }

  // Main entry point called by useBle.js for every incoming FEATURE or EVENT packet.
  // Returns an Observation object when the buffer is full (every 10 packets = 5s),
  // or null to signal that more packets are needed before an observation is ready.
  onBLEPacket(packet) {
    if (!packet || packet.sequenceId === undefined) return null;

    // Deduplicate: skip if we've already processed a packet with this sequenceId.
    // This guards against BLE double-delivery of the same notification.
    if (packet.sequenceId === this.lastProcessedSequenceId) {
      return null;
    }

    this.lastProcessedSequenceId = packet.sequenceId;

    // Push the new packet into the circular buffer
    this.buffer.push(packet);

    // When the buffer reaches exactly 10 packets (= 5 seconds of 2 Hz data),
    // we have enough data to build a semantic "Observation" object.
    if (this.buffer.length === 10) {
      const observation = this.buildObservation();
      
      // Slide the window forward by 6 packets (stride = 3 seconds):
      // Remove the OLDEST 6 packets, retaining the 4 most recent ones.
      // This 60% overlap between windows provides temporal continuity —
      // consecutive observations share 4 packets of common context.
      this.buffer.splice(0, 6);

      return observation; // Non-null: caller (useBle.js) forwards to EpisodeEngine
    }

    return null; // Still accumulating — not enough packets yet
  }

  // Builds a structured Observation from the current 10-packet buffer.
  // This is called once every 6 packets (every stride = 3 seconds).
  buildObservation() {
    if (this.buffer.length !== 10) return null;

    // The latest packet's timestamp and sequence serve as the observation's anchor
    const latestPacket = this.buffer[9];

    // Extract the 10 embeddings from each packet's motionEmbedding field.
    // Each embedding is a 16D float vector (dequantized from int8 in BleService.js).
    const embeddings = this.buffer.map(p => p.motionEmbedding);

    // Extract the 10 anomaly reconstruction scores (dequantized MAE floats)
    const reconstruction_scores = this.buffer.map(p => p.anomalyScore);

    // Extract rich signal features from each packet for contextual storage
    const motion_features = this.buffer.map(p => ({
      sequenceId: p.sequenceId,
      motionState: p.motionState,          // Bitmask: Still/Periodic/etc.
      dominantFreq: p.dominantFreq,        // Hz
      zcr: p.zcr,                          // Zero-crossing rate
      spectralEntropy: p.spectralEntropy,  // Spectral disorder metric
      eigenvalueRatio: p.eigenvalueRatio,  // Linearity metric (>700 = fall-like)
      wearConfidence: p.wearConfidence,    // % certainty wristband is worn
      peakAccel: p.peakAccel,              // Maximum acceleration in window (mg)
      anomalyDuration: p.anomalyDuration,  // How long anomaly has persisted (×100ms)
      twelveFeatures: p.twelveFeatures || [] // The dequantized 12-feature array
    }));

    // ===========================================================================
    // CLUSTER ASSIGNMENT (k-NN with k=1, Euclidean distance in 16D embedding space)
    // For each of the 10 embeddings, find the single nearest cluster centroid.
    // Then normalize the count of nearest-cluster assignments to build a probability
    // distribution across clusters: { "1": 0.7, "2": 0.3 } means 70% of the
    // window's embeddings fell closest to cluster 1.
    // ===========================================================================
    const cluster_distribution = {};
    if (this.clusterCache.length > 0) {
      const clusterCounts = {}; // cluster_id → count of embeddings assigned to it
      
      for (const emb of embeddings) {
        if (!emb) continue; // Skip if embedding is null (e.g. from a bad packet)

        let minDistance = Infinity;
        let nearestClusterId = null;

        // Find the closest centroid using L2 (Euclidean) distance in 16D space
        for (const cluster of this.clusterCache) {
          const dist = this.getEuclideanDistance(emb, cluster.centroid);
          if (dist < minDistance) {
            minDistance = dist;
            nearestClusterId = cluster.cluster_id;
          }
        }

        // Tally: increment count for whichever cluster won for this embedding
        if (nearestClusterId !== null) {
          clusterCounts[nearestClusterId] = (clusterCounts[nearestClusterId] || 0) + 1;
        }
      }

      // Normalize counts so they sum to 1.0 (probability distribution)
      const totalMatched = Object.values(clusterCounts).reduce((a, b) => a + b, 0);
      if (totalMatched > 0) {
        for (const [clusterId, count] of Object.entries(clusterCounts)) {
          cluster_distribution[clusterId] = count / totalMatched;
        }
      }
    }
    // If clusterCache is empty, cluster_distribution stays {} — ContextEngine
    // will treat this as an unfamiliar context (safe default behavior).

    // Stamp observation with the current wall-clock date and time
    const dateStr = getIsoDateString();
    const timeStr = getIsoTimeString();

    const obs = {
      date: dateStr,
      time: timeStr,
      embeddings,              // Array of 10 × 16D float vectors
      reconstruction_scores,   // Array of 10 MAE float values
      motion_features,         // Array of 10 feature dicts (rich signal metadata)
      cluster_distribution,    // Normalized cluster assignment probability
      cluster_version: this.currentClusterVersion // Schema version for DB compat
    };

    // Persist the observation to the `observations` SQLite table.
    // This is the source of truth for ContextEngine's 15-minute windows.
    try {
      const observation_id = storeObservation(obs);
      obs.observation_id = observation_id; // Attach the auto-generated DB row ID
    } catch (e) {
      console.warn('[MotionEngine] Failed to write observation to DB:', e);
      // Non-fatal: observation is still returned even if DB write fails
    }

    return obs;
  }

  // Computes Euclidean (L2) distance between two 16-dimensional float vectors.
  // Used for nearest-cluster centroid matching in buildObservation().
  getEuclideanDistance(a, b) {
    let sum = 0;
    for (let i = 0; i < 16; i++) {
      const diff = a[i] - b[i]; // Component-wise difference
      sum += diff * diff;        // Sum of squared differences
    }
    return Math.sqrt(sum); // Square root gives L2 norm
  }
}

// Export as a singleton — there is only ever one MotionEngine in the app.
// All callers (useBle.js) share the same stateful buffer and centroid cache.
export const MotionEngine = new MotionEngineClass();
