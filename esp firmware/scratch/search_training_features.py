import json
import os

t_path = r"C:\Users\LENOVO\.gemini\antigravity-ide\brain\814cf7a4-b7b1-4f82-ac32-01c68b7fa656\.system_generated\logs\transcript.jsonl"
line_num = 220

print("Reading line 220...")
with open(t_path, "r", encoding="utf-8") as f:
    for idx, line in enumerate(f, 1):
        if idx == line_num:
            data = json.loads(line)
            content = data.get("content", "")
            print(f"Total length: {len(content)}")
            # print in chunks of 2000 chars
            for i in range(0, len(content), 2000):
                print(f"--- Chunk {i} to {i+2000} ---")
                print(content[i:i+2000])
            break
