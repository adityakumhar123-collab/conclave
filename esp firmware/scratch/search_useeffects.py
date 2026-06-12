import os

md_path = r"c:\Users\LENOVO\Downloads\data\model_and_firmware.md"

with open(md_path, "r", encoding="utf-8") as f:
    content = f.read()

lines = content.splitlines()
for idx, line in enumerate(lines):
    if any(w in line.lower() for w in ["still", "variance", "impact", "threshold"]):
        print(f"Line {idx+1}: {line.strip()}")
