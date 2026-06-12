#ifndef FEATURE_EXTRACTOR_H
#define FEATURE_EXTRACTOR_H

#include "Config.h"
#include "IMUSensor.h"

class FeatureExtractor {
public:
    static FeatureExtractor& getInstance();

    // Reset buffer state
    void reset();

    // Add a new sample to the circular buffer.
    // If a new 200-sample window is ready (every 50 samples stride),
    // returns true and populates outFeatureVector with 144 features.
    bool addSample(const IMUData& sample, float* outFeatureVector);

private:
    FeatureExtractor();
    ~FeatureExtractor() = default;

    FeatureExtractor(const FeatureExtractor&) = delete;
    FeatureExtractor& operator=(const FeatureExtractor&) = delete;

    // Sliding window buffer structures
    float ringAx[WINDOW_SIZE];
    float ringAy[WINDOW_SIZE];
    float ringAz[WINDOW_SIZE];
    float ringGx[WINDOW_SIZE];
    float ringGy[WINDOW_SIZE];
    float ringGz[WINDOW_SIZE];

    uint32_t writeIndex;
    uint32_t totalSamplesAdded;
    uint32_t strideCounter;

    // Temporary flat window buffers for processing
    float winAx[WINDOW_SIZE];
    float winAy[WINDOW_SIZE];
    float winAz[WINDOW_SIZE];
    float winGx[WINDOW_SIZE];
    float winGy[WINDOW_SIZE];
    float winGz[WINDOW_SIZE];
    float winResultantA[WINDOW_SIZE];
    float winResultantG[WINDOW_SIZE];
    float winJerk[WINDOW_SIZE];
    float winSMA[WINDOW_SIZE];
    float winTiltAngle[WINDOW_SIZE];

    // Extraction helper functions
    void extractFeatures(float* outFeatureVector);
    void extractSubWindowFeatures(int subWindowIdx, float* outFeatures);
    void extractTier1(float* outFeatures, int& offset);
    void extractTier2(float* outFeatures, int& offset);
    void extractTier3(float* outFeatures, int& offset);

    // Mathematical sub-routines
    void runFFT(const float* input, float* magnitudeOut);
    void runDFT20(const float* input, float* magnitudeOut);
    void computeEigenvalues(const float cov[6][6], float* eigenvaluesOut);
    void sortDescending(float* arr, int size);

};

#endif // FEATURE_EXTRACTOR_H
