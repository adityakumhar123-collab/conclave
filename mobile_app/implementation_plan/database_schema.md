===============================================================================
                     SAFEBAND DATABASE DESIGN (VERSION 1.0)
===============================================================================

Purpose
-------
The database is the persistent memory of the system.

It does NOT perform inference.
It does NOT perform clustering.
It does NOT compute familiarity.

Every engine owns only its own tables.
Every other engine interacts through query APIs.


===============================================================================
DATABASE OWNERSHIP
===============================================================================

Motion Engine
    └── Observation Table

Clustering Engine
    └── Motion Cluster Table

Episode Engine
    ├── Episode Table
    └── Episode Motion Timeline Table

Location Engine
    ├── Location Node Table
    └── Location Visit Table

Context Engine
    └── Inference Log Table


===============================================================================
1. OBSERVATION TABLE
===============================================================================

Purpose
-------
Stores one Motion Observation every Context Inference.

One observation represents ONE 5-second context window
consisting of 10 TinyML embeddings.

Primary Key

    observation_id

Columns

    observation_id          INTEGER PRIMARY KEY AUTOINCREMENT

    date                    DATE NOT NULL

    time                    TIME NOT NULL

    embeddings              BLOB NOT NULL
        Stores all 10 embeddings belonging
        to the current 5-second window.

    reconstruction_scores   BLOB NOT NULL
        Reconstruction scores corresponding
        to each embedding.

    motion_features          BLOB NOT NULL
        Tier-1
        Tier-2
        Tier-3
        motion features.

    cluster_distribution     BLOB NOT NULL
        Distribution obtained by assigning
        each embedding to its nearest
        motion cluster.

        Example

            Walking : 0.8
            Standing : 0.2


Remarks

• One row every 3 seconds.
• Observation rows are immutable.


===============================================================================
2. MOTION CLUSTER TABLE
===============================================================================

Purpose
-------
Stores discovered motion clusters.

Primary Key

    cluster_id

Columns

    cluster_id              INTEGER PRIMARY KEY

    centroid                BLOB NOT NULL

    covariance              BLOB

    visit_count             INTEGER

    reconstruction_mean     REAL

    motion_summary          BLOB

    created_date            DATE

    created_time            TIME

    updated_date            DATE

    updated_time            TIME


===============================================================================
3. EPISODE TABLE
===============================================================================

Purpose
-------
Stores temporally continuous motion episodes.

Primary Key

    episode_id

Columns

    episode_id              INTEGER PRIMARY KEY AUTOINCREMENT

    start_date              DATE NOT NULL

    start_time              TIME NOT NULL

    end_date                DATE

    end_time                TIME

    duration                REAL

    motion_distribution     BLOB NOT NULL
        Aggregated motion distribution
        over the complete episode.

    familiarity_mean        REAL

    familiarity_min         REAL

    familiarity_max         REAL

    familiarity_variance    REAL


Remarks

• Dominant motion cluster is

        argmax(motion_distribution)

• It is never stored explicitly.


===============================================================================
4. EPISODE MOTION TIMELINE TABLE
===============================================================================

Purpose
-------
Stores the evolution of motion inside an episode.

One row corresponds to one Context Inference
(3-second interval).

Primary Key

    timeline_id

Columns

    timeline_id             INTEGER PRIMARY KEY AUTOINCREMENT

    episode_id              INTEGER NOT NULL

    window_start_date       DATE NOT NULL

    window_start_time       TIME NOT NULL

    motion_distribution     BLOB NOT NULL

    reconstruction_mean     REAL

Foreign Keys

    episode_id

        REFERENCES Episode(episode_id)


===============================================================================
5. LOCATION NODE TABLE
===============================================================================

Purpose
-------
Represents familiar places.

Primary Key

    location_node_id

Columns

    location_node_id        INTEGER PRIMARY KEY AUTOINCREMENT

    center_latitude         REAL NOT NULL

    center_longitude        REAL NOT NULL

    radius                  REAL NOT NULL

    visit_count             INTEGER

    total_stay_duration     REAL

    first_visit_date        DATE

    first_visit_time        TIME

    last_visit_date         DATE

    last_visit_time         TIME


===============================================================================
6. LOCATION VISIT TABLE
===============================================================================

Purpose
-------
Stores every visit made to every location node.

Primary Key

    visit_id

Columns

    visit_id                INTEGER PRIMARY KEY AUTOINCREMENT

    location_node_id        INTEGER NOT NULL

    enter_date              DATE NOT NULL

    enter_time              TIME NOT NULL

    exit_date               DATE

    exit_time               TIME

    duration                REAL

    entry_latitude          REAL

    entry_longitude         REAL

    exit_latitude           REAL

    exit_longitude          REAL

Foreign Keys

    location_node_id

        REFERENCES LocationNode(location_node_id)


===============================================================================
7. INFERENCE LOG TABLE
===============================================================================

Purpose
-------
Stores every familiarity evaluation.

Primary Key

    inference_id

Columns

    inference_id            INTEGER PRIMARY KEY AUTOINCREMENT

    date                    DATE NOT NULL

    time                    TIME NOT NULL

    familiarity_score       REAL

    anomaly_score           REAL

    emergency_score         REAL

    selected_episode        INTEGER

    selected_location       INTEGER

    explanation             TEXT


===============================================================================
DATABASE RELATIONSHIPS
===============================================================================

Observation

↓

Episode Motion Timeline

↓

Episode


Location Node

↓

Location Visit


Observation
      +
Episode
      +
Location

↓

Inference Log


Notice

Episode and Location are NOT connected
through foreign keys.

They are related only through TIME.


===============================================================================
QUERY API
===============================================================================

Motion Engine

    storeObservation()

------------------------------------------------------------

Episode Engine

    getEpisode(timestamp)

    getEpisodes(start,end)

    updateEpisode()

------------------------------------------------------------

Location Engine

    getLocation(timestamp)

    getLocations(start,end)

    estimateFamiliarity(latitude,longitude)

    updateLocation()

------------------------------------------------------------

Context Engine

    storeInference()

    getInferenceHistory()


===============================================================================
DATABASE INDEXES
===============================================================================

Observation

    (date,time)

Episode

    (start_date,start_time)

    (end_date,end_time)

Episode Motion Timeline

    (episode_id)

    (window_start_date,window_start_time)

Location Visit

    (location_node_id)

    (enter_date,enter_time)

    (exit_date,exit_time)

Inference Log

    (date,time)


===============================================================================
RETENTION POLICY
===============================================================================

Observation Table

    Keep 30 Days.

Reason

    Reclustering
    Debugging
    Visualization
    Model Improvements

------------------------------------------------------------

Motion Cluster Table

    Keep Forever.

------------------------------------------------------------

Episode Table

    Keep Forever.

------------------------------------------------------------

Episode Motion Timeline

    Keep 30 Days.

Older timelines may optionally be
compressed into the Episode's final
aggregated motion distribution.

------------------------------------------------------------

Location Node Table

    Keep Forever.

------------------------------------------------------------

Location Visit Table

    Keep Forever.

------------------------------------------------------------

Inference Log Table

    Keep 30 Days.


===============================================================================
DESIGN PRINCIPLES
===============================================================================

1.

Every engine owns only its own tables.

2.

Every other engine only queries.

3.

Time is the universal relationship.

4.

Raw observations are immutable.

5.

Episodes are semantic memory.

6.

Locations are spatial memory.

7.

Inference logs are decision history.

8.

The database never performs reasoning.

Reasoning belongs entirely to the engines.
===============================================================================