#ifndef MODEL_RUNNER_H
#define MODEL_RUNNER_H

#include <Arduino.h>

class ModelRunner {
public:
    static ModelRunner& getInstance();

    // Initialize model (e.g. load TFLite micro model, verify model footprint)
    bool begin();

    // Run inference on the 144-dimensional feature vector.
    // Returns the reconstruction error (anomaly score) in range [0.0, 1.0].
    float runInference(const float* featureVector);

    // Force a test alert anomaly score
    void setTestAlert(bool active);
    bool isTestAlertActive() const { return testAlertActive; }

private:
    ModelRunner();
    ~ModelRunner() = default;

    ModelRunner(const ModelRunner&) = delete;
    ModelRunner& operator=(const ModelRunner&) = delete;

    bool testAlertActive;
    void* interpreter; // Opaque pointer to tflite::MicroInterpreter
    void* model;       // Opaque pointer to tflite::Model
    uint8_t* raw_arena;
    uint8_t* tensor_arena;
};

#endif // MODEL_RUNNER_H
