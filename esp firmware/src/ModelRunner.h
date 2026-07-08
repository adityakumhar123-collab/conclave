#ifndef MODEL_RUNNER_H
#define MODEL_RUNNER_H

#include <Arduino.h>

class ModelRunner {
public:
    static ModelRunner& getInstance();

    // Initialize model (e.g. load TFLite micro model, verify model footprint)
    bool begin();

    // Run inference on the feature vector.
    // Returns the reconstruction error (anomaly score).
    // Writes the 16-dimensional motion fingerprint to out_embedding.
    float runInference(const float* featureVector, int8_t* out_embedding);

    // Force a test alert anomaly score
    void setTestAlert(bool active);
    bool isTestAlertActive() const { return testAlertActive; }
    bool isTensorsAllocated() const { return tensorsAllocated; }
    const char* getLastError() const;

private:
    ModelRunner();
    ~ModelRunner() = default;

    ModelRunner(const ModelRunner&) = delete;
    ModelRunner& operator=(const ModelRunner&) = delete;

    bool testAlertActive;
    bool tensorsAllocated;
    void* interpreter; // Opaque pointer to tflite::MicroInterpreter
    void* model;       // Opaque pointer to tflite::Model
    uint8_t* raw_arena;
    uint8_t* tensor_arena;
};

#endif // MODEL_RUNNER_H
