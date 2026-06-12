with open(r"c:\Users\LENOVO\OneDrive\Documents\esp_firmware\esp firmware\mobile_app\App.js", "r") as f:
    lines = f.readlines()

for idx in range(660, 728):
    if idx < len(lines):
        print(f"{idx+1}: {lines[idx].strip()}")
