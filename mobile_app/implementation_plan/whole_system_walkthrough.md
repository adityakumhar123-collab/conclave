===============================================================================
            SAFEBAND COMPLETE SYSTEM WALKTHROUGH (VERSION 1.0)
===============================================================================

Purpose
-------
This document describes the complete execution flow of SafeBand,
starting from raw IMU measurements and ending at the final emergency
decision.

It serves as the integration document for all previously designed
engines.


===============================================================================
SYSTEM COMPONENTS
===============================================================================

ESP32 Firmware

↓

BLE Communication

↓

Motion Engine

↓

Episode Engine

↓

Location Engine

↓

Context Engine

↓

Emergency Engine

↓

Background Services


===============================================================================
STEP 1
ESP32 FIRMWARE
===============================================================================

Sampling Rate

100 Hz

↓

Sliding Window

200 Samples

↓

Feature Extraction

Tier-1 Features

Tier-2 Features

Tier-3 Features

↓

TinyML Encoder

↓

Outputs

16-D Embedding

Reconstruction Score

↓

BLE Packet


===============================================================================
STEP 2
BLE COMMUNICATION
===============================================================================

ESP32

↓

BLE Notify

↓

Mobile Application

↓

Packet Parsing

↓

Motion Engine


===============================================================================
STEP 3
MOTION ENGINE
===============================================================================

Input

Current BLE Packet

Contains

Timestamp

Embedding

Reconstruction Score

Motion Features

↓

Append

Circular Buffer

↓

Buffer Full ?

Need

10 Embeddings

No

↓

Wait

Yes

↓

Construct Motion Observation


Motion Observation

Date

Time

10 Embeddings

10 Reconstruction Scores

Motion Features

↓

Nearest Cluster Assignment

↓

Motion Distribution

↓

Store

Observation Table

↓

Advance Sliding Window

6 Embeddings


===============================================================================
STEP 4
EPISODE ENGINE
===============================================================================

Read

Latest Observation

↓

Extract

Motion Distribution

↓

Compare

with

Current Open Episode

↓

Same Motion State ?

Yes

↓

Extend Episode

↓

Append

Episode Motion Timeline

↓

Update Running Statistics

↓

Wait


No

↓

Close Current Episode

↓

Create New Episode

↓

Append Timeline

↓

Wait


===============================================================================
STEP 5
LOCATION ENGINE
===============================================================================

Receive

GPS Callback

↓

Nearest Location Node

↓

Inside Existing Node ?

Yes

↓

Update Current Visit

↓

Update Duration

↓

Wait


No

↓

Stayed within Radius

for

Minimum Time ?

No

↓

Wait

Yes

↓

Create New Location Node

↓

Create New Visit


Leaving Node

↓

Close Visit

↓

Update

Visit Statistics


===============================================================================
STEP 6
CONTEXT ENGINE
===============================================================================

Runs

Every

3 Seconds

↓

Construct

Current Context Window

Duration

15 Minutes


Contains

Current Observation

Episode Timeline

Location Timeline

Motion Features

Motion Distribution

Current Time

Current Coordinates


↓

Retrieve Historical Context Windows


History Levels

15 Minutes

Today

30 Days


Each retrieval uses

Temporal Tolerance

Example

Current

14:30

↓

Search

14:15

to

14:45


===============================================================================
STEP 7
SIMILARITY COMPUTATION
===============================================================================

For every Historical Context Window

Compute


Motion Similarity


Location Similarity


Temporal Similarity


Joint Motion-Location Similarity


↓

Fuse

↓

Window Similarity


Repeat

for every matching
Historical Context Window


↓

Aggregate


15 Minute Familiarity


Today Familiarity


30 Day Familiarity


↓

Fuse


Final Familiarity Score


Range

0

↓

1


===============================================================================
STEP 8
EMERGENCY DECISION ENGINE
===============================================================================

Inputs

Current Reconstruction Score

↓

Current Motion Distribution

↓

Final Familiarity Score

↓

Current Location Context

↓

Historical Behaviour


------------------------------------------------------------

Stage 1

Motion Anomaly Detection


Input

Reconstruction Score


If

Reconstruction Score

>

Model Threshold

↓

Motion Anomaly

Else

Normal Motion


------------------------------------------------------------

Stage 2

Context Evaluation


Input

Final Familiarity


High Familiarity

↓

Situation likely normal.


Low Familiarity

↓

Situation contextually unusual.


------------------------------------------------------------

Stage 3

Emergency Confidence


Combine

Motion Anomaly

+

Context Familiarity


Produces

Emergency Confidence


Range

0

↓

1


------------------------------------------------------------

Stage 4

Decision


Emergency Confidence

<

Threshold 1

↓

No Action


------------------------------------------------------------

Threshold 1

≤

Emergency Confidence

<

Threshold 2

↓

Continue Monitoring

Increase Sampling Confidence

No Notification


------------------------------------------------------------

Threshold 2

≤

Emergency Confidence

↓

Raise Emergency Alert

Notify User

Start Emergency Workflow


Remarks

The exact fusion equation is intentionally
left configurable.

Version 1 may use a weighted probabilistic
fusion.

Future versions may replace it without
changing the architecture.


===============================================================================
STEP 9
DATABASE UPDATES
===============================================================================

Motion Engine

↓

Observation Table


Episode Engine

↓

Episode Table

Episode Motion Timeline


Location Engine

↓

Location Node Table

Location Visit Table


Context Engine

↓

Inference Log


Emergency Engine

↓

Notification

(No database ownership)


===============================================================================
STEP 10
BACKGROUND SERVICES
===============================================================================

Executed Asynchronously


Motion Reclustering


Retention Cleanup


Statistics Update


Database Optimization


Backup


Health Monitoring


Never blocks

Real-Time Inference


===============================================================================
COMPLETE EXECUTION LOOP
===============================================================================

ESP32

↓

Feature Extraction

↓

TinyML

↓

BLE

↓

Motion Engine

↓

Observation

↓

Episode Engine

↓

Location Engine

↓

Context Engine

↓

Final Familiarity

↓

Emergency Engine

↓

Decision

↓

Store Results

↓

Wait

3 Seconds

↓

Repeat


===============================================================================
SYSTEM DESIGN PRINCIPLES
===============================================================================

1.

Motion, Episode, Location and Context
engines have independent responsibilities.

2.

Each engine owns only its own tables.

3.

All engines communicate through
well-defined query APIs.

4.

Time is the common relationship
between Motion, Episode and Location.

5.

Context Windows are the fundamental
reasoning objects.

6.

The database stores knowledge.

The engines perform reasoning.

7.

The Emergency Engine never reasons
directly from raw IMU data.

It always reasons from

Motion

+

Context

+

History.

8.

Every inference produces exactly one
Familiarity Score.

Every emergency decision is based on

Current Motion

+

Historical Behaviour

+

Current Context.

===============================================================================