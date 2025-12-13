// Route Tracker - Main tracking logic

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use hudhook::tracing::{info, warn};
use libeldenring::pointers::Pointers;
use windows::Win32::Foundation::HINSTANCE;

use crate::config::Config;
use crate::coordinate_transformer::WorldPositionTransformer;
use crate::custom_pointers::{CustomPointers, EventFlagReader};
use crate::goods_events::GoodsEventsLoader;
use crate::route::{
    save_route_to_file, DeathEvent, FogEvent, ItemEvent, PendingFogEvent, RoutePoint,
};
use crate::websocket::{ConnectionStatus, IncomingMessage, WebSocketClient};
use crate::zone_names::get_zone_name;

/// Animation ID for fog wall traversal
const FOG_WALL_ANIM_ID: u32 = 60060;

// =============================================================================
// ROUTE TRACKER
// =============================================================================

/// Route tracking state
pub struct RouteTracker {
    pub(crate) pointers: Pointers,
    pub(crate) custom_pointers: CustomPointers,
    pub(crate) event_flag_reader: EventFlagReader,
    pub(crate) goods_events: GoodsEventsLoader,
    pub(crate) route: Vec<RoutePoint>,
    pub(crate) deaths: Vec<DeathEvent>,
    pub(crate) fog_traversals: Vec<FogEvent>,
    pub(crate) item_events: Vec<ItemEvent>,
    pub(crate) last_death_count: Option<u32>,
    pub(crate) last_anim: Option<u32>,
    pub(crate) pending_fog: Option<PendingFogEvent>,
    pub(crate) last_flag_states: HashMap<u32, bool>,
    pub(crate) is_recording: bool,
    pub(crate) start_time: Option<Instant>,
    pub(crate) last_record_time: Instant,
    pub(crate) record_interval: Duration,
    pub(crate) show_ui: bool,
    pub(crate) config: Config,
    pub(crate) base_dir: PathBuf,
    pub(crate) status_message: Option<(String, Instant)>,
    pub(crate) transformer: WorldPositionTransformer,
    pub(crate) ws_client: WebSocketClient,
}

impl RouteTracker {
    /// Create a new RouteTracker instance
    pub fn new(hmodule: HINSTANCE) -> Option<Self> {
        info!("Initializing Route Tracker...");

        // Load configuration - REQUIRED (from DLL directory)
        let config = match Config::load(hmodule) {
            Ok(cfg) => cfg,
            Err(e) => {
                hudhook::tracing::error!("Failed to load configuration: {}", e);
                hudhook::tracing::error!(
                    "Please ensure '{}' exists next to the DLL.",
                    Config::CONFIG_FILENAME
                );
                return None;
            }
        };

        info!(
            "Keybindings: Toggle UI={}, Toggle Recording={}, Clear={}, Save={}",
            config.keybindings.toggle_ui.name(),
            config.keybindings.toggle_recording.name(),
            config.keybindings.clear_route.name(),
            config.keybindings.save_route.name()
        );

        // Get the DLL's directory for saving routes
        let base_dir = Config::get_dll_directory(hmodule).unwrap_or_else(|| PathBuf::from("."));

        // Load coordinate transformer CSV
        let csv_path = base_dir.join("WorldMapLegacyConvParam.csv");
        let transformer = match WorldPositionTransformer::from_csv(&csv_path) {
            Ok(t) => {
                info!(
                    "Loaded coordinate transformer: {} maps, {} anchors",
                    t.map_count(),
                    t.anchor_count()
                );
                t
            }
            Err(e) => {
                warn!(
                    "Failed to load coordinate transformer from {:?}: {}. \
                       Using overworld-only mode.",
                    csv_path, e
                );
                // Create empty transformer (will only work for m60_* maps)
                WorldPositionTransformer::from_csv("/dev/null").unwrap_or_else(|_| {
                    // Fallback: create with empty anchors
                    WorldPositionTransformer::empty()
                })
            }
        };

        let pointers = Pointers::new();
        let custom_pointers = CustomPointers::new(&pointers.base_addresses);
        let event_flag_reader = EventFlagReader::new(&pointers.base_addresses);

        // Load goods events data for item tracking
        let goods_events_path = base_dir.join("GoodsEvents.tsv");
        let goods_events = match GoodsEventsLoader::from_tsv(&goods_events_path) {
            Ok(ge) => {
                info!("Loaded {} goods events for tracking", ge.len());
                ge
            }
            Err(e) => {
                warn!(
                    "Failed to load GoodsEvents.tsv from {:?}: {}. \
                       Item tracking disabled.",
                    goods_events_path, e
                );
                GoodsEventsLoader::empty()
            }
        };

        // Wait for the game to be loaded
        let poll_interval = Duration::from_millis(100);
        loop {
            if let Some(menu_timer) = pointers.menu_timer.read() {
                if menu_timer > 0. {
                    break;
                }
            }
            std::thread::sleep(poll_interval);
        }

        info!("Route Tracker initialized!");

        let record_interval = Duration::from_millis(config.recording.record_interval_ms);

        // Read initial death count
        let last_death_count = custom_pointers.read_death_count();

        // Initialize WebSocket client for server integration
        let mut ws_client = WebSocketClient::new(config.server.clone());
        if ws_client.is_enabled() {
            info!(
                "Server integration enabled, connecting to {}...",
                config.server.url
            );
            ws_client.connect();
        } else {
            info!("Server integration disabled (missing url, token, or game_id in config)");
        }

        Some(Self {
            pointers,
            custom_pointers,
            event_flag_reader,
            goods_events,
            route: Vec::new(),
            deaths: Vec::new(),
            fog_traversals: Vec::new(),
            item_events: Vec::new(),
            last_death_count,
            last_anim: None,
            pending_fog: None,
            last_flag_states: HashMap::new(),
            is_recording: false,
            start_time: None,
            last_record_time: Instant::now(),
            record_interval,
            show_ui: true,
            config,
            base_dir,
            status_message: None,
            transformer,
            ws_client,
        })
    }

    /// Start recording
    pub fn start_recording(&mut self) {
        self.route.clear();
        self.deaths.clear();
        self.fog_traversals.clear();
        self.item_events.clear();
        self.pending_fog = None;
        self.last_death_count = self.custom_pointers.read_death_count();
        self.last_anim = self.pointers.cur_anim.read();

        // Snapshot current state of all tracked event flags
        self.last_flag_states.clear();
        for &event_id in self.goods_events.event_ids() {
            if let Some(state) = self.event_flag_reader.read_flag(event_id) {
                self.last_flag_states.insert(event_id, state);
            }
        }
        info!("Snapshotted {} event flags", self.last_flag_states.len());

        self.start_time = Some(Instant::now());
        self.is_recording = true;
        info!("Recording started!");
    }

    /// Stop recording
    pub fn stop_recording(&mut self) {
        self.is_recording = false;
        info!("Recording stopped! {} points recorded.", self.route.len());
    }

    /// Record current position if the interval has elapsed
    pub fn record_position(&mut self) {
        if !self.is_recording {
            return;
        }

        if self.last_record_time.elapsed() < self.record_interval {
            return;
        }

        if let (Some([x, y, z, _, _]), Some(map_id)) = (
            self.pointers.global_position.read(),
            self.pointers.global_position.read_map_id(),
        ) {
            let timestamp_ms = self
                .start_time
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(0);

            // Convert to global coordinates
            let (global_x, global_y, global_z) = self
                .transformer
                .local_to_world_first(map_id, x, y, z)
                .unwrap_or((x, y, z)); // Fallback to local if conversion fails

            let map_id_str = WorldPositionTransformer::format_map_id(map_id);

            // Detect if player is riding Torrent and get debug info
            let torrent_debug = self.custom_pointers.read_torrent_debug();
            let on_torrent = torrent_debug.horse_state.map(|v| v != 0).unwrap_or(false);

            // Detect death: if death_count increased, record death at current position
            let current_death_count = self.custom_pointers.read_death_count();
            if let (Some(current), Some(last)) = (current_death_count, self.last_death_count) {
                if current > last {
                    info!(
                        "Death detected! Recording death at ({}, {}, {})",
                        global_x, global_y, global_z
                    );
                    self.deaths.push(DeathEvent {
                        global_x,
                        global_y,
                        global_z,
                        map_id_str: map_id_str.clone(),
                        timestamp_ms,
                    });
                }
            }
            self.last_death_count = current_death_count;

            // Detect fog wall traversal: track entry and exit positions
            // Note: During fog traversal (especially with mods), game data may become
            // temporarily invalid (position=0,0,0, map_id=0xFFFFFFFF, cur_anim=null).
            // We detect exit when valid data returns after entering fog.
            let current_anim = self.pointers.cur_anim.read();
            let is_fog = current_anim.map(|a| a == FOG_WALL_ANIM_ID).unwrap_or(false);
            let was_fog = self
                .last_anim
                .map(|a| a == FOG_WALL_ANIM_ID)
                .unwrap_or(false);

            // Check if position data is valid (not during loading screen)
            let is_valid_position = map_id != 0xFFFFFFFF && (x != 0.0 || y != 0.0 || z != 0.0);

            if is_fog && !was_fog && is_valid_position {
                // Animation just started - record entry position
                let entry_zone = get_zone_name(map_id);
                info!(
                    "Fog wall entry at ({}, {}, {}) [{}] - {}",
                    global_x, global_y, global_z, map_id_str, entry_zone
                );
                self.pending_fog = Some(PendingFogEvent {
                    entry_x: global_x,
                    entry_y: global_y,
                    entry_z: global_z,
                    entry_map_id_str: map_id_str.clone(),
                    entry_zone_name: entry_zone,
                    entry_timestamp_ms: timestamp_ms,
                });
            } else if self.pending_fog.is_some() && !is_fog && is_valid_position {
                // We had a pending fog entry AND animation is no longer fog AND position is valid
                // This handles both normal exit and fog randomizer (where data goes invalid then valid)
                if let Some(pending) = self.pending_fog.take() {
                    let exit_zone = get_zone_name(map_id);
                    info!(
                        "Fog wall exit at ({}, {}, {}) [{}] - {} → {}",
                        global_x,
                        global_y,
                        global_z,
                        map_id_str,
                        pending.entry_zone_name,
                        exit_zone
                    );

                    // Send discovery to server if connected
                    if self.ws_client.is_connected() {
                        self.ws_client
                            .send_discovery(&pending.entry_zone_name, &exit_zone);
                        info!(
                            "Sent discovery to server: {} → {}",
                            pending.entry_zone_name, exit_zone
                        );
                    }

                    self.fog_traversals.push(FogEvent {
                        entry_x: pending.entry_x,
                        entry_y: pending.entry_y,
                        entry_z: pending.entry_z,
                        entry_map_id_str: pending.entry_map_id_str,
                        entry_zone_name: pending.entry_zone_name,
                        exit_x: global_x,
                        exit_y: global_y,
                        exit_z: global_z,
                        exit_map_id_str: map_id_str.clone(),
                        exit_zone_name: exit_zone,
                        entry_timestamp_ms: pending.entry_timestamp_ms,
                        exit_timestamp_ms: timestamp_ms,
                    });
                }
            }
            self.last_anim = current_anim;

            // Detect item acquisitions via event flag changes
            // Only check a subset of flags each frame to avoid performance issues
            self.check_event_flags(global_x, global_y, global_z, &map_id_str, timestamp_ms);

            self.route.push(RoutePoint {
                x,
                y,
                z,
                global_x,
                global_y,
                global_z,
                map_id,
                map_id_str,
                timestamp_ms,
                on_torrent,
                cur_anim: current_anim,
                torrent_debug,
            });

            self.last_record_time = Instant::now();
        }
    }

    /// Check all tracked event flags for changes and record item events
    fn check_event_flags(
        &mut self,
        global_x: f32,
        global_y: f32,
        global_z: f32,
        map_id_str: &str,
        timestamp_ms: u64,
    ) {
        // Check all tracked event flags
        for &event_id in self.goods_events.event_ids() {
            if let Some(current_state) = self.event_flag_reader.read_flag(event_id) {
                let last_state = self
                    .last_flag_states
                    .get(&event_id)
                    .copied()
                    .unwrap_or(false);

                // Detect flag becoming true (item acquired)
                if current_state && !last_state {
                    if let Some(event_info) = self.goods_events.get(event_id) {
                        info!(
                            "Item acquired: {} (event {}, item {}) at ({}, {}, {})",
                            event_info.name,
                            event_id,
                            event_info.item_id,
                            global_x,
                            global_y,
                            global_z
                        );
                        self.item_events.push(ItemEvent {
                            event_id,
                            item_id: event_info.item_id,
                            item_name: event_info.name.clone(),
                            global_x,
                            global_y,
                            global_z,
                            map_id_str: map_id_str.to_string(),
                            timestamp_ms,
                        });
                    }
                }

                // Update last known state
                self.last_flag_states.insert(event_id, current_state);
            }
        }
    }

    /// Save the recorded route to a JSON file
    pub fn save_route(&self) -> Result<PathBuf, String> {
        let result = save_route_to_file(
            &self.route,
            &self.deaths,
            &self.fog_traversals,
            &self.item_events,
            &self.base_dir,
            &self.config.output.routes_directory,
            self.config.recording.record_interval_ms,
        );

        if let Ok(ref path) = result {
            info!("Route saved to: {}", path.display());
        }

        result
    }

    /// Set a status message that will be displayed temporarily
    pub fn set_status(&mut self, message: String) {
        self.status_message = Some((message, Instant::now()));
    }

    /// Get current status message if still valid (within 3 seconds)
    pub fn get_status(&self) -> Option<&str> {
        self.status_message.as_ref().and_then(|(msg, time)| {
            if time.elapsed() < Duration::from_secs(3) {
                Some(msg.as_str())
            } else {
                None
            }
        })
    }

    /// Returns the player's current position (local and global)
    /// Returns: (local_x, local_y, local_z, global_x, global_y, global_z, map_id)
    pub fn get_current_position(&self) -> Option<(f32, f32, f32, f32, f32, f32, u32)> {
        if let (Some([x, y, z, _, _]), Some(map_id)) = (
            self.pointers.global_position.read(),
            self.pointers.global_position.read_map_id(),
        ) {
            // Convert to global coordinates
            let (gx, gy, gz) = self
                .transformer
                .local_to_world_first(map_id, x, y, z)
                .unwrap_or((x, y, z));

            Some((x, y, z, gx, gy, gz, map_id))
        } else {
            None
        }
    }

    /// Poll the WebSocket client for incoming messages
    pub fn poll_websocket(&mut self) {
        while let Some(msg) = self.ws_client.poll() {
            match msg {
                IncomingMessage::StatusChanged(status) => {
                    info!("WebSocket status: {:?}", status);
                    match status {
                        ConnectionStatus::Connected => {
                            self.set_status("Server connected".to_string());
                        }
                        ConnectionStatus::Error => {
                            if let Some(err) = self.ws_client.last_error() {
                                self.set_status(format!("Server error: {}", err));
                            }
                        }
                        ConnectionStatus::Reconnecting => {
                            self.set_status("Reconnecting to server...".to_string());
                        }
                        _ => {}
                    }
                }
                IncomingMessage::DiscoveryAck { propagated } => {
                    info!(
                        "Discovery acknowledged by server ({} propagated)",
                        propagated.len()
                    );
                }
                IncomingMessage::Error(err) => {
                    warn!("WebSocket error: {}", err);
                }
                IncomingMessage::Ping => {
                    // Auto-handled by poll()
                }
            }
        }
    }

    /// Get the WebSocket connection status
    pub fn ws_status(&self) -> ConnectionStatus {
        self.ws_client.status()
    }

    /// Check if server integration is enabled
    pub fn is_server_enabled(&self) -> bool {
        self.ws_client.is_enabled()
    }
}
