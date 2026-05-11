### Battery Safety Controls

Advanced battery management for GNOME Shell with charging thresholds and TLP profile switching.

---

#### 🌟 Features
*   **Real-time Battery Health:** Monitor charge percentage, battery health (capacity), and temperature directly from the top bar.
*   **Charging Thresholds:** Set custom start and stop charging thresholds to extend battery lifespan.
*   **Pre-defined Modes:**
    *   🛡️ **Conservation Mode:** Sets thresholds to 40-80% (ideal for plugged-in use).
    *   ⚖️ **Balanced Mode:** Sets thresholds to 20-90%.
    *   🔋 **Full Charge Mode:** Standard 0-100% charging.
*   **TLP Profile Switching:** Quick access to custom TLP profiles (`Stream`, `Coding`, `Normal`).
*   **Quick Status:** One-click access to view full `tlp-stat` in a terminal.

#### 🛠 Requirements
*   **GNOME Shell:** 45 or 46
*   **TLP:** The extension interfaces with TLP for threshold management.
*   **upower:** Used for battery data collection.
*   **polkit:** Required for `pkexec` when modifying system-level TLP configurations.

#### 🚀 Installation
1.  Clone the repository into your local extensions folder:
    ```bash
    git clone https://github.com/misterbashyal/battery-safety.git ~/.local/share/gnome-shell/extensions/battery-safety@misterbashyal
    ```
2.  Enable the extension using **Extensions** or **Extension Manager** app.
3.  Log out and log back in (or restart GNOME Shell) to apply changes.

#### 🔧 Configuration
The extension expects a custom TLP profile script at `/usr/local/bin/tlp-profile`. 

Example usage of the profile script:
```bash
tlp-profile coding   # Applies coding thresholds
tlp-profile current  # Returns current thresholds
```

#### 📜 License
This project is licensed under the terms included in the metadata. Developed by [misterbashyal](https://github.com/misterbashyal).
