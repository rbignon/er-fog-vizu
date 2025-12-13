# Elden Ring Route Tracker Mod

DLL mod for Elden Ring that tracks player route and detects fog gate traversals.
Integrates with er-fog-vizu for automatic zone discovery visualization.

## Building

**Requirements:**
- Rust toolchain with Windows target
- Windows (or cross-compilation setup)

```bash
# Build release DLL
cargo build --release

# Outputs:
# - target/release/route_tracking.dll (the mod)
# - target/release/route-tracker-injector.exe (standalone injector)
```

## Installation

1. Copy these files next to the DLL:
   - `route_tracker_config.toml` (required)
   - `WorldMapLegacyConvParam.csv` (in src/, required for coordinate conversion)
   - `GoodsEvents.tsv` (optional, for item tracking)

2. Inject the DLL into Elden Ring using the injector or a mod loader.

## Configuration

Edit `route_tracker_config.toml` to configure:
- Hotkeys for UI toggle, recording, etc.
- Recording interval
- Output directory

## Architecture

| File | Purpose |
|------|---------|
| `lib.rs` | DLL entry point, hudhook/ImGui initialization |
| `tracker.rs` | Core tracking: position, fog traversals, deaths, items |
| `ui.rs` | ImGui overlay rendering |
| `config.rs` | TOML config parsing, hotkey handling |
| `route.rs` | Data structures, JSON serialization |
| `coordinate_transformer.rs` | Local tile → global world coordinates |
| `zone_names.rs` | map_id → zone name mapping |
| `custom_pointers.rs` | Memory pointers (death count, Torrent, event flags) |
| `goods_events.rs` | Item tracking via event flags |
| `injector.rs` | Standalone DLL injector |

## Fog Detection

Fog gate traversal is detected via animation ID 60060. The tracker captures:
1. Entry position + map_id when animation starts
2. Exit position + map_id when animation ends
3. Zone names derived from map_ids

## Integration with er-fog-vizu (TODO)

The mod will connect to the er-fog-vizu server via WebSocket to:
- Send discovery events in real-time
- Sync with the web visualization
- Allow viewers to see progress live
