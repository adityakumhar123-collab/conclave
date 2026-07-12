# ESP32 C++ Integration Guidelines for SafeBand Model v2

This document provides step-by-step guidelines and copy-pasteable C++ snippets to integrate the optimized **SafeBand Model v2** (Config C - Tiny) into your ESP32 C++ firmware. 

---

## 1. Directory Assets

All deployment files are located in the [model_v2](file:///c:/Users/LENOVO/Downloads/data/model_v2) directory:
* [model_data.h](file:///c:/Users/LENOVO/Downloads/data/model_v2/model_data.h): C++ byte array wrapper for the INT8 quantized TFLite Micro model.
* [calibration_params_v2.json](file:///c:/Users/LENOVO/Downloads/data/model_v2/calibration_params_v2.json): JSON containing the anomaly detection thresholds.

---

## 2. Model Input/Output Schemas

The model is fully quantized to INT8. The C++ firmware must manage the following schemas:

### A. Input Tensors (Quantized to `int8_t`)
1. **`sequence_input`**: Shape `[1, 10, 132]`.
   * Represents a 2-second window (200 samples at 100 Hz) divided into **10 sub-windows** of 20 samples (200ms) each.
   * For each sub-window, compute the **132 features** (Tier 1 statistical and Tier 2 frequency features) and write them to the sequence tensor.
2. **`global_input`**: Shape `[1, 12]`.
   * Represents the **12 eigenvalues and cross-axis features** (Tier 3 structural features) calculated over the entire 200-sample window.

### B. Output Tensors (Quantized `int8_t` values)
1. **`motion_embedding`**: Shape `[1, 16]`.
   * L2-normalized 16-dimensional motion fingerprint.
2. **`reconstruction_error`**: Shape `[1, 1]`.
   * Scalar value representing the Mean Absolute Error (MAE) computed directly inside the model graph.

---

## 3. Quantization and Dequantization

Since the inputs and outputs are quantized, you must map between float features and `int8_t` tensors using the scale and zero-point parameters of the respective tensors.

### A. Quantizing Inputs (Float $\rightarrow$ Int8)
For each input value, apply the quantization formula:
$$X_{int8} = \text{clamp}\left(\text{round}\left(\frac{X_{float}}{\text{scale}}\right) + \text{zero\_point},\ -128,\ 127\right)$$

In C++:
```cpp
int8_t quantize(float value, float scale, int32_t zero_point) {
    float scaled = (value / scale) + zero_point;
    int32_t rounded = (scaled >= 0.0f) ? (int32_t)(scaled + 0.5f) : (int32_t)(scaled - 0.5f);
    if (rounded < -128) rounded = -128;
    if (rounded > 127) rounded = 127;
    return (int8_t)rounded;
}
```

### B. Dequantizing Outputs (Int8 $\rightarrow$ Float)
To get the actual reconstruction error value, dequantize the output scalar:
$$X_{float} = (X_{int8} - \text{zero\_point}) \times \text{scale}$$

In C++:
```cpp
float dequantize(int8_t value, float scale, int32_t zero_point) {
    return ((float)value - zero_point) * scale;
}
```

---

## 4. C++ Implementation Guide

### Step 1: Include Headers and Allocate Tensor Arena
Ensure you allocate a tensor arena in SRAM. The quantized Tiny model requires ~100–150 KB workspace (Tensor Arena) due to unrolled GRUs:

```cpp
#include "tensorflow/lite/micro/all_ops_resolver.h"
#include "tensorflow/lite/micro/tflite_bridge/micro_error_reporter.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/schema/schema_generated.h"
#include "model_v2/model_data.h"

// Allocate 120 KB tensor arena in SRAM
constexpr int kTensorArenaSize = 120 * 1024;
alignas(16) uint8_t tensor_arena[kTensorArenaSize];

const tflite::Model* model = nullptr;
tflite::MicroInterpreter* interpreter = nullptr;
```

### Step 2: Initialize TFLite Micro
In your `setup()` function, initialize the interpreter:

```cpp
void init_tflite_model() {
    model = tflite::GetModel(g_model_data);
    if (model->version() != TFLITE_SCHEMA_VERSION) {
        // Handle model schema version mismatch error
        return;
    }

    static tflite::AllOpsResolver resolver;
    static tflite::MicroInterpreter static_interpreter(
        model, resolver, tensor_arena, kTensorArenaSize);
    interpreter = &static_interpreter;

    TfLiteStatus allocate_status = interpreter->AllocateTensors();
    if (allocate_status != kTfliteOk) {
        // Handle allocation failure
        return;
    }
}
```

### Step 3: Populate Input Tensors
Map and quantize your calculated float features into the input tensors:

```cpp
void run_inference(float* seq_features, float* glob_features, int8_t* out_emb, float* out_recon_error) {
    // 1. Get pointer to input tensors
    TfLiteTensor* seq_input_tensor = interpreter->input(0); // Sequence input
    TfLiteTensor* glob_input_tensor = interpreter->input(1); // Global input

    // 2. Quantize and write sequence features (10 * 132 = 1320 values)
    float seq_scale = seq_input_tensor->params.scale;
    int32_t seq_zp = seq_input_tensor->params.zero_point;
    int8_t* seq_data = seq_input_tensor->data.int8;
    for (int i = 0; i < 1320; ++i) {
        seq_data[i] = quantize(seq_features[i], seq_scale, seq_zp);
    }

    // 3. Quantize and write global features (12 values)
    float glob_scale = glob_input_tensor->params.scale;
    int32_t glob_zp = glob_input_tensor->params.zero_point;
    int8_t* glob_data = glob_input_tensor->data.int8;
    for (int i = 0; i < 12; ++i) {
        glob_data[i] = quantize(glob_features[i], glob_scale, glob_zp);
    }

    // 4. Run model inference
    TfLiteStatus invoke_status = interpreter->Invoke();
    if (invoke_status != kTfliteOk) {
        // Handle invocation failure
        return;
    }

    // 5. Robust Output Querying (shape-based matching)
    TfLiteTensor* emb_tensor = nullptr;
    TfLiteTensor* err_tensor = nullptr;

    for (int i = 0; i < interpreter->outputs_size(); ++i) {
        TfLiteTensor* out = interpreter->output(i);
        if (out->dims->size == 2) {
            if (out->dims->data[1] == 16) {
                emb_tensor = out;
            } else if (out->dims->data[1] == 1) {
                err_tensor = out;
            }
        }
    }

    // 6. Copy embedding and dequantize reconstruction error
    if (emb_tensor != nullptr) {
        memcpy(out_emb, emb_tensor->data.int8, 16);
    }

    if (err_tensor != nullptr) {
        float err_scale = err_tensor->params.scale;
        int32_t err_zp = err_tensor->params.zero_point;
        *out_recon_error = dequantize(err_tensor->data.int8[0], err_scale, err_zp);
    }
}
```

---

## 5. Anomaly Thresholding & Hysteresis

To detect anomalies robustly and avoid false alerts from sudden normal arm movements, implement the **threshold comparator** and a **3-window hysteresis filter**:

### Threshold Parameters
From [calibration_params_v2.json](file:///c:/Users/LENOVO/Downloads/data/model_v2/calibration_params_v2.json):
* **Normal Reconstruction MAE Mean ($\mu$)**: `0.49340`
* **Normal Reconstruction MAE Std ($\sigma$)**: `0.17634`
* **Calibrated Anomaly Threshold ($\mu + 3\sigma$)**: **`1.02242`**

### Hysteresis Logic
Run inference at **2 Hz** (every 50 new samples = 0.5s). Only flag an anomaly if the dequantized error exceeds `1.02242` for **3 consecutive windows** (1.5 seconds of continuous anomalous motion).

```cpp
constexpr float kAnomalyThreshold = 1.02242f;
constexpr int kHysteresisLimit = 3;
int anomalous_window_counter = 0;

void process_reconstruction_error(float current_recon_error) {
    if (current_recon_error > kAnomalyThreshold) {
        anomalous_window_counter++;
        if (anomalous_window_counter >= kHysteresisLimit) {
            // Anomaly detected! Trigger struggle/fall alarm packet.
            trigger_ble_event_alert(current_recon_error);
            // Cap counter to prevent integer overflow
            anomalous_window_counter = kHysteresisLimit; 
        }
    } else {
        // Gradual decay or reset of the anomaly alert
        anomalous_window_counter = 0;
    }
}
```

This integration pipeline guarantees robust anomaly detection while mapping your inputs and outputs correctly inside your ESP32-S3 firmware.

--------------------new -------------------------------------

# ESP32 C++ Integration Guidelines for SafeBand Model v2

This document provides step-by-step guidelines and copy-pasteable C++ snippets to integrate the optimized **SafeBand Model v2** (Config C - Tiny) into your ESP32 C++ firmware. 


> [!IMPORTANT]
> **CRITICAL: The Feature Normalization Bug & Fix**
> * **The Bug**: The Model v2 was trained on Z-score normalized features. If you feed the raw, unnormalized features directly into the quantization block, the inputs will immediately clamp to the INT8 limits (`-128`/`127`), resulting in corrupt reconstructions and constant false alarms (reconstruction MAE maxes out at `1.12`).
> * **The Fix**: Before quantizing, you **must Z-score normalize** each feature in C++ using the mean ($\mu$) and standard deviation ($\sigma$) arrays calculated from the training set.
> * **Where to find scaling constants**: The training set's scaling constants are automatically generated and appended at the bottom of [model_data.h](file:///c:/Users/LENOVO/Downloads/data/model_v2/model_data.h) as the arrays:
>   * `g_seq_mean[132]` and `g_seq_std[132]` (for the sequence features)
>   * `g_glob_mean[12]` and `g_glob_std[12]` (for the global features)
> * **Quantization Formula (Z-Score + Quantization combined)**:
>   $$X_{\text{quantized}} = \text{clamp}\left(\text{round}\left(\frac{X_{\text{raw}} - \mu}{\sigma \times \text{scale}}\right) + \text{zero\_point},\ -128,\ 127\right)$$

---

## 1. Directory Assets

All deployment files are located in the [model_v2](file:///c:/Users/LENOVO/Downloads/data/model_v2) directory:
* [model_data.h](file:///c:/Users/LENOVO/Downloads/data/model_v2/model_data.h): C++ header containing the INT8 model flatbuffer array `g_model_data` and the embedded Z-score normalization scaling arrays.
* [calibration_params_v2.json](file:///c:/Users/LENOVO/Downloads/data/model_v2/calibration_params_v2.json): JSON containing the anomaly detection threshold ($\mu + 3\sigma$).

---

## 2. Model Input/Output Schemas

The model is fully quantized to INT8. The C++ firmware must manage the following schemas:

### A. Input Tensors (Quantized to `int8_t`)
1. **`sequence_input`**: Shape `[1, 10, 132]`.
   * Represents a 2-second window (200 samples at 100 Hz) divided into **10 sub-windows** of 20 samples (200ms) each.
   * For each sub-window, compute the **132 features** (Tier 1 statistical and Tier 2 frequency features) and write them to the sequence tensor.
2. **`global_input`**: Shape `[1, 12]`.
   * Represents the **12 eigenvalues and cross-axis features** (Tier 3 structural features) calculated over the entire 200-sample window.

### B. Output Tensors (Quantized `int8_t` values)
1. **`motion_embedding`**: Shape `[1, 16]`.
   * L2-normalized 16-dimensional motion fingerprint.
2. **`reconstruction_error`**: Shape `[1, 1]`.
   * Scalar value representing the Mean Absolute Error (MAE) computed directly inside the model graph.

---

## 3. Quantization and Dequantization

Since the inputs and outputs are quantized, you must map between float features and `int8_t` tensors using the scale and zero-point parameters of the respective tensors.

### A. Quantizing Inputs (Float $\rightarrow$ Int8)
For each input value, apply the quantization formula:
$$X_{int8} = \text{clamp}\left(\text{round}\left(\frac{X_{float}}{\text{scale}}\right) + \text{zero\_point},\ -128,\ 127\right)$$

In C++:
```cpp
int8_t quantize(float value, float scale, int32_t zero_point) {
    float scaled = (value / scale) + zero_point;
    int32_t rounded = (scaled >= 0.0f) ? (int32_t)(scaled + 0.5f) : (int32_t)(scaled - 0.5f);
    if (rounded < -128) rounded = -128;
    if (rounded > 127) rounded = 127;
    return (int8_t)rounded;
}
```

### B. Dequantizing Outputs (Int8 $\rightarrow$ Float)
To get the actual values on the phone-side or inside the firmware, you must dequantize the `int8_t` outputs back to `float32`.

The standard formula is:
$$X_{float} = (X_{int8} - \text{zero\_point}) \times \text{scale}$$

#### 1. Reconstruction Error (Scalar)
* **Scale**: `0.00441764`
* **Zero Point**: `-128`
* Used on the ESP32 (or phone) to get the continuous anomaly score.
* In C++:
```cpp
float dequantize_recon_error(int8_t raw_value) {
    return ((float)raw_value - (-128)) * 0.00441764f;
}
```

#### 2. Motion Embedding (16D Vector)
* **Scale**: `0.01699736`
* **Zero Point**: `-93`
* Transmitted as 16 raw `int8_t` bytes over BLE and dequantized on the **phone-side (e.g., in React Native / Expo / Swift / Kotlin)**.
* In JavaScript/TypeScript (Phone-side):
```javascript
function dequantizeEmbedding(int8Array) {
    const scale = 0.01699736;
    const zeroPoint = -93;
    return Array.from(int8Array).map(val => (val - zeroPoint) * scale);
}
```

---

## 4. C++ Implementation Guide

### Step 1: Include Headers and Allocate Tensor Arena
Ensure you allocate a tensor arena in SRAM. The quantized Tiny model requires ~100–150 KB workspace (Tensor Arena) due to unrolled GRUs:

```cpp
#include "tensorflow/lite/micro/all_ops_resolver.h"
#include "tensorflow/lite/micro/tflite_bridge/micro_error_reporter.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/schema/schema_generated.h"
#include "model_v2/model_data.h"

// Allocate 120 KB tensor arena in SRAM
constexpr int kTensorArenaSize = 120 * 1024;
alignas(16) uint8_t tensor_arena[kTensorArenaSize];

const tflite::Model* model = nullptr;
tflite::MicroInterpreter* interpreter = nullptr;
```

### Step 2: Initialize TFLite Micro
In your `setup()` function, initialize the interpreter:

```cpp
void init_tflite_model() {
    model = tflite::GetModel(g_model_data);
    if (model->version() != TFLITE_SCHEMA_VERSION) {
        // Handle model schema version mismatch error
        return;
    }

    static tflite::AllOpsResolver resolver;
    static tflite::MicroInterpreter static_interpreter(
        model, resolver, tensor_arena, kTensorArenaSize);
    interpreter = &static_interpreter;

    TfLiteStatus allocate_status = interpreter->AllocateTensors();
    if (allocate_status != kTfliteOk) {
        // Handle allocation failure
        return;
    }
}
```

### Step 3: Populate Input Tensors
Map and quantize your calculated float features into the input tensors:

```cpp
void run_inference(float* seq_features, float* glob_features, int8_t* out_emb, float* out_recon_error) {
    // 1. Get pointer to input tensors
    TfLiteTensor* seq_input_tensor = interpreter->input(0); // Sequence input
    TfLiteTensor* glob_input_tensor = interpreter->input(1); // Global input

    // 2. Normalize and quantize sequence features (10 sub-windows * 132 features = 1320 values)
    float seq_scale = seq_input_tensor->params.scale;
    int32_t seq_zp = seq_input_tensor->params.zero_point;
    int8_t* seq_data = seq_input_tensor->data.int8;
    for (int t = 0; t < 10; ++t) {
        for (int f = 0; f < 132; ++f) {
            int idx = t * 132 + f;
            float raw_val = seq_features[idx];
            // Apply Z-score normalization using constants in model_data.h
            float norm_val = (raw_val - g_seq_mean[f]) / g_seq_std[f];
            // Quantize to int8_t
            seq_data[idx] = quantize(norm_val, seq_scale, seq_zp);
        }
    }

    // 3. Normalize and quantize global features (12 values)
    float glob_scale = glob_input_tensor->params.scale;
    int32_t glob_zp = glob_input_tensor->params.zero_point;
    int8_t* glob_data = glob_input_tensor->data.int8;
    for (int f = 0; f < 12; ++f) {
        float raw_val = glob_features[f];
        // Apply Z-score normalization using constants in model_data.h
        float norm_val = (raw_val - g_glob_mean[f]) / g_glob_std[f];
        // Quantize to int8_t
        glob_data[f] = quantize(norm_val, glob_scale, glob_zp);
    }

    // 4. Run model inference
    TfLiteStatus invoke_status = interpreter->Invoke();
    if (invoke_status != kTfliteOk) {
        // Handle invocation failure
        return;
    }

    // 5. Robust Output Querying (shape-based matching)
    TfLiteTensor* emb_tensor = nullptr;
    TfLiteTensor* err_tensor = nullptr;

    for (int i = 0; i < interpreter->outputs_size(); ++i) {
        TfLiteTensor* out = interpreter->output(i);
        if (out->dims->size == 2) {
            if (out->dims->data[1] == 16) {
                emb_tensor = out;
            } else if (out->dims->data[1] == 1) {
                err_tensor = out;
            }
        }
    }

    // 6. Copy embedding and dequantize reconstruction error
    if (emb_tensor != nullptr) {
        memcpy(out_emb, emb_tensor->data.int8, 16);
    }

    if (err_tensor != nullptr) {
        float err_scale = err_tensor->params.scale;
        int32_t err_zp = err_tensor->params.zero_point;
        *out_recon_error = dequantize(err_tensor->data.int8[0], err_scale, err_zp);
    }
}
```

---

## 5. Anomaly Thresholding & Hysteresis

To detect anomalies robustly and avoid false alerts from sudden normal arm movements, implement the **threshold comparator** and a **3-window hysteresis filter**:

### Threshold Parameters
From [calibration_params_v2.json](file:///c:/Users/LENOVO/Downloads/data/model_v2/calibration_params_v2.json):
* **Normal Reconstruction MAE Mean ($\mu$)**: `0.49072`
* **Normal Reconstruction MAE Std ($\sigma$)**: `0.17412`
* **Calibrated Anomaly Threshold ($\mu + 3\sigma$)**: **`1.01309`**

### Hysteresis Logic
Run inference at **2 Hz** (every 50 new samples = 0.5s). Only flag an anomaly if the dequantized error exceeds `1.01309` for **3 consecutive windows** (1.5 seconds of continuous anomalous motion).

```cpp
constexpr float kAnomalyThreshold = 1.01309f;
constexpr int kHysteresisLimit = 3;
int anomalous_window_counter = 0;

void process_reconstruction_error(float current_recon_error) {
    if (current_recon_error > kAnomalyThreshold) {
        anomalous_window_counter++;
        if (anomalous_window_counter >= kHysteresisLimit) {
            // Anomaly detected! Trigger struggle/fall alarm packet.
            trigger_ble_event_alert(current_recon_error);
            // Cap counter to prevent integer overflow
            anomalous_window_counter = kHysteresisLimit; 
        }
    } else {
        // Gradual decay or reset of the anomaly alert
        anomalous_window_counter = 0;
    }
}
```

This integration pipeline guarantees robust anomaly detection while mapping your inputs and outputs correctly inside your ESP32-S3 firmware.
