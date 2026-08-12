===============================================================================
                   SAFEBAND CONTEXT ENGINE DESIGN (VERSION 1.0)
===============================================================================

Purpose
-------
The Context Engine is the probabilistic reasoning engine of SafeBand.

Its responsibility is to determine

    "How familiar is the user's current situation?"

using

    Current Motion

    Current Location

    Current Time

and

    Historical Behaviour.

It performs NO motion processing.

It performs NO location processing.

It performs NO episode construction.

It only performs contextual reasoning.


===============================================================================
INPUT
===============================================================================

Observation Engine

↓

Current Motion Observation


Episode Engine

↓

Episode History


Location Engine

↓

Location History


System

↓

Current Date

Current Time

Day of Week


===============================================================================
OUTPUT
===============================================================================

Produces

    Familiarity Score

    Component Scores

    Inference Log


===============================================================================
CONTEXT WINDOW CONSTRUCTION
===============================================================================

Inference Period

    Every 3 Seconds


Current Context Window

Duration

    15 Minutes


Contains

    Current Observation

    Episode Timeline

    Location Timeline

    Motion Features

    Motion Distributions

    Reconstruction Statistics


Remarks

The Context Window is the fundamental
object compared by the Context Engine.


===============================================================================
TEMPORAL HISTORY RETRIEVAL
===============================================================================

History is retrieved using

Temporal Tolerance.

Example

Current Time

    14:30

Tolerance

    ±15 Minutes


Daily Query

Returns

Yesterday

14:15 → 14:45


Weekly Query

Returns

Same Time Window

during previous week.


Monthly Query

Returns

Same Time Window

during previous month.


Purpose

Allows slight variation
in user schedules.


===============================================================================
HISTORY LEVELS
===============================================================================

Level 1

Current Context Window

15 Minutes


Level 2

Current Day


Level 3

Previous 30 Days


Each level represents a different
behavioural time scale.


===============================================================================
CONTEXT SIGNALS
===============================================================================

The Context Engine reasons using
multiple contextual signals.


------------------------------------------------------------

Motion Signal

Obtained from

    Motion Observation


Contains

    Motion Distribution

    Motion Features

    Reconstruction Statistics


------------------------------------------------------------

Temporal Signal

Contains

    Date

    Time

    Day Of Week


------------------------------------------------------------

Location Signal

Contains

    Current Coordinates

    Current Location Node

    Distance To Node


------------------------------------------------------------

Behavioural Signal

Obtained from

    Episode History

    Location History


Represents

Historical behaviour
during the selected
History Window.


===============================================================================
SIMILARITY COMPUTATION
===============================================================================

For every History Level

Construct

Current Context Window

↓

Retrieve

Historical Context Windows

↓

Compare


Similarity Components


Motion Similarity


Location Similarity


Temporal Similarity


Joint Motion-Location Similarity


Each component produces

Similarity

between

0

and

1


===============================================================================
WINDOW SIMILARITY
===============================================================================

For every Historical Context Window

Compute

Motion Similarity

+

Location Similarity

+

Temporal Similarity

+

Joint Motion-Location Similarity


↓

Fuse


Window Similarity


Result

One similarity score
per Historical Context Window.


===============================================================================
HISTORY LEVEL FAMILIARITY
===============================================================================

For every History Level

Aggregate

all Window Similarities.


Produces


15 Minute Familiarity


Today Familiarity


30 Day Familiarity


Each score

lies between

0

and

1


===============================================================================
FINAL FAMILIARITY
===============================================================================

Input

15 Minute Familiarity

↓

Today Familiarity

↓

30 Day Familiarity


↓

Fusion Function


↓

Final Familiarity Score


Range

0

to

1


Remarks

The Fusion Function is intentionally
kept independent from the engine.

Version 1 may use a weighted
combination.

Future versions may replace it with

Bayesian Fusion

Neural Calibration

Probabilistic Graphical Models

without changing the architecture.


===============================================================================
INFERENCE LOGGING
===============================================================================

Every inference stores


Date

Time

Final Familiarity

15 Minute Familiarity

Today Familiarity

30 Day Familiarity

Motion Similarity

Location Similarity

Temporal Similarity

Joint Motion-Location Similarity

Current Episode

Current Location


Stored in

Inference Log Table.


===============================================================================
QUERY API
===============================================================================

buildContextWindow()

Constructs the current
15 Minute Context Window.


------------------------------------------------------------

retrieveHistory()

Retrieves Context Windows
from

Today

Previous Week

Previous Month

using Temporal Tolerance.


------------------------------------------------------------

computeSimilarity()

Computes similarity
between

Current Context Window

and

one Historical Context Window.


------------------------------------------------------------

computeWindowSimilarity()

Combines the individual
Similarity Components
into one Window Similarity.


------------------------------------------------------------

computeHistoryFamiliarity()

Aggregates Window Similarities
for

15 Minutes

Today

30 Days.


------------------------------------------------------------

computeFinalFamiliarity()

Combines

15 Minute

Today

30 Day

Familiarity Scores
into the Final Familiarity.


------------------------------------------------------------

storeInference()

Stores current inference
inside

Inference Log.


===============================================================================
DATA OWNERSHIP
===============================================================================

Owns

Inference Log Table


Reads

Observation Table

Episode Table

Episode Motion Timeline

Location Node Table

Location Visit Table


Writes

Inference Log Table


Never modifies

Observation

Episode

Location


===============================================================================
FAILURE HANDLING
===============================================================================

History Unavailable

↓

Use available history only.


------------------------------------------------------------

No Historical Match

↓

Similarity

=

0


------------------------------------------------------------

Database Read Failure

↓

Retry

If retry fails

Log Error

Skip Current Inference.


------------------------------------------------------------

Database Write Failure

↓

Retry

If retry fails

Log Error

Discard Inference Log.


===============================================================================
ENGINE METHODS
===============================================================================

initialize()

Loads

Engine Configuration

Temporal Tolerances

History Durations.


------------------------------------------------------------

runInference()

Main entry point.

Executed every

3 Seconds.


------------------------------------------------------------

buildContextWindow()

Constructs Current
Context Window.


------------------------------------------------------------

retrieveHistory()

Retrieves all Historical
Context Windows.


------------------------------------------------------------

computeSimilarity()

Computes similarity
between two Context Windows.


------------------------------------------------------------

computeWindowSimilarity()

Produces one Window
Similarity.


------------------------------------------------------------

computeHistoryFamiliarity()

Produces

15 Minute

Today

30 Day

Familiarity Scores.


------------------------------------------------------------

computeFinalFamiliarity()

Produces

Final Familiarity Score.


------------------------------------------------------------

storeInference()

Stores current
Inference.


===============================================================================
DESIGN PRINCIPLES
===============================================================================

1.

Context Windows are the
fundamental reasoning objects.

The engine compares

Window

↔

Window

never

Observation

↔

History.

2.

All history is queried
through time.

3.

Temporal tolerance accounts
for natural schedule variation.

4.

Different History Levels
capture behaviour at different
time scales.

5.

Every Similarity Component
produces a normalized score
between

0

and

1.

6.

The engine performs
reasoning only.

It never updates

Motion

Episode

or

Location data.

7.

The Context Engine is the
sole owner of

Inference Log Table.

8.

Fusion strategy is replaceable.

Changing the mathematical
model never changes the
database or the surrounding
engines.

===============================================================================