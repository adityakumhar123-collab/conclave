// =============================================================================
// EpisodeEngine.js — Motion Continuity Segmentation and Episode Tracking
// =============================================================================
//
// DRY RUN / ARCHITECTURE OVERVIEW
// --------------------------------
// EpisodeEngine converts the stream of short Observations (every 3s from
// MotionEngine) into a continuous timeline of "Episodes" — longer segments of
// sustained, dominant motion behavior.
//
// WHAT IS AN EPISODE?
//   An "episode" is a period of time during which the wearer's dominant motion
//   cluster remains the same. Examples:
//     - Walking (cluster 1) for 4 minutes → one episode
//     - Running (cluster 2) for 1 minute → second episode
//   When the dominant cluster changes, the current episode is CLOSED and a new
//   one STARTS. This gives a high-level timeline: "user walked 4 min, then ran 1 min."
//
// DATA FLOW:
//   MotionEngine.buildObservation()
//     ↓ (returns Observation every 3 seconds)
//   useBle.js calls EpisodeEngine.updateEpisode(obs, familiarityScore)
//     ↓
//   EpisodeEngine decides: CREATE new episode | EXTEND current | CLOSE + CREATE
//     ↓
//   Writes to SQLite via: saveEpisode() + saveEpisodeTimeline()
//     ↓ (the final persisted episodes are queried by ContextEngine.runInference)
//   Output → returns current activeEpisode to useBle.js (for dashboard logs)
//
// FILES USED:
//   → Database.js for: saveEpisode, saveEpisodeTimeline, getIsoDateString,
//                       getIsoTimeString, initDatabase
//
// OUTPUT:
//   → Stored rows in `episodes` and `episode_motion_timelines` SQLite tables
//   → The activeEpisode object is returned to useBle.js (used in log messages)
//
// FAMILIARITY STATISTICS:
//   Each episode tracks the familiarity score (from LocationEngine) at each
//   3-second stride using Welford's Online Algorithm for numerically stable
//   running mean and variance (avoids catastrophic cancellation from large sums).
//
// BUGS / NOTES:
//   ⚠ The stride duration is hardcoded to 3.0 seconds (each observation from
//     MotionEngine = 10 packets × 500ms stride = 5s window, but with 3s stride
//     timing). If inference rate changes, this hardcoded value would need updating.
//   ⚠ restoreActiveEpisode() reconnects to any open episode from a previous
//     session if the app was closed mid-session. This correctly recovers state
//     across app restarts, but the Welford M2 is only APPROXIMATED (M2 = variance
//     × n), which loses precision if the distribution was non-normal.
// =============================================================================

import {
  initDatabase,       // Required for restoreActiveEpisode() raw DB query
  saveEpisode,        // Upsert an episode row (insert if new, update if existing)
  saveEpisodeTimeline, // Append one timeline entry for this observation stride
  getIsoDateString,   // "YYYY-MM-DD"
  getIsoTimeString    // "HH:MM:SS"
} from './Database.js';

class EpisodeEngineClass {
  constructor() {
    // The currently open (unfinished) Episode object, or null if no episode is active.
    // Mirrors the database row — any field changes here must be saved to DB.
    this.activeEpisode = null;

    // Count of timeline entries (strides) saved for the active episode.
    // Used as the denominator 'n' for Welford's online mean/variance.
    this.timelineLength = 0;

    // Running "M2" accumulator for Welford's online variance algorithm.
    // M2 = sum of squared deviations from the running mean.
    // variance = M2 / n (biased). This avoids storing all familiarity scores.
    this.runningFamiliarityM2 = 0.0;
  }

  // Called when BLE connects (from useBle.js). Resets in-memory state and
  // tries to restore any previously-open episode from the database.
  initialize() {
    this.activeEpisode = null;
    this.timelineLength = 0;
    this.runningFamiliarityM2 = 0.0;
    this.restoreActiveEpisode(); // Resume any session that was open before app restart
  }

  // Queries the DB for any episode row where end_date IS NULL (= still open).
  // If found, restores it as the activeEpisode and reconstructs the Welford M2
  // accumulator from the stored variance so running stats remain consistent.
  restoreActiveEpisode() {
    try {
      const db = initDatabase();
      // Fetch the most-recently opened episode that has no end date (= still running)
      const openEpisode = db.getFirstSync('SELECT * FROM episodes WHERE end_date IS NULL ORDER BY episode_id DESC LIMIT 1;');
      
      if (openEpisode) {
        // Parse the JSON-serialized motion_distribution back to an object
        openEpisode.motion_distribution = JSON.parse(openEpisode.motion_distribution);
        
        // Count existing timeline entries to restore the correct Welford 'n'
        const countRow = db.getFirstSync(
          'SELECT COUNT(*) as count FROM episode_motion_timelines WHERE episode_id = ?;',
          [openEpisode.episode_id]
        );
        this.timelineLength = countRow ? countRow.count : 0;
        
        // Approximate M2 from stored variance: M2 = variance × n (biased form)
        // NOTE: This is an approximation — exact M2 cannot be recovered without
        // all original data points. In practice, the error is acceptable.
        this.runningFamiliarityM2 = (openEpisode.familiarity_variance || 0.0) * this.timelineLength;
        this.activeEpisode = openEpisode;
        
        console.log(`[EpisodeEngine] Restored open Episode ID: ${openEpisode.episode_id}. Stride count: ${this.timelineLength}`);
      } else {
        this.activeEpisode = null;
      }
    } catch (e) {
      console.warn('[EpisodeEngine] Failed to restore open episode:', e);
      this.activeEpisode = null;
    }
  }

  // Main entry point — called by useBle.js for every Observation returned by MotionEngine.
  // Evaluates what the dominant motion cluster of this observation is, then decides
  // whether to CREATE, EXTEND, or CLOSE+CREATE an episode.
  //
  // @param observation   - The Observation object from MotionEngine.buildObservation()
  // @param familiarityScore - A 0.0–1.0 float from LocationEngine.estimateFamiliarity(),
  //                          or null if GPS is unavailable
  // @returns             - The current activeEpisode (or null if nothing is open)
  updateEpisode(observation, familiarityScore = null) {
    if (!observation) return null;

    // 1. Determine the dominant motion state for this observation:
    //    Find the cluster with the highest probability in cluster_distribution.
    //    e.g. { "1": 0.7, "2": 0.3 } → dominantState = "1"
    let dominantState = '0'; // Default / Unlabeled cluster (no centroids loaded)
    let maxProb = -1;

    if (observation.cluster_distribution && Object.keys(observation.cluster_distribution).length > 0) {
      for (const [clusterId, prob] of Object.entries(observation.cluster_distribution)) {
        if (prob > maxProb) {
          maxProb = prob;
          dominantState = clusterId;
        }
      }
    }

    // 2. State Machine: Evaluate Episode Transitions
    if (!this.activeEpisode) {
      // State: No open episode → CREATE one for this observation's dominant cluster
      this.createEpisode(observation, dominantState, familiarityScore);
    } else {
      // State: Episode currently open — find its dominant cluster
      const currentEpisodeDominant = this.getEpisodeDominantState(this.activeEpisode);

      if (dominantState === currentEpisodeDominant) {
        // Dominant cluster UNCHANGED → EXTEND the current episode by one stride
        this.extendEpisode(observation, familiarityScore);
      } else {
        // Dominant cluster CHANGED → CLOSE the old episode, CREATE a new one
        this.closeEpisode(observation); // Close with this obs's timestamp as the end
        this.createEpisode(observation, dominantState, familiarityScore);
      }
    }

    return this.activeEpisode;
  }

  // Creates a brand new Episode in the database. Called when:
  //   (a) There was no previously open episode, or
  //   (b) The dominant motion cluster just changed.
  createEpisode(obs, dominantState, familiarityScore) {
    const fam = familiarityScore !== null ? familiarityScore : null;
    this.timelineLength = 1;         // First stride = 1
    this.runningFamiliarityM2 = 0.0; // No variance yet with a single sample

    // Construct the episode object in memory first
    this.activeEpisode = {
      start_date: obs.date,
      start_time: obs.time,
      end_date: null,   // null = episode is OPEN (still ongoing)
      end_time: null,
      duration: 3.0,    // First stride = 3 seconds (hardcoded stride duration)
      motion_distribution: { ...obs.cluster_distribution }, // Clone to avoid mutation
      familiarity_mean: fam,
      familiarity_min: fam,
      familiarity_max: fam,
      familiarity_variance: 0.0
    };

    try {
      // Persist to DB and get back the auto-incremented episode_id
      const episodeId = saveEpisode(this.activeEpisode);
      this.activeEpisode.episode_id = episodeId; // Attach DB ID to in-memory object
      console.log(`[EpisodeEngine] Opened Episode ID ${episodeId} for dominant motion cluster: ${dominantState}`);

      // Record the first timeline entry for this episode's first stride
      this.saveTimelineEntry(obs);
    } catch (e) {
      console.warn('[EpisodeEngine] Failed to create new episode:', e);
    }
  }

  // Extends the current open episode by one stride (3 seconds).
  // Updates the motion distribution using an online averaging formula,
  // increments the duration, and updates familiarity statistics using Welford's algorithm.
  extendEpisode(obs, familiarityScore) {
    if (!this.activeEpisode) return;

    this.timelineLength += 1;
    const n = this.timelineLength; // Current number of strides (used as denominator)

    // 1. Update the running motion distribution using online averaging:
    //    P_new[k] = P_old[k] + (P_obs[k] - P_old[k]) / n
    //    This is the Welford-style running mean for each cluster dimension.
    const newDistribution = { ...this.activeEpisode.motion_distribution };
    const allKeys = new Set([
      ...Object.keys(newDistribution),
      ...Object.keys(obs.cluster_distribution || {})
    ]);

    for (const key of allKeys) {
      const oldVal = newDistribution[key] || 0.0;
      const newVal = (obs.cluster_distribution && obs.cluster_distribution[key]) || 0.0;
      newDistribution[key] = oldVal + (newVal - oldVal) / n; // Online mean update
    }
    this.activeEpisode.motion_distribution = newDistribution;

    // 2. Grow the total duration by one stride (3.0 seconds per stride)
    this.activeEpisode.duration = n * 3.0;

    // 3. Update running familiarity statistics using Welford's Online Algorithm.
    //    This avoids accumulating a large sum of squared values (numerical stability).
    if (familiarityScore !== null) {
      const x = familiarityScore;

      // Update Min/Max bounds
      if (this.activeEpisode.familiarity_min === null || x < this.activeEpisode.familiarity_min) {
        this.activeEpisode.familiarity_min = x;
      }
      if (this.activeEpisode.familiarity_max === null || x > this.activeEpisode.familiarity_max) {
        this.activeEpisode.familiarity_max = x;
      }

      // Welford's running mean and M2 accumulator:
      const oldMean = this.activeEpisode.familiarity_mean !== null ? this.activeEpisode.familiarity_mean : 0.0;
      const newMean = oldMean + (x - oldMean) / n;                    // δ₁ = x - old_mean
      this.runningFamiliarityM2 = this.runningFamiliarityM2 + (x - oldMean) * (x - newMean); // M2 += δ₁ × δ₂

      this.activeEpisode.familiarity_mean = newMean;
      this.activeEpisode.familiarity_variance = this.runningFamiliarityM2 / n; // Biased population variance
    }

    try {
      // Persist the updated episode and add this stride's timeline entry
      saveEpisode(this.activeEpisode);
      this.saveTimelineEntry(obs);
    } catch (e) {
      console.warn('[EpisodeEngine] Failed to extend episode:', e);
    }
  }

  // Closes the currently open episode by writing its end date/time to the DB.
  // Called when:
  //   (a) The dominant motion cluster has changed (a new one will be created next), or
  //   (b) Manually called on disconnect (via useBle.js or App.js lifecycle)
  closeEpisode(obs = null) {
    if (!this.activeEpisode) return;

    // Use the observation's timestamp as the end time if provided, else use now
    const dateStr = obs ? obs.date : getIsoDateString();
    const timeStr = obs ? obs.time : getIsoTimeString();

    this.activeEpisode.end_date = dateStr;
    this.activeEpisode.end_time = timeStr;

    try {
      saveEpisode(this.activeEpisode); // Persist the closed state to DB
      console.log(`[EpisodeEngine] Closed Episode ID ${this.activeEpisode.episode_id}. Final duration: ${this.activeEpisode.duration}s`);
    } catch (e) {
      console.warn('[EpisodeEngine] Failed to close episode:', e);
    }

    // Reset all in-memory state — ready for the next episode
    this.activeEpisode = null;
    this.timelineLength = 0;
    this.runningFamiliarityM2 = 0.0;
  }

  // Appends a single timeline entry to the `episode_motion_timelines` table.
  // Each timeline entry records one stride (3 seconds) of the current episode.
  // The reconstruction_mean is the average anomaly MAE across all 10 packets in obs.
  saveTimelineEntry(obs) {
    if (!this.activeEpisode) return;

    // Compute the mean reconstruction error across all packets in this observation
    const recSum = obs.reconstruction_scores.reduce((a, b) => a + b, 0);
    const recMean = obs.reconstruction_scores.length > 0 ? recSum / obs.reconstruction_scores.length : 0.0;

    const entry = {
      episode_id: this.activeEpisode.episode_id,
      window_start_date: obs.date,
      window_start_time: obs.time,
      motion_distribution: obs.cluster_distribution,
      reconstruction_mean: recMean // Average anomaly score for this 5-second window
    };

    saveEpisodeTimeline(entry);
  }

  // Returns the cluster ID string with the highest probability in an episode's
  // averaged motion_distribution. Used to determine whether dominant state changed.
  getEpisodeDominantState(episode) {
    if (!episode || !episode.motion_distribution) return '0';
    let dominantState = '0';
    let maxProb = -1;

    for (const [clusterId, prob] of Object.entries(episode.motion_distribution)) {
      if (prob > maxProb) {
        maxProb = prob;
        dominantState = clusterId;
      }
    }
    return dominantState;
  }
}

// Export as a singleton — shared state across the entire app lifecycle.
// Resets on BLE connect via initialize().
export const EpisodeEngine = new EpisodeEngineClass();
