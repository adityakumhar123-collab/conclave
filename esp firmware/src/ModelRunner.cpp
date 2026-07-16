#include "ModelRunner.h"
#include "Config.h"
#include "IMUSensor.h"
#include "model_data.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/micro/tflite_bridge/micro_error_reporter.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/schema/schema_generated.h"
#include "tensorflow/lite/kernels/kernel_util.h"

namespace {
TfLiteStatus TilePrepare(TfLiteContext* context, TfLiteNode* node) {
  tflite::MicroContext* micro_context = tflite::GetMicroContext(context);
  TF_LITE_ENSURE_EQ(context, node->inputs->size, 2);
  TF_LITE_ENSURE_EQ(context, node->outputs->size, 1);

  TfLiteTensor* input = micro_context->AllocateTempInputTensor(node, 0);
  TF_LITE_ENSURE(context, input != nullptr);
  TfLiteTensor* multiples = micro_context->AllocateTempInputTensor(node, 1);
  TF_LITE_ENSURE(context, multiples != nullptr);
  TfLiteTensor* output = micro_context->AllocateTempOutputTensor(node, 0);
  TF_LITE_ENSURE(context, output != nullptr);

  TfLiteStatus status = kTfLiteOk;
  if (output->type != input->type) {
    status = kTfLiteError;
  } else if (multiples->type != kTfLiteInt32 && multiples->type != kTfLiteInt64) {
    status = kTfLiteError;
  } else {
    int num_dims = input->dims->size;
    if (multiples->dims->size != 1 || multiples->dims->data[0] != num_dims) {
      status = kTfLiteError;
    }
  }

  micro_context->DeallocateTempTfLiteTensor(input);
  micro_context->DeallocateTempTfLiteTensor(multiples);
  micro_context->DeallocateTempTfLiteTensor(output);
  return status;
}

TfLiteStatus TileInvoke(TfLiteContext* context, TfLiteNode* node) {
  tflite::MicroContext* micro_context = tflite::GetMicroContext(context);
  TfLiteTensor* input = micro_context->AllocateTempInputTensor(node, 0);
  TfLiteTensor* multiples = micro_context->AllocateTempInputTensor(node, 1);
  TfLiteTensor* output = micro_context->AllocateTempOutputTensor(node, 0);

  TF_LITE_ENSURE_EQ(context, input->type, kTfLiteInt8);

  const int8_t* input_data = input->data.int8;
  int8_t* output_data = output->data.int8;

  int num_dims = input->dims->size;
  TfLiteStatus status = kTfLiteOk;
  
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
  } else {
    TF_LITE_KERNEL_LOG(context, "Only 3D Tile is currently supported in this custom op.");
    status = kTfLiteError;
  }

  micro_context->DeallocateTempTfLiteTensor(input);
  micro_context->DeallocateTempTfLiteTensor(multiples);
  micro_context->DeallocateTempTfLiteTensor(output);
  return status;
}

TfLiteStatus TileParse(const tflite::Operator* op, tflite::ErrorReporter* error_reporter,
                       tflite::BuiltinDataAllocator* allocator, void** builtin_data) {
  *builtin_data = nullptr;
  return kTfLiteOk;
}

TfLiteStatus ReduceProdPrepare(TfLiteContext* context, TfLiteNode* node) {
  TF_LITE_ENSURE_EQ(context, node->inputs->size, 2);
  TF_LITE_ENSURE_EQ(context, node->outputs->size, 1);
  return kTfLiteOk;
}

TfLiteStatus ReduceProdInvoke(TfLiteContext* context, TfLiteNode* node) {
  tflite::MicroContext* micro_context = tflite::GetMicroContext(context);
  TfLiteTensor* input = micro_context->AllocateTempInputTensor(node, 0);
  TfLiteTensor* output = micro_context->AllocateTempOutputTensor(node, 0);

  TfLiteStatus status = kTfLiteOk;
  if (input->type != kTfLiteInt32 || output->type != kTfLiteInt32) {
    status = kTfLiteError;
  } else {
    int32_t prod = 1;
    int num_elements = 1;
    for (int i = 0; i < input->dims->size; i++) {
      num_elements *= input->dims->data[i];
    }

    const int32_t* input_data = input->data.i32;
    for (int i = 0; i < num_elements; i++) {
      prod *= input_data[i];
    }

    output->data.i32[0] = prod;
  }

  micro_context->DeallocateTempTfLiteTensor(input);
  micro_context->DeallocateTempTfLiteTensor(output);
  return status;
}

TfLiteStatus ReduceProdParse(const tflite::Operator* op, tflite::ErrorReporter* error_reporter,
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
    if (op == tflite::BuiltinOperator_REDUCE_PROD) {
      return GetReduceProdRegistration();
    }
    return tflite::MicroMutableOpResolver<40>::FindOp(op);
  }

  tflite::TfLiteBridgeBuiltinParseFunction GetOpDataParser(
      tflite::BuiltinOperator op) const override {
    if (op == tflite::BuiltinOperator_TILE) {
      return TileParse;
    }
    if (op == tflite::BuiltinOperator_REDUCE_PROD) {
      return ReduceProdParse;
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

  static const TFLMRegistration* GetReduceProdRegistration() {
    static TFLMRegistration r = {
        .init = nullptr,
        .free = nullptr,
        .prepare = ReduceProdPrepare,
        .invoke = ReduceProdInvoke,
        .reset = nullptr,
        .builtin_code = tflite::BuiltinOperator_REDUCE_PROD,
        .custom_name = nullptr
    };
    return &r;
  }
};
} // namespace

alignas(16) static uint8_t static_tensor_arena[165 * 1024];
constexpr int kArenaSize = 165 * 1024;

ModelRunner& ModelRunner::getInstance() {
    static ModelRunner instance;
    return instance;
}

ModelRunner::ModelRunner() 
    : tensorsAllocated(false)
    , interpreter(nullptr)
    , model(nullptr)
    , raw_arena(nullptr)
    , tensor_arena(nullptr) {}

extern "C" char g_last_tflm_error[256];

bool ModelRunner::begin() {
    g_last_tflm_error[0] = '\0';
    Serial.println("[Model] Initializing TensorFlow Lite Micro...");

    raw_arena = nullptr;
    tensor_arena = static_tensor_arena;

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
    resolver.AddDepthwiseConv2D();
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
    resolver.AddSplitV();
    resolver.AddLogistic();
    resolver.AddMul();
    resolver.AddTanh();
    resolver.AddConcatenation();
    resolver.AddTransposeConv();
    resolver.AddSqueeze();
    resolver.AddSub();
    resolver.AddQuantize();
    resolver.AddDequantize();
    resolver.AddL2Normalization();
    resolver.AddAbs();
    resolver.AddMean();
    resolver.AddReduceMax();
    resolver.AddGather();

    static tflite::MicroInterpreter static_interpreter(
        (const tflite::Model*)model, resolver, static_tensor_arena, kArenaSize);
    interpreter = &static_interpreter;

    // 4. Allocate tensors
    Serial.println("[Model] Allocating Tensors...");
    TfLiteStatus allocate_status = static_interpreter.AllocateTensors();
    if (allocate_status != kTfLiteOk) {
        Serial.printf("[Model] Error: AllocateTensors() failed with status %d.\n", allocate_status);
        tensorsAllocated = false;
        return false;
    }

    tensorsAllocated = true;
    Serial.printf("[Model] Outputs size: %d\n", static_interpreter.outputs_size());
    for (int i = 0; i < static_interpreter.outputs_size(); ++i) {
        TfLiteTensor* out = static_interpreter.output(i);
        Serial.printf("[Model] Output %d: Name=%s, Type=%d, DimsSize=%d, Dims=[", i, out->name ? out->name : "none", out->type, out->dims->size);
        for (int d = 0; d < out->dims->size; ++d) {
            Serial.printf("%d%s", out->dims->data[d], (d == out->dims->size - 1) ? "" : ", ");
        }
        Serial.println("]");
    }
    Serial.println("[Model] TensorFlow Lite Micro interpreter initialized successfully!");
    return true;
}

float ModelRunner::runInference(const float* featureVector, int8_t* out_embedding) {
    if (!tensorsAllocated || interpreter == nullptr) {
        if (out_embedding != nullptr) {
            memset(out_embedding, 0, 16);
        }
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
        // Apply z-score normalization with division-by-zero prevention
        float norm_val = 0.0f;
        if (g_seq_std[featureIdx] > 1e-6f) {
            norm_val = (val - g_seq_mean[featureIdx]) / g_seq_std[featureIdx];
        }
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
        // Apply z-score normalization with division-by-zero prevention
        float norm_val = 0.0f;
        if (g_glob_std[i] > 1e-6f) {
            norm_val = (val - g_glob_mean[i]) / g_glob_std[i];
        }
        int32_t qval = roundf(norm_val / scale_glob) + zp_glob;
        if (qval < -128) qval = -128;
        if (qval > 127) qval = 127;
        glob_data[i] = static_cast<int8_t>(qval);
    }

    // 4. Run interpreter invocation
    TfLiteStatus invoke_status = interp->Invoke();
    if (invoke_status != kTfLiteOk) {
        Serial.println("[Model] Error: Invoke() failed!");
        if (out_embedding != nullptr) {
            memset(out_embedding, 0, 16);
        }
        return 0.5f; // Fallback score
    }

    // 5. Robust Output Querying (shape-based matching)
    TfLiteTensor* emb_tensor = nullptr;
    TfLiteTensor* err_tensor = nullptr;

    for (int i = 0; i < interp->outputs_size(); ++i) {
        TfLiteTensor* out = interp->output(i);
        if (out->dims->size == 2) {
            if (out->dims->data[1] == 16) {
                emb_tensor = out;
            } else if (out->dims->data[1] == 1) {
                err_tensor = out;
            }
        }
    }

    // 6. Copy embedding and dequantize reconstruction error
    if (emb_tensor != nullptr && out_embedding != nullptr) {
        memcpy(out_embedding, emb_tensor->data.int8, 16);
    } else if (out_embedding != nullptr) {
        memset(out_embedding, 0, 16);
    }

    float recon_error = 0.0f;
    if (err_tensor != nullptr) {
        int8_t rawVal = err_tensor->data.int8[0];
        recon_error = (static_cast<float>(rawVal) - (-128)) * 0.00441764f;
    }

    return recon_error;
}



extern "C" char g_last_tflm_error[256] = "";

const char* ModelRunner::getLastError() const {
    return g_last_tflm_error;
}
