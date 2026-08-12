This document below describes the feature engineering that has been done for the tiny ml model in the esp firmware. the features are divided into ,tier 1 , 2 and 3. it also explains the widow config for the tinyml model.
use this for context and understanding how the tiny ml works and i guess there is a mention about the tier 1,2,3 features in one of the implementation plans in this folder for the mobile app as well, and so use this for reference. 

## Window Configuration

* Sampling Rate: 100 Hz
* Window Length: 200 samples (2 seconds)
* Stride: 50 samples (0.5 seconds)
* Inference Rate: 2 Hz

---

# Feature Organization

The feature pipeline is divided into two fundamentally different information streams.

## Stream A – Temporal Feature Sequence

This stream captures **how motion evolves over time**.

The 2-second window is subdivided into temporal segments, producing a sequence of feature vectors.

Each timestep contains approximately 132 engineered features consisting primarily of:

* Statistical Features (Tier 1)

  * Mean
  * Standard Deviation
  * RMS
  * Skewness
  * Kurtosis
  * Zero Crossing Rate
  * Mean Crossing Rate
  * Interquartile Range
  * Peak-to-Peak
  * Percentile Ratio

computed over:

* Accelerometer axes
* Gyroscope axes
* Resultant acceleration
* Jerk
* Signal Magnitude Area (SMA)
  (9 channels)

along with Frequency Domain Features (Tier 2):

* Dominant Frequency
* Spectral Band Energies
* Spectral Entropy
* Peak Frequency Ratio
* Autocorrelation features

tier 2 is computed over 6 channels (ax,ay,az, gx,gy,gz).

This sequence represents the **temporal evolution** of motion.

This is the primary input to the neural encoder.

---

## Stream B – Structural Global Features

This stream summarizes the **overall geometry** of the entire 2-second window.

It consists of approximately 12 structural descriptors derived from the 6×6 covariance matrix of:

* Ax
* Ay
* Az
* Gx
* Gy
* Gz

Features include:

* Principal Eigenvalues
* Eigenvalue Ratios
* Linearity
* Planarity
* Total Variance
* Condition Number
* Cross-axis Covariance Terms

Unlike the temporal sequence, these features are **window-level descriptors**.
