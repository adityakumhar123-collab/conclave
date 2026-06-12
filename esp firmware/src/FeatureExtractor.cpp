#include "FeatureExtractor.h"
#include <math.h>
#include <algorithm>

FeatureExtractor& FeatureExtractor::getInstance() {
    static FeatureExtractor instance;
    return instance;
}

FeatureExtractor::FeatureExtractor() {
    reset();
}

void FeatureExtractor::reset() {
    writeIndex = 0;
    totalSamplesAdded = 0;
    strideCounter = 0;
    
    memset(ringAx, 0, sizeof(ringAx));
    memset(ringAy, 0, sizeof(ringAy));
    memset(ringAz, 0, sizeof(ringAz));
    memset(ringGx, 0, sizeof(ringGx));
    memset(ringGy, 0, sizeof(ringGy));
    memset(ringGz, 0, sizeof(ringGz));
}

bool FeatureExtractor::addSample(const IMUData& sample, float* outFeatureVector) {
    // Write into circular buffers
    ringAx[writeIndex] = sample.ax;
    ringAy[writeIndex] = sample.ay;
    ringAz[writeIndex] = sample.az;
    ringGx[writeIndex] = sample.gx;
    ringGy[writeIndex] = sample.gy;
    ringGz[writeIndex] = sample.gz;
    
    writeIndex = (writeIndex + 1) % WINDOW_SIZE;
    totalSamplesAdded++;
    strideCounter++;
    
    // Check if we have enough samples for at least one full window AND we reached the stride
    if (totalSamplesAdded >= WINDOW_SIZE && strideCounter >= STRIDE_SIZE) {
        strideCounter = 0; // Reset stride counter
        
        // Flatten the circular buffer into contiguous arrays (oldest sample at index 0)
        uint32_t readIdx = writeIndex; // writeIndex points to the oldest sample in the circular buffer
        for (int i = 0; i < WINDOW_SIZE; i++) {
            winAx[i] = ringAx[readIdx];
            winAy[i] = ringAy[readIdx];
            winAz[i] = ringAz[readIdx];
            winGx[i] = ringGx[readIdx];
            winGy[i] = ringGy[readIdx];
            winGz[i] = ringGz[readIdx];
            readIdx = (readIdx + 1) % WINDOW_SIZE;
        }
        
        // Extract features
        extractFeatures(outFeatureVector);
        return true;
    }
    
    return false;
}

void FeatureExtractor::extractFeatures(float* outFeatureVector) {
    // 1. Compute derived signals for the window
    for (int i = 0; i < WINDOW_SIZE; i++) {
        float ax = winAx[i];
        float ay = winAy[i];
        float az = winAz[i];
        float gx = winGx[i];
        float gy = winGy[i];
        float gz = winGz[i];
        
        winResultantA[i] = sqrtf(ax*ax + ay*ay + az*az);
        winResultantG[i] = sqrtf(gx*gx + gy*gy + gz*gz);
        winSMA[i] = (fabsf(ax) + fabsf(ay) + fabsf(az)) / 3.0f;
        winTiltAngle[i] = atan2f(az, sqrtf(ax*ax + ay*ay));
        
        // Jerk: finite difference (matching Python training np.diff scale)
        if (i > 0) {
            winJerk[i] = (winResultantA[i] - winResultantA[i-1]);
        } else {
            winJerk[0] = 0.0f; 
        }
    }
    // Set Jerk[0] equal to Jerk[1] to avoid zero step anomaly at start
    winJerk[0] = winJerk[1];
    
    // 2. Perform Extraction
    int offset = 0;
    
    // Extract 132 features for each of the 10 sub-windows (1320 features total)
    for (int t = 0; t < NUM_SUB_WINDOWS; t++) {
        extractSubWindowFeatures(t, outFeatureVector + offset);
        offset += (TIER1_FEATURES + TIER2_FEATURES);
    }
    
    // Extract Tier 3 global features (12 features)
    extractTier3(outFeatureVector, offset);
}

void FeatureExtractor::extractTier1(float* outFeatures, int& offset) {
    // 9 Channels: winAx, winAy, winAz, winGx, winGy, winGz, winResultantA, winJerk, winSMA
    float* channels[NUM_CHANNELS] = {
        winAx, winAy, winAz,
        winGx, winGy, winGz,
        winResultantA, winJerk, winSMA
    };
    
    float tempBuf[WINDOW_SIZE];
    
    for (int c = 0; c < NUM_CHANNELS; c++) {
        float* x = channels[c];
        
        // 1. Mean
        float sum = 0.0f;
        for (int i = 0; i < WINDOW_SIZE; i++) {
            sum += x[i];
        }
        float mean = sum / WINDOW_SIZE;
        
        // 2. Standard Deviation & RMS
        float varSum = 0.0f;
        float rmsSum = 0.0f;
        for (int i = 0; i < WINDOW_SIZE; i++) {
            float diff = x[i] - mean;
            varSum += diff * diff;
            rmsSum += x[i] * x[i];
        }
        float stdDev = sqrtf(varSum / WINDOW_SIZE);
        float rms = sqrtf(rmsSum / WINDOW_SIZE);
        
        // 3. Skewness & Kurtosis
        float skewSum = 0.0f;
        float kurtSum = 0.0f;
        if (stdDev > 1e-6f) {
            for (int i = 0; i < WINDOW_SIZE; i++) {
                float normDiff = (x[i] - mean) / stdDev;
                float nd2 = normDiff * normDiff;
                skewSum += nd2 * normDiff;
                kurtSum += nd2 * nd2;
            }
        }
        float skewness = skewSum / WINDOW_SIZE;
        float kurtosis = (kurtSum / WINDOW_SIZE) - 3.0f;
        
        // 4. Zero Crossing Rate (raw zero) & Mean Crossing Rate
        int zcCount = 0;
        int mcCount = 0;
        for (int i = 1; i < WINDOW_SIZE; i++) {
            // Raw Zero Crossings
            if ((x[i] >= 0.0f) != (x[i-1] >= 0.0f)) {
                zcCount++;
            }
            // Mean Crossings
            if ((x[i] >= mean) != (x[i-1] >= mean)) {
                mcCount++;
            }
        }
        float zcr = static_cast<float>(zcCount) / WINDOW_SIZE;
        float mcr = static_cast<float>(mcCount) / WINDOW_SIZE;
        
        // 5. Percentiles (IQR, Peak-to-Peak, Percentile Ratio)
        // Make a copy to sort
        memcpy(tempBuf, x, sizeof(tempBuf));
        std::sort(tempBuf, tempBuf + WINDOW_SIZE);
        
        float q1 = tempBuf[50];  // 25%
        float q3 = tempBuf[150]; // 75%
        float iqr = q3 - q1;
        
        float peakToPeak = tempBuf[WINDOW_SIZE - 1] - tempBuf[0];
        
        float p10 = tempBuf[20];  // 10%
        float p90 = tempBuf[180]; // 90%
        float percentileRatio = 0.0f;
        if (fabsf(p10) > 1e-6f) {
            percentileRatio = p90 / p10;
        } else {
            // Clamp to avoid div by zero
            percentileRatio = p90 / (p10 >= 0.0f ? 1e-6f : -1e-6f);
        }
        
        // Pack into output vector
        outFeatures[offset++] = mean;
        outFeatures[offset++] = stdDev;
        outFeatures[offset++] = rms;
        outFeatures[offset++] = skewness;
        outFeatures[offset++] = kurtosis;
        outFeatures[offset++] = zcr;
        outFeatures[offset++] = mcr;
        outFeatures[offset++] = iqr;
        outFeatures[offset++] = peakToPeak;
        outFeatures[offset++] = percentileRatio;
    }
}

void FeatureExtractor::extractTier2(float* outFeatures, int& offset) {
    // 6 Primary Channels
    float* primaryChannels[6] = {
        winAx, winAy, winAz,
        winGx, winGy, winGz
    };
    
    float fftMag[129];
    
    for (int c = 0; c < 6; c++) {
        float* x = primaryChannels[c];
        
        // Compute Mean for AC subtraction in autocorrelation
        float sum = 0.0f;
        for (int i = 0; i < WINDOW_SIZE; i++) {
            sum += x[i];
        }
        float mean = sum / WINDOW_SIZE;
        
        // Run FFT
        runFFT(x, fftMag);
        
        // 1. Dominant Frequency
        float maxMag = -1.0f;
        int maxIdx = 1;
        // Start from index 1 to ignore DC offset
        for (int k = 1; k <= 128; k++) {
            if (fftMag[k] > maxMag) {
                maxMag = fftMag[k];
                maxIdx = k;
            }
        }
        float dominantFreq = static_cast<float>(maxIdx) * (static_cast<float>(SAMPLE_RATE_HZ) / static_cast<float>(FFT_SIZE));
        
        // 2. Spectral Energy in Bands
        // Band definitions:
        // [0 - 2 Hz]: Bin 0 to 5 (0.0 to 1.95 Hz)
        // [2 - 5 Hz]: Bin 6 to 12 (2.34 to 4.68 Hz)
        // [5 - 12 Hz]: Bin 13 to 30 (5.08 to 11.72 Hz)
        // [12 - 20 Hz]: Bin 31 to 51 (12.11 to 19.92 Hz)
        float band1 = 0.0f;
        float band2 = 0.0f;
        float band3 = 0.0f;
        float band4 = 0.0f;
        
        for (int k = 0; k <= 5; k++)   band1 += fftMag[k] * fftMag[k];
        for (int k = 6; k <= 12; k++)  band2 += fftMag[k] * fftMag[k];
        for (int k = 13; k <= 30; k++) band3 += fftMag[k] * fftMag[k];
        for (int k = 31; k <= 51; k++) band4 += fftMag[k] * fftMag[k];
        
        // Total spectral power
        float totalPower = 0.0f;
        for (int k = 0; k <= 128; k++) {
            totalPower += fftMag[k] * fftMag[k];
        }
        
        // 3. Spectral Entropy
        float spectralEntropy = 0.0f;
        if (totalPower > 1e-6f) {
            for (int k = 0; k <= 128; k++) {
                float pk = (fftMag[k] * fftMag[k]) / totalPower;
                if (pk > 1e-9f) {
                    spectralEntropy -= pk * logf(pk);
                }
            }
        }
        
        // 4. Peak Frequency Ratio
        float peakFreqRatio = 0.0f;
        if (totalPower > 1e-6f) {
            peakFreqRatio = (fftMag[maxIdx] * fftMag[maxIdx]) / totalPower;
        }
        
        // 5. Autocorrelation at Lag 1, 5, 10 (mean-subtracted)
        float r0 = 0.0f;
        float r1 = 0.0f;
        float r5 = 0.0f;
        float r10 = 0.0f;
        
        for (int i = 0; i < WINDOW_SIZE; i++) {
            float x_ac = x[i] - mean;
            r0 += x_ac * x_ac;
            if (i < WINDOW_SIZE - 1)  r1 += x_ac * (x[i+1] - mean);
            if (i < WINDOW_SIZE - 5)  r5 += x_ac * (x[i+5] - mean);
            if (i < WINDOW_SIZE - 10) r10 += x_ac * (x[i+10] - mean);
        }
        
        float autoCorr1 = 0.0f;
        float autoCorr5 = 0.0f;
        float autoCorr10 = 0.0f;
        if (r0 > 1e-6f) {
            autoCorr1 = r1 / r0;
            autoCorr5 = r5 / r0;
            autoCorr10 = r10 / r0;
        }
        
        // Pack into output vector
        outFeatures[offset++] = dominantFreq;
        outFeatures[offset++] = band1;
        outFeatures[offset++] = band2;
        outFeatures[offset++] = band3;
        outFeatures[offset++] = band4;
        outFeatures[offset++] = spectralEntropy;
        outFeatures[offset++] = peakFreqRatio;
        
        // Let's check: the spec says "Tier 2: 7 features * 6 primary channels = 42 features".
        // Wait, what about Autocorrelation features? Oh! The table in Section 4 lists:
        // 1. Dominant Frequency
        // 2. Spectral Energy in Bands (which gives 4 values)
        // 3. Spectral Entropy (1 value)
        // 4. Peak Frequency Ratio (1 value)
        // That is already 7 features!
        // 5. Autocorrelation at Lag 1, 5, 10.
        // Wait! Autocorrelation adds 3 more features. If we included them, we'd have 10 features per channel!
        // But the summary says: "Tier 2: 7 features * 6 primary channels = 42 features".
        // Let's count what we have in the Tier 2 table:
        // - Dominant Frequency (1)
        // - Spectral Energy in Bands (4)
        // - Spectral Entropy (1)
        // - Peak Frequency Ratio (1)
        // - Autocorrelation at Lag 1, 5, 10 (3)
        // That is 10 features. If we had 10 features per channel, it would be 60 features.
        // But the text says "Tier 2: 7 features x 6 primary channels = 42 features".
        // How can we fit the 7 features constraint?
        // Let's see: maybe "Spectral Energy in Bands" was counts as 1 or 4, and Autocorrelation is or isn't included.
        // Let's check: if "Spectral Energy in Bands" is 1 feature (e.g. total energy? No, "Energy in [0-2], [2-5], [5-12], [12-20] — covers rest, walking, vigorous activity, and impact bands" is clearly 4 bands).
        // Let's see:
        // 1. Dominant Frequency
        // 2. Band 1 Energy
        // 3. Band 2 Energy
        // 4. Band 3 Energy
        // 5. Band 4 Energy
        // 6. Spectral Entropy
        // 7. Peak Frequency Ratio
        // That is exactly 7 features!
        // If we also output Autocorrelation at Lag 1, 5, 10, then that would make 10.
        // Wait! Let's check the wording of Section 3 & 4:
        // "Tier 2 — Frequency Domain Features (capture rhythm and periodicity)"
        // And the summary:
        // "- Tier 1: 10 features x 9 channels = 90 features
        //  - Tier 2: 7 features x 6 primary channels = 42 features
        //  - Tier 3: 12 structural features = 12 features
        //  - Total: ~144 features per window"
        // 90 + 42 + 12 = 144.
        // So Tier 2 MUST have exactly 7 features per channel, meaning 42 features in total.
        // Therefore, we should exclude Autocorrelation from the 144 feature vector, OR we should include it and exclude something else.
        // If we look at the table, the 7 features to make 42 are:
        // 1. Dominant Frequency
        // 2. Band 1 Energy
        // 3. Band 2 Energy
        // 4. Band 3 Energy
        // 5. Band 4 Energy
        // 6. Spectral Entropy
        // 7. Peak Frequency Ratio
        // This makes exactly 7 features! Autocorrelation was probably an extra suggestion, or we can just omit it from the final feature vector so that the feature vector size is exactly 144. Let's do exactly this! It is clean, respects the math 90 + 42 + 12 = 144, and avoids mismatching sizes.
    }
}

void FeatureExtractor::extractTier3(float* outFeatures, int& offset) {
    // 6 Primary Channels: winAx, winAy, winAz, winGx, winGy, winGz
    float* primaryChannels[6] = {
        winAx, winAy, winAz,
        winGx, winGy, winGz
    };
    
    // Compute Means
    float means[6] = {0.0f};
    for (int c = 0; c < 6; c++) {
        float sum = 0.0f;
        for (int i = 0; i < WINDOW_SIZE; i++) {
            sum += primaryChannels[c][i];
        }
        means[c] = sum / WINDOW_SIZE;
    }
    
    // Compute 6x6 Covariance Matrix
    float cov[6][6];
    for (int i = 0; i < 6; i++) {
        for (int j = i; j < 6; j++) {
            float sum = 0.0f;
            for (int t = 0; t < WINDOW_SIZE; t++) {
                sum += (primaryChannels[i][t] - means[i]) * (primaryChannels[j][t] - means[j]);
            }
            float val = sum / (WINDOW_SIZE - 1.0f);
            cov[i][j] = val;
            cov[j][i] = val; // Symmetric
        }
    }
    
    // Compute Eigenvalues of Covariance Matrix
    float eigenvalues[6];
    computeEigenvalues(cov, eigenvalues);
    sortDescending(eigenvalues, 6);
    
    float l1 = eigenvalues[0];
    float l2 = eigenvalues[1];
    float l3 = eigenvalues[2];
    
    // Calculate Trace (total variance)
    float sumLambda = 0.0f;
    for (int i = 0; i < 6; i++) {
        sumLambda += eigenvalues[i];
    }
    
    // Structural features calculations
    float linearity = 0.0f;
    float top3Sum = l1 + l2 + l3;
    if (top3Sum > 1e-6f) {
        linearity = l1 / top3Sum;
    }
    
    float planarity = 0.0f;
    if (sumLambda > 1e-6f) {
        planarity = (l1 + l2) / sumLambda;
    }
    
    float conditionNumber = 0.0f;
    float l6 = eigenvalues[5];
    if (fabsf(l6) > 1e-9f) {
        conditionNumber = l1 / l6;
    } else {
        conditionNumber = l1 / 1e-9f;
    }

    
    // Pack into output vector (12 features total)
    outFeatures[offset++] = l1;
    outFeatures[offset++] = l2;
    outFeatures[offset++] = l3;
    outFeatures[offset++] = linearity;
    outFeatures[offset++] = planarity;
    outFeatures[offset++] = sumLambda;
    outFeatures[offset++] = conditionNumber;
    
    // Off-diagonal covariance coupling terms
    outFeatures[offset++] = cov[0][3]; // Cov(Ax, Gx)
    outFeatures[offset++] = cov[1][4]; // Cov(Ay, Gy)
    outFeatures[offset++] = cov[2][5]; // Cov(Az, Gz)
    
    // Two extra couplings to hit exactly 12 structural features:
    outFeatures[offset++] = cov[0][1]; // Cov(Ax, Ay)
    outFeatures[offset++] = cov[3][4]; // Cov(Gx, Gy)
}

void FeatureExtractor::runFFT(const float* input, float* magnitudeOut) {
    float real[FFT_SIZE];
    float imag[FFT_SIZE];
    
    // Apply Hanning Window to 200 samples and Zero-pad to 256
    for (int i = 0; i < WINDOW_SIZE; i++) {
        float w = 0.5f * (1.0f - cosf(2.0f * M_PI * i / (WINDOW_SIZE - 1)));
        real[i] = input[i] * w;
        imag[i] = 0.0f;
    }
    for (int i = WINDOW_SIZE; i < FFT_SIZE; i++) {
        real[i] = 0.0f;
        imag[i] = 0.0f;
    }
    
    // Bit-reversal permutation
    int j = 0;
    for (int i = 0; i < FFT_SIZE; i++) {
        if (i < j) {
            float temp_r = real[i]; real[i] = real[j]; real[j] = temp_r;
            float temp_i = imag[i]; imag[i] = imag[j]; imag[j] = temp_i;
        }
        int m = FFT_SIZE >> 1;
        while (m >= 1 && j >= m) {
            j -= m;
            m >>= 1;
        }
        j += m;
    }
    
    // Cooley-Tukey Radix-2 FFT Butterfly calculations
    for (int len = 2; len <= FFT_SIZE; len <<= 1) {
        float angle = -2.0f * M_PI / len;
        float wlen_r = cosf(angle);
        float wlen_i = sinf(angle);
        for (int i = 0; i < FFT_SIZE; i += len) {
            float w_r = 1.0f;
            float w_i = 0.0f;
            int len2 = len >> 1;
            for (int k = 0; k < len2; k++) {
                int u = i + k;
                int v = u + len2;
                float t_r = real[v] * w_r - imag[v] * w_i;
                float t_i = real[v] * w_i + imag[v] * w_r;
                
                real[v] = real[u] - t_r;
                imag[v] = imag[u] - t_i;
                real[u] += t_r;
                imag[u] += t_i;
                
                float next_w_r = w_r * wlen_r - w_i * wlen_i;
                w_i = w_r * wlen_i + w_i * wlen_r;
                w_r = next_w_r;
            }
        }
    }
    
    // Calculate magnitude for single-sided spectrum (k = 0 to 128)
    for (int k = 0; k <= FFT_SIZE / 2; k++) {
        magnitudeOut[k] = sqrtf(real[k] * real[k] + imag[k] * imag[k]);
    }
}

// Jacobi eigenvalue algorithm for 6x6 symmetric matrix
void FeatureExtractor::computeEigenvalues(const float cov[6][6], float* eigenvaluesOut) {
    float A[6][6];
    // Copy covariance matrix to work matrix
    for (int i = 0; i < 6; i++) {
        for (int j = 0; j < 6; j++) {
            A[i][j] = cov[i][j];
        }
    }
    
    const int maxIterations = 50;
    const float threshold = 1e-7f;
    
    for (int iter = 0; iter < maxIterations; iter++) {
        // Find the maximum off-diagonal element
        float maxVal = 0.0f;
        int p = 0, q = 0;
        for (int i = 0; i < 6; i++) {
            for (int j = i + 1; j < 6; j++) {
                if (fabsf(A[i][j]) > maxVal) {
                    maxVal = fabsf(A[i][j]);
                    p = i;
                    q = j;
                }
            }
        }
        
        // Convergence check
        if (maxVal < threshold) {
            break;
        }
        
        // Calculate rotation parameters
        float app = A[p][p];
        float aqq = A[q][q];
        float apq = A[p][q];
        
        float tau = (aqq - app) / (2.0f * apq);
        float t;
        if (tau >= 0.0f) {
            t = 1.0f / (tau + sqrtf(1.0f + tau * tau));
        } else {
            t = -1.0f / (-tau + sqrtf(1.0f + tau * tau));
        }
        
        float c = 1.0f / sqrtf(1.0f + t * t);
        float s = t * c;
        
        // Perform rotation on matrix A
        A[p][p] = app - t * apq;
        A[q][q] = aqq + t * apq;
        A[p][q] = 0.0f;
        A[q][p] = 0.0f;
        
        for (int r = 0; r < 6; r++) {
            if (r != p && r != q) {
                float arp = A[r][p];
                float arq = A[r][q];
                A[r][p] = c * arp - s * arq;
                A[r][q] = s * arp + c * arq;
                A[p][r] = A[r][p]; // Symmetric
                A[q][r] = A[r][q]; // Symmetric
            }
        }
    }
    
    // Diagonal elements of A contain the eigenvalues
    for (int i = 0; i < 6; i++) {
        eigenvaluesOut[i] = A[i][i];
        // Clean up small negative eigenvalues (noise from float precision)
        if (eigenvaluesOut[i] < 0.0f) {
            eigenvaluesOut[i] = 0.0f;
        }
    }
}

void FeatureExtractor::sortDescending(float* arr, int size) {
    std::sort(arr, arr + size, std::greater<float>());
}

static float getPercentile(const float* sortedData, float p) {
    float idx = p * 19.0f / 100.0f;
    int low = static_cast<int>(floorf(idx));
    int high = static_cast<int>(ceilf(idx));
    if (low == high) return sortedData[low];
    float weight = idx - low;
    return sortedData[low] + weight * (sortedData[high] - sortedData[low]);
}

void FeatureExtractor::extractSubWindowFeatures(int subWindowIdx, float* outFeatures) {
    int startIdx = subWindowIdx * SUB_WINDOW_SIZE;
    
    // Arrays to hold Tier 1 features for all 9 channels
    float means[9];
    float stds[9];
    float rmss[9];
    float skews[9];
    float kurts[9];
    float zcrs[9];
    float mcrs[9];
    float iqrs[9];
    float ptps[9];
    float ratios[9];
    
    float* channels[NUM_CHANNELS] = {
        winAx, winAy, winAz,
        winGx, winGy, winGz,
        winResultantA, winJerk, winSMA
    };
    
    float tempBuf[20];
    
    for (int c = 0; c < NUM_CHANNELS; c++) {
        const float* x = channels[c] + startIdx;
        
        // 1. Mean
        float sum = 0.0f;
        for (int i = 0; i < 20; i++) {
            sum += x[i];
        }
        float mean = sum / 20.0f;
        means[c] = mean;
        
        // 2. Standard Deviation & RMS
        float varSum = 0.0f;
        float rmsSum = 0.0f;
        for (int i = 0; i < 20; i++) {
            float diff = x[i] - mean;
            varSum += diff * diff;
            rmsSum += x[i] * x[i];
        }
        float stdDev = sqrtf(varSum / 20.0f);
        stds[c] = stdDev + 1e-8f; // std = np.std(x) + 1e-8
        rmss[c] = sqrtf(rmsSum / 20.0f);
        
        // 3. Skewness & Kurtosis
        float skewSum = 0.0f;
        float kurtSum = 0.0f;
        float s3 = stds[c] * stds[c] * stds[c];
        float s4 = stds[c] * stds[c] * stds[c] * stds[c];
        for (int i = 0; i < 20; i++) {
            float diff = x[i] - mean;
            skewSum += diff * diff * diff;
            kurtSum += diff * diff * diff * diff;
        }
        skews[c] = (skewSum / 20.0f) / s3;
        kurts[c] = ((kurtSum / 20.0f) / s4) - 3.0f;
        
        // 4. Zero Crossing Rate (ZCR) & Mean Crossing Rate (MCR)
        int zcCount = 0;
        int mcCount = 0;
        for (int i = 1; i < 20; i++) {
            auto sign1 = (x[i] > 0.0f) ? 1 : ((x[i] < 0.0f) ? -1 : 0);
            auto sign0 = (x[i-1] > 0.0f) ? 1 : ((x[i-1] < 0.0f) ? -1 : 0);
            if (sign1 != sign0) {
                zcCount++;
            }
            
            float diff1 = x[i] - mean;
            float diff0 = x[i-1] - mean;
            auto msign1 = (diff1 > 0.0f) ? 1 : ((diff1 < 0.0f) ? -1 : 0);
            auto msign0 = (diff0 > 0.0f) ? 1 : ((diff0 < 0.0f) ? -1 : 0);
            if (msign1 != msign0) {
                mcCount++;
            }
        }
        zcrs[c] = static_cast<float>(zcCount) / 19.0f;
        mcrs[c] = static_cast<float>(mcCount) / 19.0f;
        
        // 5. Percentiles (IQR, PtP, Percentile Ratio)
        memcpy(tempBuf, x, sizeof(tempBuf));
        std::sort(tempBuf, tempBuf + 20);
        
        float q1 = getPercentile(tempBuf, 25.0f);
        float q3 = getPercentile(tempBuf, 75.0f);
        iqrs[c] = q3 - q1;
        ptps[c] = tempBuf[19] - tempBuf[0];
        
        float p90 = getPercentile(tempBuf, 90.0f);
        float p10 = getPercentile(tempBuf, 10.0f);
        float denom = p10 + 1e-8f;
        if (fabsf(denom) < 1e-9f) {
            denom = denom >= 0.0f ? 1e-9f : -1e-9f;
        }
        ratios[c] = p90 / denom;
    }
    
    // Copy Tier 1 features in group-by-feature-type order
    int outIdx = 0;
    for (int i = 0; i < 9; i++) outFeatures[outIdx++] = means[i];
    for (int i = 0; i < 9; i++) outFeatures[outIdx++] = stds[i];
    for (int i = 0; i < 9; i++) outFeatures[outIdx++] = rmss[i];
    for (int i = 0; i < 9; i++) outFeatures[outIdx++] = skews[i];
    for (int i = 0; i < 9; i++) outFeatures[outIdx++] = kurts[i];
    for (int i = 0; i < 9; i++) outFeatures[outIdx++] = zcrs[i];
    for (int i = 0; i < 9; i++) outFeatures[outIdx++] = mcrs[i];
    for (int i = 0; i < 9; i++) outFeatures[outIdx++] = iqrs[i];
    for (int i = 0; i < 9; i++) outFeatures[outIdx++] = ptps[i];
    for (int i = 0; i < 9; i++) outFeatures[outIdx++] = ratios[i];
    
    // 2. Tier 2 features: 7 features for each of the 6 primary channels
    float dom_freqs[6];
    float entropies[6];
    float peak_ratios[6];
    float r1s[6];
    float r5s[6];
    float r10s[6];
    float band_energies[6];
    
    float* primaryChannels[6] = {
        winAx, winAy, winAz,
        winGx, winGy, winGz
    };
    
    float dftMag[11];
    
    for (int c = 0; c < 6; c++) {
        const float* x = primaryChannels[c] + startIdx;
        
        // Compute 20-point DFT on Hanning windowed input
        runDFT20(x, dftMag);
        
        float psd[11];
        float psd_sum = 1e-8f;
        for (int k = 0; k <= 10; k++) {
            psd[k] = dftMag[k] * dftMag[k];
            psd_sum += psd[k];
        }
        
        // 1. Dominant Frequency (exclude DC bin)
        float maxMag = -1.0f;
        int maxIdx = 1;
        for (int k = 1; k <= 10; k++) {
            if (dftMag[k] > maxMag) {
                maxMag = dftMag[k];
                maxIdx = k;
            }
        }
        dom_freqs[c] = static_cast<float>(maxIdx);
        
        // 2. Spectral Entropy
        float entropy = 0.0f;
        for (int k = 0; k <= 10; k++) {
            float pk = psd[k] / psd_sum;
            entropy -= pk * logf(pk + 1e-8f);
        }
        entropies[c] = entropy;
        
        // 3. Peak Frequency Ratio
        float peak_energy = dftMag[maxIdx] * dftMag[maxIdx];
        peak_ratios[c] = peak_energy / psd_sum;
        
        // 4, 5, 6. Autocorrelation Lags 1, 5, 10
        float varSum = 0.0f;
        for (int i = 0; i < 20; i++) {
            float diff = x[i] - means[c];
            varSum += diff * diff;
        }
        float varVal = (varSum / 20.0f) + 1e-8f;
        
        float sum1 = 0.0f;
        for (int i = 0; i < 19; i++) {
            sum1 += (x[i] - means[c]) * (x[i+1] - means[c]);
        }
        r1s[c] = (sum1 / 19.0f) / varVal;
        
        float sum5 = 0.0f;
        for (int i = 0; i < 15; i++) {
            sum5 += (x[i] - means[c]) * (x[i+5] - means[c]);
        }
        r5s[c] = (sum5 / 15.0f) / varVal;
        
        float sum10 = 0.0f;
        for (int i = 0; i < 10; i++) {
            sum10 += (x[i] - means[c]) * (x[i+10] - means[c]);
        }
        r10s[c] = (sum10 / 10.0f) / varVal;
        
        // 7. Energy in dominant band (sum of bins 1 to 4 -> 5 to 20 Hz)
        float bandSum = psd[1] + psd[2] + psd[3] + psd[4];
        band_energies[c] = bandSum / psd_sum;
    }
    
    // Copy Tier 2 features in group-by-feature-type order
    for (int i = 0; i < 6; i++) outFeatures[outIdx++] = dom_freqs[i];
    for (int i = 0; i < 6; i++) outFeatures[outIdx++] = entropies[i];
    for (int i = 0; i < 6; i++) outFeatures[outIdx++] = peak_ratios[i];
    for (int i = 0; i < 6; i++) outFeatures[outIdx++] = r1s[i];
    for (int i = 0; i < 6; i++) outFeatures[outIdx++] = r5s[i];
    for (int i = 0; i < 6; i++) outFeatures[outIdx++] = r10s[i];
    for (int i = 0; i < 6; i++) outFeatures[outIdx++] = band_energies[i];
}

void FeatureExtractor::runDFT20(const float* input, float* magnitudeOut) {
    float x_hanning[20];
    for (int i = 0; i < 20; i++) {
        float w = 0.5f - 0.5f * cosf(2.0f * M_PI * i / 19.0f);
        x_hanning[i] = input[i] * w;
    }
    
    for (int k = 0; k <= 10; k++) {
        float real = 0.0f;
        float imag = 0.0f;
        float angle_factor = -2.0f * M_PI * k / 20.0f;
        for (int n = 0; n < 20; n++) {
            float angle = angle_factor * n;
            real += x_hanning[n] * cosf(angle);
            imag += x_hanning[n] * sinf(angle);
        }
        magnitudeOut[k] = sqrtf(real * real + imag * imag);
    }
}

