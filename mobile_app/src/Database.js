// =============================================================================
// Database.js — SQLite Data Layer (All Persistent Storage for the SafeBand App)
// =============================================================================
//
// DRY RUN / ARCHITECTURE OVERVIEW
// --------------------------------
// This is the single source of truth for ALL persistent data in the SafeBand app.
// It wraps expo-sqlite (in the Expo/React Native app) or Node.js built-in sqlite
// (for offline testing scripts) behind a unified synchronous API.
//
// WHO USES THIS FILE:
//   → useDatabase.js (hook)   — contacts, templates, settings CRUD
//   → MotionEngine.js         — storeObservation(), getMotionClusters()
//   → EpisodeEngine.js        — saveEpisode(), saveEpisodeTimeline()
//   → LocationEngine.js       — saveLocationNode(), getLocationNodes(), saveLocationVisit()
//   → ContextEngine.js        — initDatabase() (direct queries to observations,
//                               location_visits, episodes for familiarity inference)
//
// OUTPUT:
//   → Persistent SQLite database file "safeband.db" on device storage
//
// DUAL-ENVIRONMENT SUPPORT:
//   The getDb() function detects whether it is running in:
//     A. Expo React Native: uses expo-sqlite's openDatabaseSync()
//     B. Node.js CLI:       uses built-in node:sqlite DatabaseSync
//   This allows the same Database.js to be used both in the app AND in test
//   scripts (e.g. calibration pipeline scripts) without modification.
//
// DATABASE SCHEMA (9 tables):
//
//   1. settings              — Key-value app configuration
//      └─ key (PK), value
//
//   2. contacts              — Emergency contacts with per-channel settings
//      └─ id, name, phone, email, whatsapp, whatsapp_method, callmebot_key,
//          sms_enabled, whatsapp_enabled, email_enabled, template_id
//
//   3. templates             — Custom message templates with {placeholder} syntax
//      └─ id, name, content
//
//   4. observations          — 3-second TinyML snapshots (10 embeddings + cluster assignment)
//      └─ observation_id, date, time, embeddings (JSON), reconstruction_scores (JSON),
//          motion_features (JSON), cluster_distribution (JSON), cluster_version
//      ⚠ NOTE: JSON fields are stored as TEXT and must be JSON.parse()'d on read.
//
//   5. motion_clusters       — Trained embedding cluster centroids (from Python pipeline)
//      └─ cluster_id, cluster_version, centroid (JSON), covariance (JSON),
//          visit_count, reconstruction_mean, motion_summary (JSON), timestamps
//      NOTE: Composite PK (cluster_id, cluster_version) supports multi-version cache.
//            getMotionClusters() always returns the HIGHEST version only.
//
//   6. episodes              — Contiguous motion behavior segments
//      └─ episode_id, start_date, start_time, end_date (null=open), end_time,
//          duration, motion_distribution (JSON), familiarity_mean/min/max/variance
//
//   7. episode_motion_timelines — Per-stride timeline for each episode (every 3s)
//      └─ timeline_id, episode_id (FK→episodes), window_start_date/time,
//          motion_distribution (JSON), reconstruction_mean
//
//   8. location_nodes        — Known "home", "office", etc. geofenced places
//      └─ location_node_id, center_latitude, center_longitude, radius,
//          visit_count, total_stay_duration, first/last_visit_date/time
//
//   9. location_visits       — Instances of entering/exiting a location node
//      └─ visit_id, location_node_id (FK→location_nodes), enter_date/time,
//          exit_date/time (null=still inside), duration, entry/exit GPS, confidence
//
//   10. inference_logs       — Per-inference ContextEngine assessment records
//       └─ inference_id, date, time, familiarity_score, anomaly_score,
//          emergency_score, selected_episode, selected_location, explanation (JSON)
//
// API ORGANIZATION:
//   Section 0: Dual-environment DB adapter + initDatabase() (tables + migrations)
//   Section 1: Settings CRUD (getSettings, saveSetting)
//   Section 2: Contacts CRUD (getContacts, saveContact, deleteContact)
//   Section 3: Templates CRUD (getTemplates, saveTemplate, deleteTemplate)
//   Section 4: Date/Time helpers (getIsoDateString, getIsoTimeString)
//   Section 5: Observations API (storeObservation, getObservations, getLatestObservation)
//   Section 6: Motion Clusters API (saveMotionCluster, getMotionClusters)
//   Section 7: Episodes API (saveEpisode, getEpisode, getEpisodes, getPreviousEpisodes)
//   Section 8: Episode Timelines API (saveEpisodeTimeline, getEpisodeTimeline)
//   Section 9: Location Nodes API (saveLocationNode, getLocationNode, getLocationNodes)
//   Section 10: Location Visits API (saveLocationVisit, getLocationVisit, getLocationVisits)
//   Section 11: Inference Logs API (storeInference, getInferenceHistory)
//   Section 12: Retention Policy (enforceRetentionPolicy — deletes data > 30 days old)
//
// BUGS / NOTES:
//   ⚠ All JSON fields (embeddings, cluster_distribution, motion_features, etc.)
//     are stored as SQLite TEXT. They must be JSON.stringify()'d on write and
//     JSON.parse()'d on read. This is handled automatically in the API functions
//     below, but direct raw DB queries would return unparsed JSON strings.
//   ⚠ initDatabase() has a migration step that drops the `observations` and
//     `motion_clusters` tables if they are missing the `cluster_version` column.
//     This is a destructive migration — all old observation data is LOST on upgrade.
//     Consider a non-destructive ALTER TABLE ADD COLUMN migration in the future.
//   ⚠ All read operations use *Sync variants (getFirstSync, getAllSync, runSync).
//     These block the JS thread — appropriate for a mobile app where DB reads are
//     fast, but would be a problem in a high-throughput server context.
// =============================================================================

// Module-level singleton: holds the opened database connection.
// Initialized lazily by getDb() on first call. Persists for the app lifetime.
let db = null;

// Dynamic environment loader to support both Expo React Native and Node.js CLI testing
function getDb() {
  if (db) return db;

  const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;

  if (isNode) {
    const requireFunc = Function('return require')();
    const { DatabaseSync } = requireFunc('node:sqlite');
    const dbName = process.env.SAFEBAND_TEST_DB || 'safeband.db';
    const nodeDb = new DatabaseSync(dbName);

    db = {
      execSync: (sql) => nodeDb.exec(sql),
      runSync: (sql, params = []) => {
        const stmt = nodeDb.prepare(sql);
        const res = stmt.run(...params);
        return {
          changes: res.changes,
          lastInsertRowId: res.lastInsertRowid
        };
      },
      getFirstSync: (sql, params = []) => {
        const stmt = nodeDb.prepare(sql);
        return stmt.get(...params);
      },
      getAllSync: (sql, params = []) => {
        const stmt = nodeDb.prepare(sql);
        return stmt.all(...params);
      },
      runAsync: async (sql, params = []) => {
        const stmt = nodeDb.prepare(sql);
        const res = stmt.run(...params);
        return {
          changes: res.changes,
          lastInsertRowId: res.lastInsertRowid
        };
      }
    };
  } else {
    const SQLite = require('expo-sqlite');
    db = SQLite.openDatabaseSync('safeband.db');
  }
  return db;
}

let isDbInitialized = false;

export function initDatabase() {
  const database = getDb();
  if (isDbInitialized) return database;
  try {
    // 0. Database migrations for cluster_version support
    try {
      const obsTableExists = database.getFirstSync("SELECT name FROM sqlite_master WHERE type='table' AND name='observations';");
      if (obsTableExists) {
        try {
          database.getFirstSync('SELECT cluster_version FROM observations LIMIT 1;');
        } catch (e) {
          database.execSync('DROP TABLE IF EXISTS observations;');
          console.log('[DB] Dropped outdated observations table.');
        }
      }
    } catch (err) {
      console.warn('[DB] Failed observations check:', err);
    }

    try {
      const clustersTableExists = database.getFirstSync("SELECT name FROM sqlite_master WHERE type='table' AND name='motion_clusters';");
      if (clustersTableExists) {
        try {
          database.getFirstSync('SELECT cluster_version FROM motion_clusters LIMIT 1;');
        } catch (e) {
          database.execSync('DROP TABLE IF EXISTS motion_clusters;');
          console.log('[DB] Dropped outdated motion_clusters table.');
        }
      }
    } catch (err) {
      console.warn('[DB] Failed motion_clusters check:', err);
    }

    // Create settings table
    database.execSync(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    
    // Create contacts table
    database.execSync(`
      CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        whatsapp TEXT,
        whatsapp_method TEXT DEFAULT 'NATIVE', -- 'NATIVE', 'CALLMEBOT', 'TWILIO'
        callmebot_key TEXT,
        sms_enabled INTEGER DEFAULT 1,
        whatsapp_enabled INTEGER DEFAULT 1,
        email_enabled INTEGER DEFAULT 1,
        template_id INTEGER DEFAULT 0 -- 0 means default template
      );
    `);
    
    // Create templates table
    database.execSync(`
      CREATE TABLE IF NOT EXISTS templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        content TEXT NOT NULL
      );
    `);

    // Create observations table with cluster_version support
    database.execSync(`
      CREATE TABLE IF NOT EXISTS observations (
        observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        embeddings TEXT NOT NULL,
        reconstruction_scores TEXT NOT NULL,
        motion_features TEXT NOT NULL,
        cluster_distribution TEXT NOT NULL,
        cluster_version INTEGER DEFAULT 0
      );
    `);

    // Create motion_clusters table with cluster_version support
    // (Composite primary key cluster_id + cluster_version to support rollback multi-version cache)
    database.execSync(`
      CREATE TABLE IF NOT EXISTS motion_clusters (
        cluster_id INTEGER,
        cluster_version INTEGER DEFAULT 0,
        centroid TEXT NOT NULL,
        covariance TEXT,
        visit_count INTEGER DEFAULT 0,
        reconstruction_mean REAL,
        motion_summary TEXT,
        created_date TEXT,
        created_time TEXT,
        updated_date TEXT,
        updated_time TEXT,
        PRIMARY KEY (cluster_id, cluster_version)
      );
    `);

    // Create episodes table
    database.execSync(`
      CREATE TABLE IF NOT EXISTS episodes (
        episode_id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_date TEXT,
        end_time TEXT,
        duration REAL DEFAULT 0.0,
        motion_distribution TEXT NOT NULL,
        familiarity_mean REAL,
        familiarity_min REAL,
        familiarity_max REAL,
        familiarity_variance REAL
      );
    `);

    // Create episode_motion_timelines table
    database.execSync(`
      CREATE TABLE IF NOT EXISTS episode_motion_timelines (
        timeline_id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id INTEGER NOT NULL,
        window_start_date TEXT NOT NULL,
        window_start_time TEXT NOT NULL,
        motion_distribution TEXT NOT NULL,
        reconstruction_mean REAL,
        FOREIGN KEY(episode_id) REFERENCES episodes(episode_id) ON DELETE CASCADE
      );
    `);

    // Create location_nodes table
    database.execSync(`
      CREATE TABLE IF NOT EXISTS location_nodes (
        location_node_id INTEGER PRIMARY KEY AUTOINCREMENT,
        center_latitude REAL NOT NULL,
        center_longitude REAL NOT NULL,
        radius REAL NOT NULL,
        visit_count INTEGER DEFAULT 0,
        total_stay_duration REAL DEFAULT 0.0,
        first_visit_date TEXT,
        first_visit_time TEXT,
        last_visit_date TEXT,
        last_visit_time TEXT
      );
    `);

    // Create location_visits table
    database.execSync(`
      CREATE TABLE IF NOT EXISTS location_visits (
        visit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        location_node_id INTEGER NOT NULL,
        enter_date TEXT NOT NULL,
        enter_time TEXT NOT NULL,
        exit_date TEXT,
        exit_time TEXT,
        duration REAL DEFAULT 0.0,
        entry_latitude REAL,
        entry_longitude REAL,
        exit_latitude REAL,
        exit_longitude REAL,
        confidence TEXT DEFAULT 'HIGH',
        FOREIGN KEY(location_node_id) REFERENCES location_nodes(location_node_id) ON DELETE CASCADE
      );
    `);

    // Create inference_logs table
    database.execSync(`
      CREATE TABLE IF NOT EXISTS inference_logs (
        inference_id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        familiarity_score REAL,
        anomaly_score REAL,
        emergency_score REAL,
        selected_episode INTEGER,
        selected_location INTEGER,
        explanation TEXT
      );
    `);

    // Create Indexes
    database.execSync(`CREATE INDEX IF NOT EXISTS idx_obs_datetime ON observations(date, time);`);
    database.execSync(`CREATE INDEX IF NOT EXISTS idx_episodes_start ON episodes(start_date, start_time);`);
    database.execSync(`CREATE INDEX IF NOT EXISTS idx_episodes_end ON episodes(end_date, end_time);`);
    database.execSync(`CREATE INDEX IF NOT EXISTS idx_timeline_episode ON episode_motion_timelines(episode_id);`);
    database.execSync(`CREATE INDEX IF NOT EXISTS idx_timeline_datetime ON episode_motion_timelines(window_start_date, window_start_time);`);
    database.execSync(`CREATE INDEX IF NOT EXISTS idx_visits_node ON location_visits(location_node_id);`);
    database.execSync(`CREATE INDEX IF NOT EXISTS idx_visits_enter ON location_visits(enter_date, enter_time);`);
    database.execSync(`CREATE INDEX IF NOT EXISTS idx_visits_exit ON location_visits(exit_date, exit_time);`);
    database.execSync(`CREATE INDEX IF NOT EXISTS idx_inference_datetime ON inference_logs(date, time);`);
    
    // Insert default settings if they don't exist
    const defaultSettings = [
      { key: 'user_name', value: 'Jane Smith' },
      { key: 'medical_blood_group', value: 'O+' },
      { key: 'medical_conditions', value: '' },
      { key: 'medical_allergies', value: '' },
      { key: 'medical_instructions', value: '' },
      { key: 'real_pin', value: '1234' },
      { key: 'fake_pin', value: '9999' },
      { key: 'pin_enabled', value: '1' },
      { key: 'silent_beacon', value: '0' },
      { key: 'twilio_account_sid', value: '' },
      { key: 'twilio_auth_token', value: '' },
      { key: 'twilio_sms_from', value: '' },
      { key: 'twilio_whatsapp_from', value: '' },
      { key: 'resend_api_key', value: '' },
      { key: 'resend_from_email', value: 'onboarding@resend.dev' },
      { key: 'email_alerts_enabled', value: '1' },
      { key: 'whatsapp_alerts_enabled', value: '1' },
      { key: 'sms_alerts_enabled', value: '1' }
    ];

    for (const setting of defaultSettings) {
      const row = database.getFirstSync('SELECT * FROM settings WHERE key = ?;', [setting.key]);
      if (!row) {
        database.runSync('INSERT INTO settings (key, value) VALUES (?, ?);', [setting.key, setting.value]);
      }
    }

    // Insert default contacts if empty
    const contactsCount = database.getFirstSync('SELECT COUNT(*) as count FROM contacts;');
    if (contactsCount.count === 0) {
      database.runSync(`
        INSERT INTO contacts (name, phone, email, whatsapp, whatsapp_method, sms_enabled, whatsapp_enabled, email_enabled)
        VALUES ('Jane Doe (Primary)', '+15550192831', 'jane.doe@example.com', '+15550192831', 'NATIVE', 1, 1, 1);
      `);
      database.runSync(`
        INSERT INTO contacts (name, phone, email, whatsapp, whatsapp_method, sms_enabled, whatsapp_enabled, email_enabled)
        VALUES ('John Smith', '+15550129844', 'john.smith@example.com', '+15550129844', 'TWILIO', 1, 1, 1);
      `);
    }

    console.log('[DB] Database initialized successfully.');
    isDbInitialized = true;
    return database;
  } catch (error) {
    console.error('[DB] Database initialization failed:', error);
    throw error;
  }
}

export function getSettings() {
  const database = initDatabase();
  const rows = database.getAllSync('SELECT * FROM settings;');
  const settingsObj = {};
  for (const row of rows) {
    settingsObj[row.key] = row.value;
  }
  return settingsObj;
}

export async function saveSetting(key, value) {
  const database = initDatabase();
  await database.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?);', [key, String(value)]);
}

export function getContacts() {
  const database = initDatabase();
  return database.getAllSync('SELECT * FROM contacts ORDER BY id ASC;');
}

export function saveContact(contact) {
  const database = initDatabase();
  if (contact.id) {
    database.runSync(`
      UPDATE contacts SET 
        name = ?, phone = ?, email = ?, whatsapp = ?, 
        whatsapp_method = ?, callmebot_key = ?, 
        sms_enabled = ?, whatsapp_enabled = ?, email_enabled = ?,
        template_id = ?
      WHERE id = ?;
    `, [
      contact.name, contact.phone, contact.email, contact.whatsapp,
      contact.whatsapp_method, contact.callmebot_key,
      contact.sms_enabled ? 1 : 0, contact.whatsapp_enabled ? 1 : 0, contact.email_enabled ? 1 : 0,
      contact.template_id || 0,
      contact.id
    ]);
  } else {
    database.runSync(`
      INSERT INTO contacts (
        name, phone, email, whatsapp, whatsapp_method, callmebot_key, 
        sms_enabled, whatsapp_enabled, email_enabled, template_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `, [
      contact.name, contact.phone, contact.email, contact.whatsapp,
      contact.whatsapp_method, contact.callmebot_key,
      contact.sms_enabled ? 1 : 0, contact.whatsapp_enabled ? 1 : 0, contact.email_enabled ? 1 : 0,
      contact.template_id || 0
    ]);
  }
}

export function deleteContact(id) {
  const database = initDatabase();
  database.runSync('DELETE FROM contacts WHERE id = ?;', [id]);
}

export function getTemplates() {
  const database = initDatabase();
  return database.getAllSync('SELECT * FROM templates ORDER BY id ASC;');
}

export function saveTemplate(template) {
  const database = initDatabase();
  if (template.id) {
    database.runSync('UPDATE templates SET name = ?, content = ? WHERE id = ?;', [template.name, template.content, template.id]);
  } else {
    database.runSync('INSERT INTO templates (name, content) VALUES (?, ?);', [template.name, template.content]);
  }
}

export function deleteTemplate(id) {
  const database = initDatabase();
  database.runSync('DELETE FROM templates WHERE id = ?;', [id]);
}

// ============================================================================
// Semantics and Metrics Tables Query APIs
// ============================================================================

// Helper functions for formatting ISO Dates/Times
export function getIsoDateString(date = new Date()) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getIsoTimeString(date = new Date()) {
  const d = new Date(date);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

// 1. Observations Table Query API
export function storeObservation(obs) {
  const database = initDatabase();
  const dateStr = obs.date || getIsoDateString();
  const timeStr = obs.time || getIsoTimeString();
  const clusterVersion = obs.cluster_version !== undefined ? obs.cluster_version : 0;

  const res = database.runSync(`
    INSERT INTO observations (date, time, embeddings, reconstruction_scores, motion_features, cluster_distribution, cluster_version)
    VALUES (?, ?, ?, ?, ?, ?, ?);
  `, [
    dateStr,
    timeStr,
    JSON.stringify(obs.embeddings),
    JSON.stringify(obs.reconstruction_scores),
    JSON.stringify(obs.motion_features),
    JSON.stringify(obs.cluster_distribution),
    clusterVersion
  ]);

  return res.lastInsertRowId;
}

export function getObservations(startDate, endDate) {
  const database = initDatabase();
  const startD = typeof startDate === 'string' ? startDate : getIsoDateString(startDate);
  const endD = typeof endDate === 'string' ? endDate : getIsoDateString(endDate);

  return database.getAllSync(`
    SELECT * FROM observations 
    WHERE date >= ? AND date <= ?
    ORDER BY date ASC, time ASC;
  `, [startD, endD]).map(row => ({
    ...row,
    embeddings: JSON.parse(row.embeddings),
    reconstruction_scores: JSON.parse(row.reconstruction_scores),
    motion_features: JSON.parse(row.motion_features),
    cluster_distribution: JSON.parse(row.cluster_distribution)
  }));
}

export function getLatestObservation() {
  const database = initDatabase();
  const row = database.getFirstSync(`
    SELECT * FROM observations 
    ORDER BY date DESC, time DESC 
    LIMIT 1;
  `);
  if (!row) return null;
  return {
    ...row,
    embeddings: JSON.parse(row.embeddings),
    reconstruction_scores: JSON.parse(row.reconstruction_scores),
    motion_features: JSON.parse(row.motion_features),
    cluster_distribution: JSON.parse(row.cluster_distribution)
  };
}

// 2. Motion Clusters Table Query API
export function saveMotionCluster(cluster) {
  const database = initDatabase();
  const dateStr = getIsoDateString();
  const timeStr = getIsoTimeString();
  const clusterVersion = cluster.cluster_version !== undefined ? cluster.cluster_version : 0;

  database.runSync(`
    INSERT OR REPLACE INTO motion_clusters (
      cluster_id, cluster_version, centroid, covariance, visit_count, reconstruction_mean, 
      motion_summary, created_date, created_time, updated_date, updated_time
    ) VALUES (
      ?, ?, ?, ?, ?, ?, 
      ?, 
      COALESCE((SELECT created_date FROM motion_clusters WHERE cluster_id = ? AND cluster_version = ?), ?), 
      COALESCE((SELECT created_time FROM motion_clusters WHERE cluster_id = ? AND cluster_version = ?), ?), 
      ?, ?
    );
  `, [
    cluster.cluster_id,
    clusterVersion,
    JSON.stringify(cluster.centroid),
    cluster.covariance ? JSON.stringify(cluster.covariance) : null,
    cluster.visit_count || 0,
    cluster.reconstruction_mean || 0.0,
    cluster.motion_summary ? JSON.stringify(cluster.motion_summary) : null,
    cluster.cluster_id, clusterVersion, dateStr,
    cluster.cluster_id, clusterVersion, timeStr,
    dateStr,
    timeStr
  ]);
}

// Modified to select only clusters with the highest active version
export function getMotionClusters() {
  const database = initDatabase();
  
  // Find maximum cluster version
  const maxVerRow = database.getFirstSync('SELECT MAX(cluster_version) as max_version FROM motion_clusters;');
  if (!maxVerRow || maxVerRow.max_version === null) return [];

  return database.getAllSync('SELECT * FROM motion_clusters WHERE cluster_version = ?;', [maxVerRow.max_version]).map(row => ({
    ...row,
    centroid: JSON.parse(row.centroid),
    covariance: row.covariance ? JSON.parse(row.covariance) : null,
    motion_summary: row.motion_summary ? JSON.parse(row.motion_summary) : null
  }));
}

// 3. Episodes Table Query API
export function saveEpisode(episode) {
  const database = initDatabase();
  if (episode.episode_id) {
    database.runSync(`
      UPDATE episodes SET
        start_date = ?, start_time = ?, end_date = ?, end_time = ?, duration = ?, 
        motion_distribution = ?, familiarity_mean = ?, familiarity_min = ?, familiarity_max = ?, familiarity_variance = ?
      WHERE episode_id = ?;
    `, [
      episode.start_date,
      episode.start_time,
      episode.end_date || null,
      episode.end_time || null,
      episode.duration || 0.0,
      JSON.stringify(episode.motion_distribution),
      episode.familiarity_mean !== undefined ? episode.familiarity_mean : null,
      episode.familiarity_min !== undefined ? episode.familiarity_min : null,
      episode.familiarity_max !== undefined ? episode.familiarity_max : null,
      episode.familiarity_variance !== undefined ? episode.familiarity_variance : null,
      episode.episode_id
    ]);
    return episode.episode_id;
  } else {
    const res = database.runSync(`
      INSERT INTO episodes (
        start_date, start_time, end_date, end_time, duration, motion_distribution, 
        familiarity_mean, familiarity_min, familiarity_max, familiarity_variance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `, [
      episode.start_date || getIsoDateString(),
      episode.start_time || getIsoTimeString(),
      episode.end_date || null,
      episode.end_time || null,
      episode.duration || 0.0,
      JSON.stringify(episode.motion_distribution),
      episode.familiarity_mean !== undefined ? episode.familiarity_mean : null,
      episode.familiarity_min !== undefined ? episode.familiarity_min : null,
      episode.familiarity_max !== undefined ? episode.familiarity_max : null,
      episode.familiarity_variance !== undefined ? episode.familiarity_variance : null
    ]);
    return res.lastInsertRowId;
  }
}

export function getEpisode(timestamp) {
  const database = initDatabase();
  const tStr = typeof timestamp === 'string' ? timestamp : new Date(timestamp).toISOString().replace('Z', '').split('.')[0];
  const dateStr = tStr.split('T')[0];
  const timeStr = tStr.split('T')[1];

  const row = database.getFirstSync(`
    SELECT * FROM episodes 
    WHERE (start_date < ? OR (start_date = ? AND start_time <= ?))
      AND (end_date IS NULL OR end_date > ? OR (end_date = ? AND end_time >= ?))
    ORDER BY start_date DESC, start_time DESC 
    LIMIT 1;
  `, [dateStr, dateStr, timeStr, dateStr, dateStr, timeStr]);

  if (!row) return null;
  return {
    ...row,
    motion_distribution: JSON.parse(row.motion_distribution)
  };
}

export function getEpisodes(start, end) {
  const database = initDatabase();
  const startD = typeof start === 'string' ? start : getIsoDateString(start);
  const endD = typeof end === 'string' ? end : getIsoDateString(end);

  return database.getAllSync(`
    SELECT * FROM episodes
    WHERE (start_date >= ? AND start_date <= ?)
       OR (end_date >= ? AND end_date <= ?)
       OR (start_date <= ? AND (end_date IS NULL OR end_date >= ?))
    ORDER BY start_date ASC, start_time ASC;
  `, [startD, endD, startD, endD, startD, endD]).map(row => ({
    ...row,
    motion_distribution: JSON.parse(row.motion_distribution)
  }));
}

export function getPreviousEpisodes(timestamp, k = 5) {
  const database = initDatabase();
  const tStr = typeof timestamp === 'string' ? timestamp : new Date(timestamp).toISOString().replace('Z', '').split('.')[0];
  const dateStr = tStr.split('T')[0];
  const timeStr = tStr.split('T')[1];

  return database.getAllSync(`
    SELECT * FROM episodes
    WHERE start_date < ? OR (start_date = ? AND start_time < ?)
    ORDER BY start_date DESC, start_time DESC
    LIMIT ?;
  `, [dateStr, dateStr, timeStr, k]).map(row => ({
    ...row,
    motion_distribution: JSON.parse(row.motion_distribution)
  })).reverse();
}

// 4. Episode Motion Timeline Table Query API
export function saveEpisodeTimeline(entry) {
  const database = initDatabase();
  const dateStr = entry.window_start_date || getIsoDateString();
  const timeStr = entry.window_start_time || getIsoTimeString();

  const res = database.runSync(`
    INSERT INTO episode_motion_timelines (episode_id, window_start_date, window_start_time, motion_distribution, reconstruction_mean)
    VALUES (?, ?, ?, ?, ?);
  `, [
    entry.episode_id,
    dateStr,
    timeStr,
    JSON.stringify(entry.motion_distribution),
    entry.reconstruction_mean || 0.0
  ]);
  return res.lastInsertRowId;
}

export function getEpisodeTimeline(episodeId) {
  const database = initDatabase();
  return database.getAllSync(`
    SELECT * FROM episode_motion_timelines
    WHERE episode_id = ?
    ORDER BY window_start_date ASC, window_start_time ASC;
  `, [episodeId]).map(row => ({
    ...row,
    motion_distribution: JSON.parse(row.motion_distribution)
  }));
}

// 5. Location Nodes Table Query API
export function saveLocationNode(node) {
  const database = initDatabase();
  if (node.location_node_id) {
    database.runSync(`
      UPDATE location_nodes SET
        center_latitude = ?, center_longitude = ?, radius = ?, visit_count = ?, total_stay_duration = ?, 
        first_visit_date = ?, first_visit_time = ?, last_visit_date = ?, last_visit_time = ?
      WHERE location_node_id = ?;
    `, [
      node.center_latitude,
      node.center_longitude,
      node.radius,
      node.visit_count || 0,
      node.total_stay_duration || 0.0,
      node.first_visit_date || null,
      node.first_visit_time || null,
      node.last_visit_date || null,
      node.last_visit_time || null,
      node.location_node_id
    ]);
    return node.location_node_id;
  } else {
    const res = database.runSync(`
      INSERT INTO location_nodes (
        center_latitude, center_longitude, radius, visit_count, total_stay_duration, 
        first_visit_date, first_visit_time, last_visit_date, last_visit_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `, [
      node.center_latitude,
      node.center_longitude,
      node.radius,
      node.visit_count || 0,
      node.total_stay_duration || 0.0,
      node.first_visit_date || null,
      node.first_visit_time || null,
      node.last_visit_date || null,
      node.last_visit_time || null
    ]);
    return res.lastInsertRowId;
  }
}

export function getLocationNode(nodeId) {
  const database = initDatabase();
  return database.getFirstSync('SELECT * FROM location_nodes WHERE location_node_id = ?;', [nodeId]);
}

export function getLocationNodes() {
  const database = initDatabase();
  return database.getAllSync('SELECT * FROM location_nodes;');
}

// 6. Location Visits Table Query API
export function saveLocationVisit(visit) {
  const database = initDatabase();
  if (visit.visit_id) {
    database.runSync(`
      UPDATE location_visits SET
        location_node_id = ?, enter_date = ?, enter_time = ?, exit_date = ?, exit_time = ?, duration = ?, 
        entry_latitude = ?, entry_longitude = ?, exit_latitude = ?, exit_longitude = ?, confidence = ?
      WHERE visit_id = ?;
    `, [
      visit.location_node_id,
      visit.enter_date,
      visit.enter_time,
      visit.exit_date || null,
      visit.exit_time || null,
      visit.duration || 0.0,
      visit.entry_latitude || null,
      visit.entry_longitude || null,
      visit.exit_latitude || null,
      visit.exit_longitude || null,
      visit.confidence || 'HIGH',
      visit.visit_id
    ]);
    return visit.visit_id;
  } else {
    const res = database.runSync(`
      INSERT INTO location_visits (
        location_node_id, enter_date, enter_time, exit_date, exit_time, duration, 
        entry_latitude, entry_longitude, exit_latitude, exit_longitude, confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `, [
      visit.location_node_id,
      visit.enter_date || getIsoDateString(),
      visit.enter_time || getIsoTimeString(),
      visit.exit_date || null,
      visit.exit_time || null,
      visit.duration || 0.0,
      visit.entry_latitude || null,
      visit.entry_longitude || null,
      visit.exit_latitude || null,
      visit.exit_longitude || null,
      visit.confidence || 'HIGH'
    ]);
    return res.lastInsertRowId;
  }
}

export function getLocationVisit(timestamp) {
  const database = initDatabase();
  const tStr = typeof timestamp === 'string' ? timestamp : new Date(timestamp).toISOString().replace('Z', '').split('.')[0];
  const dateStr = tStr.split('T')[0];
  const timeStr = tStr.split('T')[1];

  return database.getFirstSync(`
    SELECT * FROM location_visits
    WHERE (enter_date < ? OR (enter_date = ? AND enter_time <= ?))
      AND (exit_date IS NULL OR exit_date > ? OR (exit_date = ? AND exit_time >= ?))
    ORDER BY enter_date DESC, enter_time DESC
    LIMIT 1;
  `, [dateStr, dateStr, timeStr, dateStr, dateStr, timeStr]);
}

export function getLocationVisits(start, end) {
  const database = initDatabase();
  const startD = typeof start === 'string' ? start : getIsoDateString(start);
  const endD = typeof end === 'string' ? end : getIsoDateString(end);

  return database.getAllSync(`
    SELECT * FROM location_visits
    WHERE (enter_date >= ? AND enter_date <= ?)
       OR (exit_date >= ? AND exit_date <= ?)
       OR (enter_date <= ? AND (exit_date IS NULL OR exit_date >= ?))
    ORDER BY enter_date ASC, enter_time ASC;
  `, [startD, endD, startD, endD, startD, endD]);
}

// 7. Inference Logs Table Query API
export function storeInference(log) {
  const database = initDatabase();
  const dateStr = log.date || getIsoDateString();
  const timeStr = log.time || getIsoTimeString();

  const res = database.runSync(`
    INSERT INTO inference_logs (date, time, familiarity_score, anomaly_score, emergency_score, selected_episode, selected_location, explanation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?);
  `, [
    dateStr,
    timeStr,
    log.familiarity_score || 0.0,
    log.anomaly_score || 0.0,
    log.emergency_score || 0.0,
    log.selected_episode || null,
    log.selected_location || null,
    JSON.stringify(log.explanation)
  ]);
  return res.lastInsertRowId;
}

export function getInferenceHistory(limit = 100) {
  const database = initDatabase();
  return database.getAllSync(`
    SELECT * FROM inference_logs
    ORDER BY date DESC, time DESC
    LIMIT ?;
  `, [limit]).map(row => ({
    ...row,
    explanation: JSON.parse(row.explanation)
  }));
}

// 8. Retention Cleanup Service API
export function enforceRetentionPolicy() {
  const database = initDatabase();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const cutoffDate = getIsoDateString(thirtyDaysAgo);

  // Enforce retention for observations, timelines, and inference logs
  const obsRes = database.runSync('DELETE FROM observations WHERE date < ?;', [cutoffDate]);
  const timelineRes = database.runSync('DELETE FROM episode_motion_timelines WHERE window_start_date < ?;', [cutoffDate]);
  const inferenceRes = database.runSync('DELETE FROM inference_logs WHERE date < ?;', [cutoffDate]);

  return {
    deletedObservations: obsRes.changes,
    deletedTimelines: timelineRes.changes,
    deletedInferences: inferenceRes.changes
  };
}

export function executeSql(sql, params = []) {
  const database = initDatabase();
  return database.getAllSync(sql, params);
}

export function executeRun(sql, params = []) {
  const database = initDatabase();
  return database.runSync(sql, params);
}
