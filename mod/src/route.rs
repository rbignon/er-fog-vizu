// Route data structures and serialization

use serde::Serialize;
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;
use std::time::SystemTime;

use crate::custom_pointers::TorrentDebugInfo;

// =============================================================================
// DATA STRUCTURES
// =============================================================================

/// Route point with timestamp (serializable)
#[derive(Clone, Debug, Serialize)]
pub struct RoutePoint {
    /// Local X coordinate (within tile)
    pub x: f32,
    /// Local Y coordinate (altitude)
    pub y: f32,
    /// Local Z coordinate (within tile)
    pub z: f32,
    /// Global X coordinate (world space)
    pub global_x: f32,
    /// Global Y coordinate (altitude, same as y)
    pub global_y: f32,
    /// Global Z coordinate (world space)
    pub global_z: f32,
    /// Map tile ID (packed as 0xWWXXYYDD)
    pub map_id: u32,
    /// Map ID as human-readable string
    pub map_id_str: String,
    /// Timestamp in milliseconds from start of recording
    pub timestamp_ms: u64,
    /// Whether the player is riding Torrent
    pub on_torrent: bool,
    /// Current animation ID (useful for identifying fog wall animations)
    pub cur_anim: Option<u32>,
    /// Debug info for Torrent/riding state (to identify which values change)
    pub torrent_debug: TorrentDebugInfo,
}

/// Death event with position
#[derive(Clone, Debug, Serialize)]
pub struct DeathEvent {
    /// Global X coordinate where death occurred
    pub global_x: f32,
    /// Global Y coordinate (altitude)
    pub global_y: f32,
    /// Global Z coordinate
    pub global_z: f32,
    /// Map ID as string
    pub map_id_str: String,
    /// Timestamp in milliseconds from start of recording
    pub timestamp_ms: u64,
}

/// Fog wall traversal event with entry and exit positions
#[derive(Clone, Debug, Serialize)]
pub struct FogEvent {
    /// Entry position - Global X coordinate before entering fog
    pub entry_x: f32,
    /// Entry position - Global Y coordinate (altitude)
    pub entry_y: f32,
    /// Entry position - Global Z coordinate
    pub entry_z: f32,
    /// Entry position - Map ID as string
    pub entry_map_id_str: String,
    /// Entry position - Zone name (human-readable)
    pub entry_zone_name: String,
    /// Exit position - Global X coordinate after exiting fog
    pub exit_x: f32,
    /// Exit position - Global Y coordinate (altitude)
    pub exit_y: f32,
    /// Exit position - Global Z coordinate
    pub exit_z: f32,
    /// Exit position - Map ID as string
    pub exit_map_id_str: String,
    /// Exit position - Zone name (human-readable)
    pub exit_zone_name: String,
    /// Timestamp when entering fog (milliseconds from start of recording)
    pub entry_timestamp_ms: u64,
    /// Timestamp when exiting fog (milliseconds from start of recording)
    pub exit_timestamp_ms: u64,
}

/// Pending fog event (entry recorded, waiting for exit)
#[derive(Clone, Debug)]
pub struct PendingFogEvent {
    pub entry_x: f32,
    pub entry_y: f32,
    pub entry_z: f32,
    pub entry_map_id_str: String,
    pub entry_zone_name: String,
    pub entry_timestamp_ms: u64,
}

/// Item/event acquisition event
#[derive(Clone, Debug, Serialize)]
pub struct ItemEvent {
    /// Event flag ID that triggered
    pub event_id: u32,
    /// Item ID associated with this event (from GoodsEvents.tsv)
    pub item_id: u32,
    /// Item name (from GoodsEvents.tsv)
    pub item_name: String,
    /// Global X coordinate where item was acquired
    pub global_x: f32,
    /// Global Y coordinate (altitude)
    pub global_y: f32,
    /// Global Z coordinate
    pub global_z: f32,
    /// Map ID as string
    pub map_id_str: String,
    /// Timestamp in milliseconds from start of recording
    pub timestamp_ms: u64,
}

/// Saved route file structure
#[derive(Debug, Serialize)]
pub struct SavedRoute {
    /// Route name/description
    pub name: String,
    /// Recording date (ISO 8601)
    pub recorded_at: String,
    /// Total duration in seconds
    pub duration_secs: f64,
    /// Recording interval in milliseconds
    pub interval_ms: u64,
    /// Number of points
    pub point_count: usize,
    /// The route points
    pub points: Vec<RoutePoint>,
    /// Death events during the recording
    pub deaths: Vec<DeathEvent>,
    /// Fog wall traversal events
    pub fog_traversals: Vec<FogEvent>,
    /// Item acquisition events
    pub item_events: Vec<ItemEvent>,
}

// =============================================================================
// HELPERS
// =============================================================================

/// Simple timestamp generator (without chrono dependency)
pub fn generate_timestamp() -> String {
    let duration = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    
    // Convert to date/time components (approximate, but good enough for filenames)
    let days = secs / 86400;
    let years = 1970 + days / 365;
    let remaining_days = days % 365;
    let months = remaining_days / 30 + 1;
    let day = remaining_days % 30 + 1;
    let hours = (secs % 86400) / 3600;
    let minutes = (secs % 3600) / 60;
    let seconds = secs % 60;
    
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", 
            years, months, day, hours, minutes, seconds)
}

// =============================================================================
// ROUTE SAVING
// =============================================================================

/// Save a route to a JSON file
pub fn save_route_to_file(
    route: &[RoutePoint],
    deaths: &[DeathEvent],
    fog_traversals: &[FogEvent],
    item_events: &[ItemEvent],
    base_dir: &PathBuf,
    routes_directory: &str,
    interval_ms: u64,
) -> Result<PathBuf, String> {
    if route.is_empty() {
        return Err("No route data to save".to_string());
    }

    // Create routes directory
    let routes_dir = base_dir.join(routes_directory);
    if !routes_dir.exists() {
        fs::create_dir_all(&routes_dir)
            .map_err(|e| format!("Failed to create routes directory: {}", e))?;
    }

    // Generate filename with timestamp
    let now = generate_timestamp();
    let filename = format!("route_{}.json", now.replace(":", "-").replace(" ", "_"));
    let filepath = routes_dir.join(&filename);

    // Calculate total duration
    let duration_secs = route.last()
        .map(|p| p.timestamp_ms as f64 / 1000.0)
        .unwrap_or(0.0);

    // Create saved route structure
    let saved_route = SavedRoute {
        name: format!("Route {}", now),
        recorded_at: now,
        duration_secs,
        interval_ms,
        point_count: route.len(),
        points: route.to_vec(),
        deaths: deaths.to_vec(),
        fog_traversals: fog_traversals.to_vec(),
        item_events: item_events.to_vec(),
    };

    // Serialize to JSON
    let json = serde_json::to_string_pretty(&saved_route)
        .map_err(|e| format!("Failed to serialize route: {}", e))?;

    // Write to file
    let mut file = File::create(&filepath)
        .map_err(|e| format!("Failed to create file: {}", e))?;
    file.write_all(json.as_bytes())
        .map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(filepath)
}



