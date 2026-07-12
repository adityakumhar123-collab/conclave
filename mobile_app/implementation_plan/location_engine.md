===============================================================================
                   SAFEBAND LOCATION ENGINE DESIGN (VERSION 1.0)
===============================================================================

Purpose
-------
The Location Engine is responsible for converting continuous GPS updates
into semantically meaningful Location Nodes and Location Visits.

It represents the user's spatial memory.

It performs NO familiarity inference.

It performs NO motion processing.

It performs NO episode generation.

It only maintains the spatial history of the user.


===============================================================================
INPUT
===============================================================================

Source

    Phone Location Callback


Each callback contains

    Date

    Time

    Latitude

    Longitude

    Accuracy


Callback Frequency

    Approximately every 3 seconds
    (synchronized with Context Inference)


===============================================================================
OUTPUT
===============================================================================

Produces

    Location Node Table

and

    Location Visit Table


===============================================================================
INTERNAL STATE
===============================================================================

Current Active Visit

Contains

    Visit ID

    Node ID

    Entry Date

    Entry Time

    Entry Coordinates


Current GPS Position

Contains

    Date

    Time

    Latitude

    Longitude

    Accuracy


Known Location Nodes

Loaded from

    Location Node Table


===============================================================================
PIPELINE
===============================================================================

Location Callback

↓

Update Current GPS

↓

Find Nearest Location Node

↓

Inside Existing Node ?

↓

Yes

↓

Continue Current Visit

↓

Update Current Visit Duration

↓

Wait


No

↓

Inside Candidate New Node Region ?

↓

No

↓

Continue Monitoring

↓

Wait


Yes

↓

Stayed Within Radius
for Minimum Time ?

↓

No

↓

Continue Monitoring

↓

Wait


Yes

↓

Create New Location Node

↓

Start New Visit

↓

Wait


===============================================================================
LOCATION NODE DETECTION
===============================================================================

For every GPS Callback

↓

Compute Distance

between

Current Coordinate

and

Every Known Location Node


Distance

Computed using

Haversine Distance


Nearest Node

↓

Distance < Node Radius ?

↓

Yes

↓

Inside Node


Otherwise

Outside Every Node


===============================================================================
NEW LOCATION NODE CREATION
===============================================================================

A new Location Node is created only if

User remains within

Radius R

for

Minimum Time T


When conditions are satisfied

↓

Create

Location Node

Store

Center Latitude

Center Longitude

Radius

First Visit

Last Visit


===============================================================================
LOCATION VISIT MANAGEMENT
===============================================================================

Entering Node

↓

Create

Location Visit


Store

Entry Date

Entry Time

Entry Coordinates


Remaining Inside

↓

Update Duration


Leaving Node

↓

Close Visit


Store

Exit Date

Exit Time

Exit Coordinates


Remarks

Exit Time

=

First callback observed
outside the node.


===============================================================================
LOCATION NODE UPDATE
===============================================================================

Whenever a Visit finishes

Update

    Visit Count

    Total Stay Duration

    Last Visit Date

    Last Visit Time


Node Center

Remains Fixed

unless future versions
explicitly support relocation.


===============================================================================
LOCATION QUERY API
===============================================================================

getLocation(timestamp)

Returns

Location Visit containing

timestamp.


------------------------------------------------------------

getLocations(start,end)

Returns

Every Location Visit

overlapping

[start,end]

ordered chronologically.


------------------------------------------------------------

getLocationNode(node_id)

Returns

Complete Location Node
information.


------------------------------------------------------------

estimateFamiliarity(latitude,longitude)

Uses

Nearby Location Nodes

to estimate familiarity
for arbitrary coordinates.

(Current implementation uses
spatial extrapolation from
known nodes.)


===============================================================================
DATA OWNERSHIP
===============================================================================

Owns

Location Node Table

Location Visit Table


Reads

Nothing


Writes

Location Node Table

Location Visit Table


Never modifies

Observation Table

Episode Table

Inference Log


===============================================================================
FAILURE HANDLING
===============================================================================

GPS Callback Missing

↓

Keep Current Visit Open

Wait for next callback.


------------------------------------------------------------

Low GPS Accuracy

↓

Ignore callback

Wait for next valid reading.


------------------------------------------------------------

Database Write Failure

↓

Retry

If retry fails

Log Error

Keep Current Visit
in memory.


------------------------------------------------------------

Unexpected Shutdown

↓

Restore Current Active Visit

from latest Location Visit

during Engine Initialization.


===============================================================================
ENGINE METHODS
===============================================================================

initialize()

Loads

Known Location Nodes

Restores

Current Active Visit.


------------------------------------------------------------

onLocationUpdate()

Receives one GPS callback.

Updates Current Position.


------------------------------------------------------------

findNearestNode()

Computes Haversine Distance
to every known Location Node.

Returns

Nearest Node.


------------------------------------------------------------

isInsideNode()

Checks whether

Current Position

lies inside

Node Radius.


------------------------------------------------------------

createLocationNode()

Creates a new
Location Node.


------------------------------------------------------------

startVisit()

Creates a new
Location Visit.


------------------------------------------------------------

updateVisit()

Updates

Current Visit Duration.


------------------------------------------------------------

closeVisit()

Stores

Exit Time

Exit Coordinates

Duration.


------------------------------------------------------------

updateNodeStatistics()

Updates

Visit Count

Total Stay Duration

Last Visit Time


------------------------------------------------------------

getLocation()

Returns Location Visit
containing timestamp.


------------------------------------------------------------

getLocations()

Returns ordered
Location Visit list.


------------------------------------------------------------

estimateFamiliarity()

Returns extrapolated
familiarity for any
GPS coordinate.


===============================================================================
DESIGN PRINCIPLES
===============================================================================

1.

Exactly one Active Location Visit
exists at any instant.

2.

Location Visits partition time.

No timestamp belongs to
more than one Visit.

3.

Location Nodes represent
persistent familiar places.

4.

Location Visits represent
individual occurrences of
visiting a Location Node.

5.

Node statistics are updated
only when a Visit closes.

6.

Location familiarity is NOT
computed here.

Only raw spatial history
is maintained.

7.

The Location Engine is the
sole owner of

Location Node Table

and

Location Visit Table.

8.

Time is the primary query key.

All history retrieval is
performed through time-based
queries.

===============================================================================