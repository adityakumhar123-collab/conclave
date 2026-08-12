import { 
  initDatabase,
  saveMotionCluster,
  enforceRetentionPolicy,
  getIsoDateString,
  getIsoTimeString 
} from './Database.js';
import { MotionEngine } from './MotionEngine.js';

// Helper: Euclidean distance
function getEuclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < 16; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

// Helper: Calculate covariance matrix (outer product)
function getCovarianceMatrix(embeddings, centroid) {
  const n = embeddings.length;
  const cov = Array.from({ length: 16 }, () => new Array(16).fill(0.0));
  if (n === 0) return cov;

  for (const emb of embeddings) {
    const diff = emb.map((x, i) => x - centroid[i]);
    for (let r = 0; r < 16; r++) {
      for (let c = 0; c < 16; c++) {
        cov[r][c] += diff[r] * diff[c];
      }
    }
  }

  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 16; c++) {
      cov[r][c] /= n;
    }
  }
  return cov;
}

class BackgroundServicesClass {
  constructor() {
    this.isReassignmentRunning = false;
  }

  // 1. Offline K-Means Clustering Run
  runClusteringService(k = 3) {
    const db = initDatabase();
    console.log(`[BackgroundServices] Starting offline clustering pass (K = ${k})...`);

    // Fetch all observations to collect 16-D embeddings and anomaly scores
    let rows = [];
    try {
      rows = db.getAllSync('SELECT embeddings, reconstruction_scores FROM observations;');
    } catch (e) {
      console.warn('[BackgroundServices] Failed to fetch observations for clustering:', e);
      return null;
    }

    // Unpack data points
    const dataPoints = [];
    rows.forEach(row => {
      let embs = [];
      let scores = [];
      try {
        embs = typeof row.embeddings === 'string' ? JSON.parse(row.embeddings) : row.embeddings;
        scores = typeof row.reconstruction_scores === 'string' ? JSON.parse(row.reconstruction_scores) : row.reconstruction_scores;
      } catch (e) {
        return;
      }
      
      if (embs && embs.length > 0) {
        embs.forEach((emb, idx) => {
          dataPoints.push({
            embedding: emb,
            score: scores[idx] || 0.0
          });
        });
      }
    });

    const minRequiredSamples = k * 5;
    if (dataPoints.length < minRequiredSamples) {
      console.log(`[BackgroundServices] Clustering skipped: Insufficient embeddings (Count: ${dataPoints.length}, Minimum: ${minRequiredSamples})`);
      return null;
    }

    const vectors = dataPoints.map(dp => dp.embedding);

    // K-Means Initialization: Select random unique data points as initial centroids
    const centroids = [];
    const usedIndices = new Set();
    while (centroids.length < k && usedIndices.size < vectors.length) {
      const randIdx = Math.floor(Math.random() * vectors.length);
      if (!usedIndices.has(randIdx)) {
        usedIndices.add(randIdx);
        centroids.push([...vectors[randIdx]]);
      }
    }

    const assignments = new Array(vectors.length).fill(-1);
    let converged = false;

    // Iterative assignment (Max 30 iterations)
    for (let iter = 0; iter < 30; iter++) {
      let changed = false;

      // Assign vectors to nearest centroid
      for (let i = 0; i < vectors.length; i++) {
        let minDist = Infinity;
        let bestCentroidIdx = -1;

        for (let j = 0; j < k; j++) {
          const dist = getEuclideanDistance(vectors[i], centroids[j]);
          if (dist < minDist) {
            minDist = dist;
            bestCentroidIdx = j;
          }
        }

        if (assignments[i] !== bestCentroidIdx) {
          assignments[i] = bestCentroidIdx;
          changed = true;
        }
      }

      // Recalculate centroids
      const sums = Array.from({ length: k }, () => new Array(16).fill(0.0));
      const counts = new Array(k).fill(0);

      for (let i = 0; i < vectors.length; i++) {
        const centroidIdx = assignments[i];
        if (centroidIdx >= 0 && centroidIdx < k) {
          counts[centroidIdx]++;
          for (let d = 0; d < 16; d++) {
            sums[centroidIdx][d] += vectors[i][d];
          }
        }
      }

      let emptyResetOccurred = false;
      for (let j = 0; j < k; j++) {
        if (counts[j] > 0) {
          for (let d = 0; d < 16; d++) {
            centroids[j][d] = sums[j][d] / counts[j];
          }
        } else {
          // Robust empty cluster resolution: reset centroid to a random data point
          const randIdx = Math.floor(Math.random() * vectors.length);
          centroids[j] = [...vectors[randIdx]];
          emptyResetOccurred = true;
          changed = true;
        }
      }

      if (!changed && !emptyResetOccurred) {
        converged = true;
        break;
      }
    }

    // 2. Centroid Validation Gate Checks
    console.log('[BackgroundServices] Executing Centroid Validation checks...');
    
    // Assert finite numbers
    for (let j = 0; j < k; j++) {
      for (let d = 0; d < 16; d++) {
        if (isNaN(centroids[j][d]) || !isFinite(centroids[j][d])) {
          console.warn(`[BackgroundServices] Aborted clustering run: Centroid ${j} contains NaN or non-finite values.`);
          return null;
        }
      }
    }

    // Assert no empty clusters in final output
    const clusterAssignedCounts = new Array(k).fill(0);
    assignments.forEach(cIdx => {
      if (cIdx >= 0 && cIdx < k) {
        clusterAssignedCounts[cIdx]++;
      }
    });
    for (let j = 0; j < k; j++) {
      if (clusterAssignedCounts[j] === 0) {
        console.warn(`[BackgroundServices] Aborted clustering run: Cluster ${j} has zero assigned samples.`);
        return null;
      }
    }

    console.log('[BackgroundServices] Validation successful. Persisting new cluster version...');

    // 3. Increment Version
    let maxVersion = 0;
    try {
      const maxVerRow = db.getFirstSync('SELECT MAX(cluster_version) as max_version FROM motion_clusters;');
      maxVersion = maxVerRow && maxVerRow.max_version !== null ? maxVerRow.max_version : 0;
    } catch (e) {
      // Ignore
    }
    const nextVersion = maxVersion + 1;

    // Calculate cluster statistics and save to DB under nextVersion
    const dateStr = getIsoDateString();
    const timeStr = getIsoTimeString();

    for (let j = 0; j < k; j++) {
      const clusterEmbs = [];
      const clusterScores = [];
      for (let i = 0; i < vectors.length; i++) {
        if (assignments[i] === j) {
          clusterEmbs.push(vectors[i]);
          clusterScores.push(dataPoints[i].score);
        }
      }

      const covariance = getCovarianceMatrix(clusterEmbs, centroids[j]);
      const recMean = clusterScores.reduce((a, b) => a + b, 0) / clusterScores.length;

      const clusterObj = {
        cluster_id: j + 1,
        cluster_version: nextVersion,
        centroid: centroids[j],
        covariance: covariance,
        visit_count: clusterEmbs.length,
        reconstruction_mean: recMean,
        motion_summary: { label: `Motion Pattern ${j + 1}` }
      };

      try {
        saveMotionCluster(clusterObj);
      } catch (e) {
        console.warn(`[BackgroundServices] Failed to save cluster ${j + 1}:`, e);
        return null;
      }
    }

    console.log(`[BackgroundServices] Successfully stored Version ${nextVersion} clusters in database (Date: ${dateStr}, Time: ${timeStr}).`);

    // 4. Update memory cache of MotionEngine immediately
    try {
      MotionEngine.refreshCentroids();
    } catch (e) {
      console.warn('[BackgroundServices] Failed to signal refresh centroids to MotionEngine:', e);
    }

    // 5. Reset progress register to trigger historical reassignment
    try {
      db.runSync("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_reassigned_observation_id', '0');");
    } catch (e) {
      console.warn('[BackgroundServices] Failed to reset reassignment progress settings:', e);
    }

    return nextVersion;
  }

  // 2. Resumable Batch Reassignment
  runHistoricalReassignment(batchSize = 500) {
    const db = initDatabase();

    // Query active highest version
    let currentVersion = 0;
    try {
      const maxVerRow = db.getFirstSync('SELECT MAX(cluster_version) as max_version FROM motion_clusters;');
      if (!maxVerRow || maxVerRow.max_version === null) return false;
      currentVersion = maxVerRow.max_version;
    } catch (e) {
      return false;
    }

    // Query offset progress from settings
    let lastId = 0;
    try {
      const progressRow = db.getFirstSync("SELECT value FROM settings WHERE key = 'last_reassigned_observation_id';");
      lastId = progressRow ? Number(progressRow.value) : 0;
    } catch (e) {
      // Ignore
    }

    // Retrieve observations needing updates
    let batch = [];
    try {
      batch = db.getAllSync(`
        SELECT * FROM observations 
        WHERE observation_id > ? AND (cluster_version < ? OR cluster_distribution = '{}')
        ORDER BY observation_id ASC
        LIMIT ?;
      `, [lastId, currentVersion, batchSize]);
    } catch (e) {
      console.warn('[BackgroundServices] Failed to query observations batch:', e);
      return false;
    }

    if (batch.length === 0) {
      // Reassignment completed successfully!
      // Safely delete older cluster versions now
      try {
        db.runSync('DELETE FROM motion_clusters WHERE cluster_version < ?;', [currentVersion]);
        console.log(`[BackgroundServices] Historical reassignment completed. Deleted older cluster versions (< ${currentVersion}).`);
      } catch (e) {
        console.warn('[BackgroundServices] Failed to clean old cluster versions:', e);
      }
      return false; // No more rows
    }

    // Load active centroids
    let centroids = [];
    try {
      centroids = db.getAllSync('SELECT cluster_id, centroid FROM motion_clusters WHERE cluster_version = ?;', [currentVersion]).map(c => ({
        cluster_id: c.cluster_id,
        centroid: JSON.parse(c.centroid)
      }));
    } catch (e) {
      console.warn('[BackgroundServices] Failed to load active centroids for batch reassignment:', e);
      return false;
    }

    for (const obs of batch) {
      let embeddings = [];
      try {
        embeddings = typeof obs.embeddings === 'string' ? JSON.parse(obs.embeddings) : obs.embeddings;
      } catch (e) {
        continue;
      }

      const cluster_distribution = {};
      if (centroids.length > 0) {
        const clusterCounts = {};
        for (const emb of embeddings) {
          let minDist = Infinity;
          let matchedId = null;

          for (const c of centroids) {
            const dist = getEuclideanDistance(emb, c.centroid);
            if (dist < minDist) {
              minDist = dist;
              matchedId = c.cluster_id;
            }
          }

          if (matchedId !== null) {
            clusterCounts[matchedId] = (clusterCounts[matchedId] || 0) + 1;
          }
        }

        const total = Object.values(clusterCounts).reduce((a, b) => a + b, 0);
        if (total > 0) {
          for (const [clusterId, count] of Object.entries(clusterCounts)) {
            cluster_distribution[clusterId] = count / total;
          }
        }
      }

      // Save reassigned values
      try {
        db.runSync(`
          UPDATE observations 
          SET cluster_distribution = ?, cluster_version = ?
          WHERE observation_id = ?;
        `, [JSON.stringify(cluster_distribution), currentVersion, obs.observation_id]);
      } catch (e) {
        console.warn(`[BackgroundServices] Failed to update observation ID ${obs.observation_id}:`, e);
      }

      lastId = obs.observation_id;
    }

    // Update settings progress
    try {
      db.runSync("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_reassigned_observation_id', ?);", [String(lastId)]);
      console.log(`[BackgroundServices] Reassigned batch of ${batch.length} observations. Progress ID: ${lastId}`);
    } catch (e) {
      console.warn('[BackgroundServices] Failed to write progress offset to settings:', e);
    }

    return true; // Still has items to process
  }

  // 3. Database Cleanup
  runDatabaseCleanup() {
    try {
      const stats = enforceRetentionPolicy();
      console.log(`[BackgroundServices] Database cleanup successful: deleted ${stats.deletedObservations} observations, ${stats.deletedTimelines} timelines, and ${stats.deletedInferences} inferences.`);
      return stats;
    } catch (e) {
      console.warn('[BackgroundServices] Database cleanup failed:', e);
      return null;
    }
  }
}

export const BackgroundServices = new BackgroundServicesClass();
