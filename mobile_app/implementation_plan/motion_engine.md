===============================================================================
                    SAFEBAND MOTION ENGINE DESIGN (VERSION 1.0)
===============================================================================

Purpose
-------
The Motion Engine is responsible for transforming the continuous BLE stream
coming from the ESP32 into Motion Observations that can be stored in the
database.

It performs NO familiarity inference.

It performs NO episode creation.

It performs NO location processing.

Its only responsibility is to produce a clean description of the current
motion every Context Inference.


===============================================================================
INPUT
===============================================================================

Source

    BLE Notifications

Each notification contains

    • 16-D Motion Embedding
    • Reconstruction Score
    • Motion Features
    • Timestamp


===============================================================================
OUTPUT
===============================================================================

One Motion Observation every Context Inference.

The observation is inserted into

    Observation Table


===============================================================================
INTERNAL STATE
===============================================================================

Embedding Buffer

Purpose

    Maintains the sliding window.

Structure

    Circular Buffer

Contents

    Embedding

    Reconstruction Score

    Motion Features

    Timestamp


Window Size

    10 Embeddings

Corresponds to

    5 seconds


Stride

    6 Embeddings

Corresponds to

    3 seconds


===============================================================================
PROCESSING PIPELINE
===============================================================================

BLE Packet

↓

Parse Packet

↓

Append to Circular Buffer

↓

Window Full ?

↓

No

↓

Wait


Yes

↓

Construct Motion Observation

↓

Store Observation

↓

Advance Sliding Window

↓

Wait


===============================================================================
MOTION OBSERVATION CONSTRUCTION
===============================================================================

Input

Current Sliding Window

Contains

    10 Embeddings

    10 Reconstruction Scores

    10 Motion Feature Sets


Step 1

Collect all

    10 Embeddings


Step 2

Collect all

    Reconstruction Scores


Step 3

Collect all

    Motion Features


Step 4

Create Observation

Observation

    date

    time

    embeddings

    reconstruction_scores

    motion_features


Store

Observation Table


===============================================================================
BACKGROUND CLUSTERING
===============================================================================

Purpose

Discover recurring motion patterns.


Runs

Background Task

Never blocks real-time inference.


Pipeline

Load Observation History

↓

Extract Embeddings

↓

Run Clustering Algorithm

↓

Generate Motion Clusters

↓

Update Motion Cluster Table


===============================================================================
ONLINE CLUSTER ASSIGNMENT
===============================================================================

Purpose

Assign every embedding to its nearest
Motion Cluster.


For each Embedding

↓

Nearest Cluster

↓

Cluster ID


Repeat

10 Times


Build

Motion Distribution


Example

Walking

8

Standing

2


Normalize

Walking

0.8

Standing

0.2


Store

cluster_distribution

inside Observation.


===============================================================================
ENGINE METHODS
===============================================================================

initialize()

Initializes

    BLE

    Circular Buffer

    Database


------------------------------------------------------------

onBLEPacket()

Receives one BLE notification.

Parses packet.

Appends packet to Circular Buffer.


------------------------------------------------------------

isWindowReady()

Returns

True

if

10 embeddings are available.


------------------------------------------------------------

buildObservation()

Constructs one Observation from
current Sliding Window.


------------------------------------------------------------

storeObservation()

Writes Observation into database.


------------------------------------------------------------

assignClusters()

Assigns every embedding in current
window to nearest Motion Cluster.

Produces

Motion Distribution.


------------------------------------------------------------

advanceWindow()

Moves Circular Buffer

by

6 embeddings.


------------------------------------------------------------

runBackgroundClustering()

Loads historical embeddings.

Runs clustering.

Updates Motion Cluster Table.


===============================================================================
DATA OWNERSHIP
===============================================================================

Owns

Observation Table


Reads

Motion Cluster Table

(read-only)


Writes

Observation Table


Never modifies

Episode Table

Location Tables

Inference Log


===============================================================================
FAILURE HANDLING
===============================================================================

BLE Packet Lost

↓

Ignore

Wait for next packet.


------------------------------------------------------------

Window Not Full

↓

No Observation Produced.


------------------------------------------------------------

No Motion Clusters Exist

↓

Store Observation

Skip Cluster Assignment.

Background clustering will create
clusters later.


------------------------------------------------------------

Database Write Failure

↓

Retry

If retry fails

Log Error

Discard Observation.


===============================================================================
DESIGN PRINCIPLES
===============================================================================

1.

Motion Engine is stateless
except for the Circular Buffer.

2.

Produces one Observation every
Context Inference.

3.

Never performs reasoning.

4.

Never modifies Episode or
Location data.

5.

Background Clustering is completely
independent of real-time inference.

6.

Motion Engine is the only owner
of the Observation Table.

===============================================================================


One refinement I'd make

I would add one more object inside the Motion Engine:

MotionObservationBuilder

instead of letting the engine itself assemble the observation.

Its sole responsibility would be:

10 Embeddings
        +
10 Reconstruction Scores
        +
10 Motion Feature Sets
            │
            ▼
    Motion Observation

The Motion Engine then becomes an orchestrator:

BLE
 │
 ▼
Circular Buffer
 │
 ▼
MotionObservationBuilder
 │
 ▼
Observation
 │
 ▼
Database

This separates data acquisition from observation construction, making the code cleaner and making it much easier to unit-test the observation-building logic independently of BLE and database code. I think that's the only structural improvement I'd make to this design.