===============================================================================
                    SAFEBAND EPISODE ENGINE DESIGN (VERSION 1.0)
===============================================================================

Purpose
-------
The Episode Engine is responsible for converting continuous Motion
Observations into temporally continuous Motion Episodes.

It provides the temporal abstraction of motion.

It performs NO familiarity inference.

It performs NO location processing.

It performs NO clustering.

It only consumes Motion Observations and constructs Motion Episodes.


===============================================================================
INPUT
===============================================================================

Source

    Observation Table


Each Observation contains

    Date

    Time

    10 Embeddings

    Reconstruction Scores

    Motion Features

    Motion Distribution


Observation Frequency

    Every 3 Seconds


===============================================================================
OUTPUT
===============================================================================

Produces

    Episode Table

and

    Episode Motion Timeline Table


===============================================================================
INTERNAL STATE
===============================================================================

Current Open Episode

Contains

    Episode ID

    Start Date

    Start Time

    Running Motion Distribution

    Running Familiarity Statistics

    Timeline Length


Current Motion Distribution

Obtained from

    Current Observation


Previous Motion Distribution

Obtained from

    Previous Observation


===============================================================================
PIPELINE
===============================================================================

New Observation Arrives

↓

Extract Motion Distribution

↓

Episode Exists ?

↓

No

↓

Create New Episode

↓

Append Timeline Entry

↓

Wait


Yes

↓

Compare Motion Distribution

↓

Same Motion State ?

↓

Yes

↓

Extend Current Episode

↓

Append Timeline Entry

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

Append Timeline Entry

↓

Wait


===============================================================================
MOTION STATE DETERMINATION
===============================================================================

Input

Current Observation

Contains

    Motion Distribution


Example

Walking

0.8

Standing

0.2


Dominant Motion

=

argmax(Motion Distribution)


Remarks

The dominant motion is NEVER stored.

It is derived whenever required.

The complete Motion Distribution
is always preserved.


===============================================================================
EPISODE CREATION
===============================================================================

A new Episode is created when

The current Motion Distribution is
sufficiently different from the
previous Episode Motion Distribution.

Current Episode

↓

Close

↓

Store Final Statistics

↓

Create New Episode

↓

Current Observation becomes
the first Timeline Entry.


===============================================================================
EPISODE EXTENSION
===============================================================================

If Motion State continues

Append current Motion Distribution
to Episode Motion Timeline.

Update

    Running Motion Distribution

    Running Duration

    Running Familiarity Statistics


No historical information is lost.


===============================================================================
RUNNING AGGREGATION
===============================================================================

The Episode maintains a running
aggregate throughout its lifetime.

Aggregated

    Motion Distribution

        Running Mean

    Familiarity Mean

    Familiarity Minimum

    Familiarity Maximum

    Familiarity Variance

The Episode Table therefore always
contains the latest aggregate.

No second pass is required after
Episode closure.


===============================================================================
EPISODE MOTION TIMELINE
===============================================================================

Every Observation produces one
Timeline Entry.

Timeline Entry contains

    Episode ID

    Window Start Date

    Window Start Time

    Motion Distribution

    Reconstruction Mean


Purpose

Allows reconstruction of

Motion Evolution

inside the Episode.


===============================================================================
EPISODE QUERY API
===============================================================================

getEpisode(timestamp)

Returns

Episode containing

timestamp.


------------------------------------------------------------

getEpisodes(start,end)

Returns

Every Episode overlapping

[start,end]

ordered chronologically.


------------------------------------------------------------

getPreviousEpisodes(timestamp,k)

Returns

Previous

k

Episodes.


------------------------------------------------------------

getNextEpisodes(timestamp,k)

Returns

Next

k

Episodes.


------------------------------------------------------------

getEpisodeTimeline(episode_id)

Returns

Complete Motion Timeline
for one Episode.


===============================================================================
DATA OWNERSHIP
===============================================================================

Owns

Episode Table

Episode Motion Timeline Table


Reads

Observation Table


Writes

Episode Table

Episode Motion Timeline Table


Never modifies

Observation Table

Location Tables

Inference Log


===============================================================================
FAILURE HANDLING
===============================================================================

Observation Missing

↓

Ignore

Wait for next Observation.


------------------------------------------------------------

Database Write Failure

↓

Retry

If retry fails

Log Error

Keep Current Episode in memory.


------------------------------------------------------------

Unexpected Shutdown

↓

Restore Current Open Episode

from latest Episode entry

during Engine Initialization.


===============================================================================
ENGINE METHODS
===============================================================================

initialize()

Restores

Current Open Episode

from database.


------------------------------------------------------------

updateEpisode()

Processes one new Observation.

Determines

Create

or

Extend Episode.


------------------------------------------------------------

createEpisode()

Creates new Episode.

Initializes running aggregates.


------------------------------------------------------------

extendEpisode()

Updates

Running Motion Distribution

Running Duration

Running Familiarity Statistics.


------------------------------------------------------------

closeEpisode()

Finalizes Episode.

Stores final aggregate.


------------------------------------------------------------

appendTimeline()

Stores one Timeline Entry.


------------------------------------------------------------

updateRunningStatistics()

Updates

Motion Distribution

Familiarity Statistics

Duration


------------------------------------------------------------

getEpisode()

Returns Episode
containing timestamp.


------------------------------------------------------------

getEpisodes()

Returns ordered Episode list.


------------------------------------------------------------

getEpisodeTimeline()

Returns complete Episode Timeline.


===============================================================================
DESIGN PRINCIPLES
===============================================================================

1.

Exactly one Open Episode
exists at any instant.

2.

Episodes partition time.

No Observation belongs to
more than one Episode.

3.

Episodes are immutable
after closure.

4.

Motion Timeline preserves
all intra-Episode evolution.

5.

Motion Distribution is
always stored.

Dominant Motion is always derived.

6.

The Episode Engine performs
temporal abstraction only.

It never performs familiarity
reasoning.

7.

The Episode Engine is the
sole owner of

Episode Table

and

Episode Motion Timeline Table.

===============================================================================