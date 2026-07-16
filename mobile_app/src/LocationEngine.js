// =============================================================================
// LocationEngine.js — GPS Geofencing, Location Node Learning, Visit Tracking
// =============================================================================
//
// DRY RUN / ARCHITECTURE OVERVIEW
// --------------------------------
// LocationEngine manages where the user physically is, and whether they are in
// a "known" place or somewhere new. It builds a map of places the user
// regularly visits (called Location Nodes) and tracks how long they stay.
//
// WHAT IS A LOCATION NODE?
//   A Location Node is a circular geofenced area with:
//     - A center (latitude, longitude)
//     - A radius (default 30 meters)
//     - Visit statistics (total visits, total stay time)
//   Nodes are AUTOMATICALLY learned — when the user stays in one location for
//   >= MIN_STAY_DURATION (default 5 minutes), a new Node is created there.
//   Examples: Home, Office, Gym, Coffee shop the user visits regularly.
//
// WHAT IS A LOCATION VISIT?
//   A Visit is an instance of entering and exiting a known Location Node.
//   Each visit records enter/exit timestamps and GPS coordinates.
//   This data feeds the ContextEngine familiarity assessment.
//
// DATA FLOW:
//   expo-location (GPS updates via BackgroundServices.js or App.js)
//     ↓ LocationEngine.onLocationUpdate(gpsUpdate)
//     ↓ Accuracy filter → discard readings > 50m accuracy
//     ↓ Geofence matching: scan knownNodes for proximity within entry/exit radius
//     ↓ State machine: start/update/close visit for the matched node
//     ↓ Candidate tracking: if no node matched and user stays, create a new node
//   Database.js: saveLocationNode() + saveLocationVisit()
//
// KEY PARAMETERS (Configurable):
//   ENTRY_RADIUS    = 20m  — must be within this to START a visit
//   EXIT_RADIUS     = 30m  — must be OUTSIDE this to END a visit (hysteresis)
//   CANDIDATE_RADIUS = 50m — how far user can wander and still be "at same new place"
//   MIN_STAY_DURATION = 5 min — minimum time to stay before creating a new node
//
// HYSTERESIS (Entry vs Exit radius):
//   Using a smaller entry radius and larger exit radius prevents flapping:
//   - If GPS jitter bounces between 18m and 22m, a single 20m threshold
//     would trigger constant enter/exit cycles.
//   - With 20m entry / 30m exit: once inside, you must move further away to exit.
//
// FAMILIARITY ESTIMATION:
//   estimateFamiliarity(lat, lon) returns a 0.0–1.0 score representing how
//   familiar the current location is to the user:
//     - 1.0 = inside a known node's geofence
//     - 0.0 = far from all known nodes (unknown territory)
//   Used by useBle.js to modulate the ContextEngine threat score.
//
// FILES USED:
//   → Database.js for: saveLocationNode, getLocationNodes, saveLocationVisit,
//                       initDatabase, getIsoDateString, getIsoTimeString
//
// OUTPUT:
//   → this.activeVisit — current visit object (exposed publicly, used by ContextEngine)
//   → this.currentGps  — most recent valid GPS fix (exposed publicly)
//   → Stored rows in `location_nodes` and `location_visits` SQLite tables
//
// BUGS / NOTES:
//   ⚠ candidateNode tracking resets (and loses elapsed time) every time the user
//     temporarily steps > 50m away from the candidate center, even briefly.
//     A more robust design would use a "persistence" timer or re-centering.
//   ⚠ The MIN_STAY_DURATION clock starts from when the CANDIDATE is first seen —
//     not from when the user first arrived (if they initially moved around before
//     settling). This could cause early node creation for slowly-settling locations.
//   ⚠ closeVisit() calls refreshNodes() which reloads ALL nodes from DB. For
//     users with many visited places, this could become a slow synchronous call.
// =============================================================================

import { 
  initDatabase,       // Direct DB access for restoreActiveVisit()
  saveLocationNode,   // Upsert a location node record
  getLocationNodes,   // Load all known nodes into memory
  saveLocationVisit,  // Upsert a location visit record
  getIsoDateString,   // "YYYY-MM-DD"
  getIsoTimeString    // "HH:MM:SS"
} from './Database.js';

class LocationEngineClass {
  constructor() {
    // The most recent valid GPS fix (object with latitude, longitude, accuracy, timestamp)
    // Exposed publicly — ContextEngine and useBle.js read this directly.
    this.currentGps = null;

    // Unix timestamp (ms) of the last GPS update. Used by the watchdog to detect staleness.
    this.lastUpdateTimestamp = 0;

    // 'OK' if GPS was updated recently, 'STALE' if no update in > 30 seconds.
    // Candidate node creation is paused when STALE to avoid creating nodes from
    // cached/wrong positions.
    this.locationStatus = 'STALE';

    // The currently active visit (if user is inside a known node), or null.
    // Exposed publicly — ContextEngine uses this to associate a locationNodeId
    // with the current inference.
    this.activeVisit = null;

    // In-memory cache of all known Location Node records from the DB.
    // Refreshed on initialize() and after any node is created or visited closed.
    this.knownNodes = [];

    // Tracks a potential new location node when the user is at an unknown place.
    // Reset to null when the user moves far away or when a new node is created.
    this.candidateNode = null;
    
    // --- Geofencing Threshold Parameters ---
    this.ENTRY_RADIUS = 20;          // meters: must be within this to START a visit
    this.EXIT_RADIUS = 30;           // meters: must be OUTSIDE this to END a visit (hysteresis)
    this.CANDIDATE_RADIUS = 50;      // meters: how far user can be from candidate center
    this.MIN_STAY_DURATION = 5 * 60 * 1000; // 5 minutes in ms: required stay before new node
  }

  // Called on app startup or BLE connect to reset state and reload known nodes.
  // @param minStayDurationMs — optionally override the default 5-minute threshold
  initialize(minStayDurationMs = null) {
    if (minStayDurationMs !== null) {
      this.MIN_STAY_DURATION = minStayDurationMs;
    }
    
    this.currentGps = null;
    this.lastUpdateTimestamp = 0;
    this.locationStatus = 'STALE';
    this.candidateNode = null;
    
    this.refreshNodes();       // Load all known nodes from DB into memory
    this.restoreActiveVisit(); // Reconnect to any visit that was open at app close
    console.log(`[LocationEngine] Initialized. Loaded ${this.knownNodes.length} nodes.`);
  }

  // Reloads the full list of location nodes from SQLite into this.knownNodes cache.
  // Called on init and after any node creation or visit close.
  refreshNodes() {
    try {
      this.knownNodes = getLocationNodes() || [];
    } catch (e) {
      console.warn('[LocationEngine] Failed to load location nodes:', e);
      this.knownNodes = [];
    }
  }

  // Queries the DB for any open visit (exit_date IS NULL) and restores it.
  // This ensures location tracking resumes correctly after an app restart.
  restoreActiveVisit() {
    try {
      const db = initDatabase();
      const row = db.getFirstSync('SELECT * FROM location_visits WHERE exit_date IS NULL LIMIT 1;');
      if (row) {
        this.activeVisit = row;
        console.log(`[LocationEngine] Restored active visit ID: ${row.visit_id} for Node ID: ${row.location_node_id}`);
      } else {
        this.activeVisit = null;
      }
    } catch (e) {
      console.warn('[LocationEngine] Failed to restore active visit:', e);
      this.activeVisit = null;
    }
  }

  // Main entry point — called by BackgroundServices.js (or App.js) for every GPS fix.
  // Filters inaccurate readings, updates the current position, matches against known
  // geofenced nodes, and manages the visit lifecycle state machine.
  onLocationUpdate(gpsUpdate) {
    if (!gpsUpdate || gpsUpdate.latitude === undefined || gpsUpdate.longitude === undefined) return;

    // --- Step 1: Accuracy Filter ---
    // Ignore readings with > 50m horizontal accuracy — too imprecise to reliably
    // determine which geofenced node (radius ~20-30m) the user is inside.
    const accuracy = gpsUpdate.accuracy || 10;
    if (accuracy > 50) {
      return; // Silently discard inaccurate GPS fix
    }

    // Classify reading quality: HIGH confidence if ≤ 20m accuracy, LOW otherwise
    const confidence = accuracy <= 20 ? 'HIGH' : 'LOW';
    this.currentGps = {
      latitude: gpsUpdate.latitude,
      longitude: gpsUpdate.longitude,
      accuracy,
      confidence,
      timestamp: Date.now()
    };
    this.lastUpdateTimestamp = Date.now();
    this.locationStatus = 'OK'; // Mark GPS as fresh

    // --- Step 2: Geofence Matching ---
    // Scan all known nodes to find the closest one within the threshold radius.
    // We use hysteresis: a smaller entry radius and larger exit radius to prevent
    // oscillating between "inside/outside" when GPS jitter occurs at the boundary.
    let matchedNode = null;
    let minDistance = Infinity;

    for (const node of this.knownNodes) {
      const dist = this.getHaversineDistance(
        gpsUpdate.latitude, 
        gpsUpdate.longitude, 
        node.center_latitude, 
        node.center_longitude
      );

      // Use exit radius if we're already in this node (harder to leave than enter)
      const isCurrentlyInside = this.activeVisit && this.activeVisit.location_node_id === node.location_node_id;
      const threshold = isCurrentlyInside ? this.EXIT_RADIUS : this.ENTRY_RADIUS;

      if (dist <= threshold && dist < minDistance) {
        minDistance = dist;
        matchedNode = node;
      }
    }

    // --- Step 3: Visit State Machine ---
    if (matchedNode) {
      // User is INSIDE a known Location Node
      this.candidateNode = null; // Stop candidate tracking — we know where user is

      if (!this.activeVisit) {
        // No active visit → start a new one for this node
        this.startVisit(matchedNode.location_node_id);
      } else if (this.activeVisit.location_node_id !== matchedNode.location_node_id) {
        // User moved from one known node to a different known node → transition
        this.closeVisit();                            // Close visit at previous node
        this.startVisit(matchedNode.location_node_id); // Open visit at new node
      } else {
        // User is still in the same node → just update the stay duration
        this.updateVisitDuration();
      }
    } else {
      // User is OUTSIDE all known nodes
      if (this.activeVisit) {
        // Was inside a node, now outside → close the visit
        this.closeVisit();
      }

      // --- Step 4: Candidate Node Tracking ---
      // If the user lingers at an unknown location long enough, create a new node.
      // Only track candidates when GPS is fresh (not STALE).
      if (this.locationStatus === 'OK') {
        this.trackCandidateNode(gpsUpdate.latitude, gpsUpdate.longitude);
      }
    }
  }

  // Creates a new location_visits record when the user enters a known node.
  startVisit(nodeId) {
    const dateStr = getIsoDateString();
    const timeStr = getIsoTimeString();

    const visit = {
      location_node_id: nodeId,
      enter_date: dateStr,
      enter_time: timeStr,
      exit_date: null,   // null = visit is still ongoing
      exit_time: null,
      duration: 0.0,     // Will be updated by updateVisitDuration()
      entry_latitude: this.currentGps.latitude,
      entry_longitude: this.currentGps.longitude,
      exit_latitude: null,
      exit_longitude: null,
      confidence: this.currentGps.confidence // 'HIGH' or 'LOW' based on GPS accuracy
    };

    try {
      const visitId = saveLocationVisit(visit);
      visit.visit_id = visitId;     // Attach the DB-generated ID
      this.activeVisit = visit;     // Update in-memory state
      console.log(`[LocationEngine] Started visit ID ${visitId} for Node ID ${nodeId}`);
    } catch (e) {
      console.warn('[LocationEngine] Failed to save location visit:', e);
    }
  }

  // Recalculates and persists the duration of the current active visit.
  // Called on each GPS update while still inside the same known node.
  updateVisitDuration() {
    if (!this.activeVisit) return;
    try {
      // Calculate total seconds since the visit started
      const enterDt = new Date(`${this.activeVisit.enter_date}T${this.activeVisit.enter_time}`);
      const durationSec = (Date.now() - enterDt.getTime()) / 1000;
      
      this.activeVisit.duration = durationSec;
      saveLocationVisit(this.activeVisit); // Persist updated duration to DB
    } catch (e) {
      console.warn('[LocationEngine] Failed to update visit duration:', e);
    }
  }

  // Finalizes a visit by setting its end date/time and updating the parent node's
  // visit statistics (total visits, total stay duration, last visit date).
  closeVisit() {
    if (!this.activeVisit) return;

    const dateStr = getIsoDateString();
    const timeStr = getIsoTimeString();

    try {
      const enterDt = new Date(`${this.activeVisit.enter_date}T${this.activeVisit.enter_time}`);
      const durationSec = (Date.now() - enterDt.getTime()) / 1000;

      // Set exit timestamp and final duration
      this.activeVisit.exit_date = dateStr;
      this.activeVisit.exit_time = timeStr;
      this.activeVisit.duration = durationSec;
      if (this.currentGps) {
        this.activeVisit.exit_latitude = this.currentGps.latitude;
        this.activeVisit.exit_longitude = this.currentGps.longitude;
      }

      saveLocationVisit(this.activeVisit);
      console.log(`[LocationEngine] Closed visit ID ${this.activeVisit.visit_id}. Duration: ${durationSec}s`);
      
      // Update the parent node's visit count and cumulative stay stats in SQLite
      const db = initDatabase();
      db.runSync(`
        UPDATE location_nodes 
        SET visit_count = visit_count + 1,
            total_stay_duration = total_stay_duration + ?,
            last_visit_date = ?,
            last_visit_time = ?
        WHERE location_node_id = ?;
      `, [durationSec, dateStr, timeStr, this.activeVisit.location_node_id]);

      this.activeVisit = null;
      this.refreshNodes(); // Reload node stats to keep in-memory cache in sync
    } catch (e) {
      console.warn('[LocationEngine] Failed to close location visit:', e);
    }
  }

  // Tracks whether the user is lingering at a new, unknown location.
  // If the user stays within CANDIDATE_RADIUS for >= MIN_STAY_DURATION,
  // a new Location Node is automatically created and a visit is started there.
  trackCandidateNode(lat, lon) {
    const now = Date.now();

    if (!this.candidateNode) {
      // Initialize candidate tracking: user is at a new location for the first time
      this.candidateNode = {
        center_lat: lat,
        center_lon: lon,
        enterTimestamp: now,  // When did candidate tracking start?
        checkins: [{ latitude: lat, longitude: lon, timestamp: now }]
      };
      return;
    }

    // How far did the user move from the candidate's initial center?
    const dist = this.getHaversineDistance(
      lat, lon,
      this.candidateNode.center_lat,
      this.candidateNode.center_lon
    );

    if (dist <= this.CANDIDATE_RADIUS) {
      // Still within the candidate zone — record this check-in
      this.candidateNode.checkins.push({ latitude: lat, longitude: lon, timestamp: now });
      const elapsed = now - this.candidateNode.enterTimestamp;

      if (elapsed >= this.MIN_STAY_DURATION) {
        // User has stayed here long enough → PROMOTE to a real Location Node!
        
        // Compute the average center of all checkins (centroid of GPS positions)
        const lats = this.candidateNode.checkins.map(c => c.latitude);
        const lons = this.candidateNode.checkins.map(c => c.longitude);
        const avgLat = lats.reduce((a, b) => a + b, 0) / lats.length;
        const avgLon = lons.reduce((a, b) => a + b, 0) / lons.length;

        const dateStr = getIsoDateString();
        const timeStr = getIsoTimeString();

        const newNode = {
          center_latitude: avgLat,
          center_longitude: avgLon,
          radius: 30.0,              // Default geofence radius (meters)
          visit_count: 0,
          total_stay_duration: 0.0,
          first_visit_date: dateStr,
          first_visit_time: timeStr,
          last_visit_date: dateStr,
          last_visit_time: timeStr
        };

        try {
          const newNodeId = saveLocationNode(newNode);
          console.log(`[LocationEngine] Created new Location Node ID ${newNodeId} at (${avgLat.toFixed(5)}, ${avgLon.toFixed(5)})`);
          
          this.refreshNodes();      // Load the new node into memory
          this.candidateNode = null; // Stop candidate tracking

          // Immediately start a visit at the new node, back-dating to when the
          // candidate tracking started (the user was already there for MIN_STAY_DURATION)
          this.startVisit(newNodeId);
          const enterDateObj = new Date(now - elapsed); // Back-date entry timestamp
          this.activeVisit.enter_date = getIsoDateString(enterDateObj);
          this.activeVisit.enter_time = getIsoTimeString(enterDateObj);
          saveLocationVisit(this.activeVisit); // Persist back-dated visit entry
        } catch (e) {
          console.warn('[LocationEngine] Failed to save new location node:', e);
        }
      }
      // If elapsed < MIN_STAY_DURATION: continue waiting — nothing to do yet
    } else {
      // User moved > CANDIDATE_RADIUS from the candidate center → reset tracking
      // NOTE: This loses the elapsed time at the previous candidate! (See BUGS above)
      this.candidateNode = {
        center_lat: lat,
        center_lon: lon,
        enterTimestamp: now, // Fresh start from current position
        checkins: [{ latitude: lat, longitude: lon, timestamp: now }]
      };
    }
  }

  // Detects if the GPS fix hasn't been updated in > 30 seconds.
  // Sets locationStatus to 'STALE' to prevent candidate node creation from bad positions.
  // Should be called periodically by BackgroundServices.js or App.js.
  checkWatchdog() {
    if (this.lastUpdateTimestamp === 0) return; // Never had a fix — skip
    const elapsed = Date.now() - this.lastUpdateTimestamp;

    if (elapsed >= 30000) { // 30 seconds with no GPS update = stale
      if (this.locationStatus !== 'STALE') {
        this.locationStatus = 'STALE';
        console.log('[LocationEngine] Watchdog: Location status set to STALE. Node creation paused.');
      }
    } else {
      this.locationStatus = 'OK';
    }
  }

  // Returns a 0.0–1.0 familiarity score for a given GPS coordinate.
  // Used by useBle.js to compute the LocationEngine-based familiarity input
  // passed to EpisodeEngine.updateEpisode().
  //
  // Formula:
  //   - If inside a node's geofence radius → 1.0 (maximum familiarity)
  //   - Otherwise → exponential decay: exp(−distance / (radius × 2))
  //     (at radius × 2 meters away, familiarity ≈ 0.37; at radius × 4 ≈ 0.13)
  //   - Returns the maximum familiarity across all known nodes
  estimateFamiliarity(lat, lon) {
    if (this.knownNodes.length === 0) return 0.0; // No known nodes = totally unfamiliar

    // Check if inside any node's geofence radius first
    for (const node of this.knownNodes) {
      const dist = this.getHaversineDistance(
        lat, lon,
        node.center_latitude,
        node.center_longitude
      );
      if (dist <= node.radius) {
        return 1.0; // Inside geofence = 100% familiar
      }
    }

    // Otherwise, calculate extrapolated familiarity across all known nodes
    // Find the maximum visit count across all known nodes
    let maxVisits = 0;
    for (const node of this.knownNodes) {
      const v = node.visit_count || 0;
      if (v > maxVisits) {
        maxVisits = v;
      }
    }
    const divisor = maxVisits > 0 ? maxVisits : 1;

    let sum = 0.0;
    for (const node of this.knownNodes) {
      const dist = this.getHaversineDistance(
        lat, lon,
        node.center_latitude,
        node.center_longitude
      );
      const v = node.visit_count || 0;
      const decay = Math.exp(-dist / (node.radius * 2));
      sum += (v / divisor) * decay;
    }

    return Math.min(1.0, sum);
  }

  // Computes the great-circle distance (in meters) between two GPS coordinates.
  // Uses the Haversine formula — accurate for small distances (< 100km).
  // Used throughout this class for all distance calculations.
  getHaversineDistance(lat1, lon1, lat2, lon2) {
    const toRad = (x) => (x * Math.PI) / 180;
    const R = 6371000; // Earth's mean radius in meters

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    // Haversine formula: a = sin²(Δlat/2) + cos(lat1)·cos(lat2)·sin²(Δlon/2)
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); // Angular distance
    return R * c; // Convert to meters
  }
}

// Exported as a singleton — the entire app shares one LocationEngine instance.
// Its currentGps and activeVisit fields are read directly by useBle.js and ContextEngine.
export const LocationEngine = new LocationEngineClass();
