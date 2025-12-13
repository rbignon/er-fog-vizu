// GoodsEvents.tsv loader - maps event flag IDs to item information
//
// Data format (TSV):
// EventID	ItemID	Name

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

/// Information about an item event
#[derive(Clone, Debug)]
pub struct GoodsEventInfo {
    #[allow(dead_code)]
    pub event_id: u32,
    pub item_id: u32,
    pub name: String,
}

/// Loader and lookup for goods events from TSV file
pub struct GoodsEventsLoader {
    /// Map from event ID to item info
    events: HashMap<u32, GoodsEventInfo>,
    /// Sorted list of all event IDs (for efficient iteration)
    event_ids: Vec<u32>,
}

impl GoodsEventsLoader {
    /// Load goods events from a TSV file
    pub fn from_tsv<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        let file = File::open(path.as_ref())
            .map_err(|e| format!("Failed to open GoodsEvents.tsv: {}", e))?;

        let reader = BufReader::new(file);
        let mut events = HashMap::new();
        let mut event_ids = Vec::new();

        for (line_num, line_result) in reader.lines().enumerate() {
            let line = line_result
                .map_err(|e| format!("Failed to read line {}: {}", line_num + 1, e))?;

            // Skip header line
            if line_num == 0 && line.starts_with("EventID") {
                continue;
            }

            // Skip empty lines
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            // Parse TSV: EventID\tItemID\tName
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 3 {
                continue; // Skip malformed lines
            }

            let event_id: u32 = match parts[0].parse() {
                Ok(id) => id,
                Err(_) => continue, // Skip lines with non-numeric event ID
            };

            let item_id: u32 = match parts[1].parse() {
                Ok(id) => id,
                Err(_) => continue,
            };

            let name = parts[2].to_string();

            // Skip %null% entries
            if name == "%null%" {
                continue;
            }

            events.insert(event_id, GoodsEventInfo {
                event_id,
                item_id,
                name,
            });
            event_ids.push(event_id);
        }

        // Sort event IDs for consistent iteration
        event_ids.sort_unstable();

        Ok(Self { events, event_ids })
    }

    /// Create an empty loader (no events to track)
    pub fn empty() -> Self {
        Self {
            events: HashMap::new(),
            event_ids: Vec::new(),
        }
    }

    /// Get information about an event by its ID
    pub fn get(&self, event_id: u32) -> Option<&GoodsEventInfo> {
        self.events.get(&event_id)
    }

    /// Get all event IDs to monitor
    pub fn event_ids(&self) -> &[u32] {
        &self.event_ids
    }

    /// Get the number of events loaded
    pub fn len(&self) -> usize {
        self.events.len()
    }

    /// Check if the loader is empty
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }
}
