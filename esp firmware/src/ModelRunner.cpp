#include "ModelRunner.h"
#include "Config.h"
#include "IMUSensor.h"
#include "model_data.h"
#include "scaling_params.h"
#include "tensorflow/lite/micro/tflite_bridge/micro_error_reporter.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/schema/schema_generated.h"
#include "tensorflow/lite/kernels/kernel_util.h"

namespace {
TfLiteStatus TilePrepare(TfLiteContext* context, TfLiteNode* node) {
  TF_LITE_ENSURE_EQ(context, node->inputs->size, 2);
  TF_LITE_ENSURE_EQ(context, node->outputs->size, 1);

  const TfLiteTensor* input = tflite::GetInput(context, node, 0);
  const TfLiteTensor* multiples = tflite::GetInput(context, node, 1);
  TfLiteTensor* output = tflite::GetOutput(context, node, 0);

  TF_LITE_ENSURE_EQ(context, output->type, input->type);
  TF_LITE_ENSURE(context, multiples->type == kTfLiteInt32 || multiples->type == kTfLiteInt64);

  int num_dims = input->dims->size;
  TF_LITE_ENSURE_EQ(context, multiples->dims->size, 1);
  TF_LITE_ENSURE_EQ(context, multiples->dims->data[0], num_dims);

  return kTfLiteOk;
}

TfLiteStatus TileInvoke(TfLiteContext* context, TfLiteNode* node) {
  const TfLiteTensor* input = tflite::GetInput(context, node, 0);
  const TfLiteTensor* multiples = tflite::GetInput(context, node, 1);
  TfLiteTensor* output = tflite::GetOutput(context, node, 0);

  TF_LITE_ENSURE_EQ(context, input->type, kTfLiteInt8);

  const int8_t* input_data = input->data.int8;
  int8_t* output_data = output->data.int8;

  int num_dims = input->dims->size;
  
  if (num_dims == 3) {
    int d0 = input->dims->data[0];
    int d1 = input->dims->data[1];
    int d2 = input->dims->data[2];

    int m0 = 1, m1 = 1, m2 = 1;
    if (multiples->type == kTfLiteInt32) {
      m0 = multiples->data.i32[0];
      m1 = multiples->data.i32[1];
      m2 = multiples->data.i32[2];
    } else if (multiples->type == kTfLiteInt64) {
      m0 = multiples->data.i64[0];
      m1 = multiples->data.i64[1];
      m2 = multiples->data.i64[2];
    }

    for (int i0 = 0; i0 < d0 * m0; ++i0) {
      int in_i0 = i0 % d0;
      for (int i1 = 0; i1 < d1 * m1; ++i1) {
        int in_i1 = i1 % d1;
        for (int i2 = 0; i2 < d2 * m2; ++i2) {
          int in_i2 = i2 % d2;

          int out_idx = (i0 * (d1 * m1) * (d2 * m2)) + (i1 * (d2 * m2)) + i2;
          int in_idx = (in_i0 * d1 * d2) + (in_i1 * d2) + in_i2;

          output_data[out_idx] = input_data[in_idx];
        }
      }
    }
    return kTfLiteOk;
  }

  TF_LITE_KERNEL_LOG(context, "Only 3D Tile is currently supported in this custom op.");
  return kTfLiteError;
}

TfLiteStatus TileParse(const tflite::Operator* op, tflite::ErrorReporter* error_reporter,
                       tflite::BuiltinDataAllocator* allocator, void** builtin_data) {
  *builtin_data = nullptr;
  return kTfLiteOk;
}

class SafeBandOpResolver : public tflite::MicroMutableOpResolver<40> {
 public:
  const TFLMRegistration* FindOp(tflite::BuiltinOperator op) const override {
    if (op == tflite::BuiltinOperator_TILE) {
      return GetTileRegistration();
    }
    return tflite::MicroMutableOpResolver<40>::FindOp(op);
  }

  tflite::TfLiteBridgeBuiltinParseFunction GetOpDataParser(
      tflite::BuiltinOperator op) const override {
    if (op == tflite::BuiltinOperator_TILE) {
      return TileParse;
    }
    return tflite::MicroMutableOpResolver<40>::GetOpDataParser(op);
  }

 private:
  static const TFLMRegistration* GetTileRegistration() {
    static TFLMRegistration r = {
        .init = nullptr,
        .free = nullptr,
        .prepare = TilePrepare,
        .invoke = TileInvoke,
        .reset = nullptr,
        .builtin_code = tflite::BuiltinOperator_TILE,
        .custom_name = nullptr
    };
    return &r;
  }
};
} // namespace

constexpr int kArenaSize = 180 * 1024; // Increased from 120 KB to 180 KB

ModelRunner& ModelRunner::getInstance() {
    static ModelRunner instance;
    return instance;
}

ModelRunner::ModelRunner() 
    : testAlertActive(false)
    , interpreter(nullptr)
    , model(nullptr)
    , raw_arena(nullptr)
    , tensor_arena(nullptr) {}

bool ModelRunner::begin() {
    Serial.println("[Model] Initializing TensorFlow Lite Micro...");

    // Allocate 16-byte aligned tensor arena on heap/PSRAM to save internal DRAM
    raw_arena = (uint8_t*)heap_caps_malloc(kArenaSize + 16, MALLOC_CAP_8BIT | MALLOC_CAP_INTERNAL);
    if (raw_arena == nullptr) {
        Serial.println("[Model] Warning: Failed to allocate arena in internal RAM. Trying PSRAM...");
        raw_arena = (uint8_t*)heap_caps_malloc(kArenaSize + 16, MALLOC_CAP_8BIT | MALLOC_CAP_SPIRAM);
        if (raw_arena == nullptr) {
            Serial.println("[Model] Error: Failed to allocate tensor arena!");
            return false;
        }
    }
    tensor_arena = (uint8_t*)(((uintptr_t)raw_arena + 15) & ~15);

    // 1. Get model pointer from C array in model_data.h
    model = (void*)tflite::GetModel(g_model_data);
    if (((const tflite::Model*)model)->version() != TFLITE_SCHEMA_VERSION) {
        Serial.printf("[Model] Error: Model schema version %d is not equal to supported version %d.\n",
                      ((const tflite::Model*)model)->version(), TFLITE_SCHEMA_VERSION);
        return false;
    }
    Serial.println("[Model] Model schema version verified.");

    // 2. Set up ops resolver
    Serial.println("[Model] Setting up Ops Resolver...");
    static SafeBandOpResolver resolver;
    resolver.AddExpandDims();
    resolver.AddConv2D();
    resolver.AddReshape();
    resolver.AddMaxPool2D();
    resolver.AddShape();
    resolver.AddStridedSlice();
    resolver.AddPack();
    resolver.AddFill();
    resolver.AddFullyConnected();
    resolver.AddTranspose();
    resolver.AddUnpack();
    resolver.AddAdd();
    resolver.AddSplit();
    resolver.AddLogistic();
    resolver.AddMul();
    resolver.AddTanh();
    resolver.AddConcatenation();
    resolver.AddTransposeConv();
    resolver.AddSqueeze();

    // 3. Set up interpreter
    Serial.println("[Model] Setting up MicroInterpreter...");
    static tflite::MicroInterpreter static_interpreter(
        (const tflite::Model*)model, resolver, tensor_arena, kArenaSize);
    interpreter = &static_interpreter;

    // 4. Allocate tensors
    Serial.println("[Model] Allocating Tensors...");
    TfLiteStatus allocate_status = static_interpreter.AllocateTensors();
    if (allocate_status != kTfLiteOk) {
        Serial.println("[Model] Error: AllocateTensors() failed.");
        return false;
    }

    Serial.println("[Model] TensorFlow Lite Micro interpreter initialized successfully!");
    return true;
}

float ModelRunner::runInference(const float* featureVector) {
    if (testAlertActive) {
        return 0.95f;
    }

    // Apply mock overrides if Mock IMU is enabled for telemetry verification
#if USE_MOCK_IMU
    MockMotionState state = IMUSensor::getInstance().getMockState();
    if (state == MOCK_MOTION_STRUGGLE) {
        return 0.85f;
    } else if (state == MOCK_MOTION_FALL) {
        // Fall simulation: high variance initially, then high anomalies
        float totalVariance = featureVector[1320 + 5]; // Trace of covariance at index 1320 + 5 = 1325
        float peakJerk = featureVector[9 * 132 + 78];  // Jerk in the last subwindow
        if (totalVariance > 45000.0f || (totalVariance < 2.5f && peakJerk > 20.0f)) {
            return 0.90f;
        }
        return 0.15f;
    }
#endif

    if (interpreter == nullptr) {
        return 0.0f;
    }

    tflite::MicroInterpreter* interp = (tflite::MicroInterpreter*)interpreter;

    // 1. Get input tensors
    TfLiteTensor* input_seq = interp->input(0);
    TfLiteTensor* input_glob = interp->input(1);

    // 2. Populate and quantize sequence input (10 timesteps x 132 features = 1320 values)
    float scale_seq = input_seq->params.scale;
    int32_t zp_seq = input_seq->params.zero_point;
    int8_t* seq_data = input_seq->data.int8;

    for (int i = 0; i < 1320; i++) {
        int featureIdx = i % 132;
        float val = featureVector[i];
        // Apply z-score normalization
        float norm_val = (val - SEQ_MEAN[featureIdx]) / (SEQ_STD[featureIdx] > 1e-6f ? SEQ_STD[featureIdx] : 1e-6f);
        int32_t qval = roundf(norm_val / scale_seq) + zp_seq;
        if (qval < -128) qval = -128;
        if (qval > 127) qval = 127;
        seq_data[i] = static_cast<int8_t>(qval);
    }

    // 3. Populate and quantize global input (12 values)
    float scale_glob = input_glob->params.scale;
    int32_t zp_glob = input_glob->params.zero_point;
    int8_t* glob_data = input_glob->data.int8;

    for (int i = 0; i < 12; i++) {
        float val = featureVector[1320 + i];
        // Apply z-score normalization
        float norm_val = (val - GLOB_MEAN[i]) / (GLOB_STD[i] > 1e-6f ? GLOB_STD[i] : 1e-6f);
        int32_t qval = roundf(norm_val / scale_glob) + zp_glob;
        if (qval < -128) qval = -128;
        if (qval > 127) qval = 127;
        glob_data[i] = static_cast<int8_t>(qval);
    }

    // 4. Run interpreter invocation
    TfLiteStatus invoke_status = interp->Invoke();
    if (invoke_status != kTfLiteOk) {
        Serial.println("[Model] Error: Invoke() failed!");
        return 0.5f; // Fallback score
    }

    // 5. Read output tensors and compute reconstruction Mean Absolute Error (MAE)
    TfLiteTensor* output_seq = interp->output(0);
    TfLiteTensor* output_glob = interp->output(1);

    // Sequence output (shape: [1, 1, 132]) is compared with the last timestep of the input (timestep 9)
    // NOTE: TFLite model only produces 1 reconstructed timestep, not 10.
    float scale_out_seq = output_seq->params.scale;
    int32_t zp_out_seq = output_seq->params.zero_point;
    const int8_t* out_seq_data = output_seq->data.int8;

    float total_seq_mae = 0.0f;
    constexpr int kLastTimestepOffset = 9 * 132;
    for (int i = 0; i < 132; i++) {
        float reconstructed_val = scale_out_seq * (out_seq_data[i] - zp_out_seq);
        float raw_val = featureVector[kLastTimestepOffset + i];
        float original_norm_val = (raw_val - SEQ_MEAN[i]) / (SEQ_STD[i] > 1e-6f ? SEQ_STD[i] : 1e-6f);
        total_seq_mae += fabsf(original_norm_val - reconstructed_val);
    }
    float seq_mae = total_seq_mae / 132.0f;

    // Global output (shape: [1, 12]) is compared with the global input
    float scale_out_glob = output_glob->params.scale;
    int32_t zp_out_glob = output_glob->params.zero_point;
    const int8_t* out_glob_data = output_glob->data.int8;

    float total_glob_mae = 0.0f;
    for (int i = 0; i < 12; i++) {
        float reconstructed_val = scale_out_glob * (out_glob_data[i] - zp_out_glob);
        float raw_val = featureVector[1320 + i];
        float original_norm_val = (raw_val - GLOB_MEAN[i]) / (GLOB_STD[i] > 1e-6f ? GLOB_STD[i] : 1e-6f);
        total_glob_mae += fabsf(original_norm_val - reconstructed_val);
    }
    float glob_mae = total_glob_mae / 12.0f;

    // Combine: weighted average over 144 total features (132 seq + 12 glob)
    // This keeps the combined score in the same range as the calibrated threshold.
    float combined_mae = (total_seq_mae + total_glob_mae) / 144.0f;

    // The raw combined MAE is returned as the anomaly score, to be compared
    // with DEFAULT_THRESHOLD (1.008393f) in the firmware.
    return combined_mae;
}

void ModelRunner::setTestAlert(bool active) {
    testAlertActive = active;
    Serial.printf("[Model] Test Alert override: %s\n", active ? "ACTIVE" : "INACTIVE");
}
