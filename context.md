# SafeBand Session Context - ESP32-S3 TinyML Allocation & BLE Bug Fixes

This file serves as a handoff context for subsequent sessions. It documents the root causes, modified files, and verified solutions for the ESP32-S3 model initialization crashes and BLE communication failures.

---

## 1. Resolved Issues & Bug Fixes

### A. Dynamic Reshape Dimension Mismatch (Memory Planner Registry Crash)
* **File Modified**: [reshape_common.cc](file:///c:/Users/Shlok%20Shah/Documents/GitHub/conclave2.0/conclave/esp%20firmware/.pio/libdeps/seeed_xiao_esp32s3/ESP_TF/src/tensorflow/lite/micro/kernels/reshape_common.cc)
* **Root Cause**: The flatbuffer model uses a placeholder shape of `[1, 1]` for the dynamic Reshape output dims. During the `Prepare` phase of the reshape operator, updating the temporary `TfLiteTensor::dims` array does not propagate to the memory planner. The memory planner queries the persistent `TfLiteEvalTensor` instead, leading it to allocate only 1 byte of space in the arena, causing register panics during initialization.
* **Fix**: Retrieved `TfLiteEvalTensor* output_eval` via `GetEvalOutput` and updated BOTH `output->dims` and `output_eval->dims` to point to the newly allocated persistent shape buffer (`new_dims`).

### B. Safety Guards & Bypassed Early Exit in Allocator
* **File Modified**: [micro_allocator.cc](file:///c:/Users/Shlok%20Shah/Documents/GitHub/conclave2.0/conclave/esp%20firmware/.pio/libdeps/seeed_xiao_esp32s3/ESP_TF/src/tensorflow/lite/micro/micro_allocator.cc)
* **Root Cause**: When any custom operator leaked memory, `ResetTempAllocations()` returned `kTfLiteError`, causing `FinishPrepareNodeAllocations()` to exit early. This left subsequent scratch buffers unassigned (`node_idx = -1`), dereferencing null pointers inside `CommitPlan()`.
* **Fix**:
  1. Modified `FinishPrepareNodeAllocations()` to log a warning on leaks rather than exiting early. This guarantees that all nodes correctly map their scratch buffers.
  2. Added null pointer guards to `CommitPlan()` to gracefully fail instead of crashing if any scratch allocation pointer is missing.

### C. Custom Operator Memory Leaks (Prepare & Invoke Phases)
* **File Modified**: [ModelRunner.cpp](file:///c:/Users/Shlok%20Shah/Documents/GitHub/conclave2.0/conclave/esp%20firmware/src/ModelRunner.cpp)
* **Root Cause**: The custom `TILE` and `REDUCE_PROD` operators used the old compatibility functions (`tflite::GetInput` and `tflite::GetOutput`). In this version of TF Lite Micro, these functions allocate temporary tensor wrappers under the hood that must be manually deallocated. 
  - Skipping deallocation in `TilePrepare` leaked 7 temp buffers on boot.
  - Skipping deallocation in `TileInvoke` and `ReduceProdInvoke` leaked 3 temp buffers *every 500ms* during model execution, resulting in immediate heap exhaustion and bootlooping.
* **Fix**: Converted all four functions (`TilePrepare`, `TileInvoke`, `ReduceProdPrepare`, `ReduceProdInvoke`) to use `tflite::MicroContext` for temporary input/output tensor allocations and called `micro_context->DeallocateTempTfLiteTensor(...)` to cleanly release them before returning.

### D. Null-Pointer Dereference Crash on Tensor Names
* **File Modified**: [ModelRunner.cpp](file:///c:/Users/Shlok%20Shah/Documents/GitHub/conclave2.0/conclave/esp%20firmware/src/ModelRunner.cpp)
* **Root Cause**: Once the memory allocator issues were fixed, `AllocateTensors()` returned successfully and reached the diagnostic print loop. This loop attempted to format the tensor names using `out->name`. Because tensor names are stripped in production flatbuffers to save flash space, `out->name` was `nullptr`, causing a hardware `LoadProhibited` crash when passed to `Serial.printf` with `%s`.
* **Fix**: Added a null-coalescing guard to the print statement: `out->name ? out->name : "none"`.

---

## 2. Current System State & Verification
* **ESP32-S3 Firmware**: Compiles cleanly and flashes successfully over `COM5`.
* **Boot Sequence**: Initializes MPU-6050, sets up Resolver, allocates model tensors successfully (`AllocateTensors() -> kTfLiteOk`), launches FreeRTOS tasks (Sampler, Processing, Heartbeat), and starts BLE advertising.
* **BLE stack**: Active and stable. Custom device name `SafeBand-ESP32` is visible.
* **Mobile App (React Native)**: Connects and receives `FEATURE` and `STATUS` packets. Anomaly scores and 16D motion embeddings update at 2 Hz, showing correctly on the dashboard after a 3-second (6-packet) buffering period in the `MotionEngine`.
