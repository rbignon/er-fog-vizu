// Custom pointer chains for data not exposed by libeldenring
//
// These pointers were reverse-engineered from Cheat Engine tables
// (eldenring_all-in-one_Hexinton-v5.0_ce7.5.ct)
// Event flag structure from EldenRingTool (thanks nord!)

use libeldenring::memedit::PointerChain;
use libeldenring::prelude::base_addresses::{BaseAddresses, Version};
use libeldenring::version::get_version;
use serde::Serialize;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows::Win32::System::Threading::GetCurrentProcess;

/// Debug info for Torrent/riding state - used to identify which values change
#[derive(Debug, Clone, Serialize, Default)]
pub struct TorrentDebugInfo {
    /// RideParam ID (4 bytes at +0x190 +0xE8 +0x20)
    pub ride_param_id: Option<i32>,
    /// IsRidingEnabled (byte at +0x190 +0xE8 +0x31)
    pub is_riding_enabled: Option<u8>,
    /// Riding (byte at +0x190 +0xE8 +0x32)
    pub riding: Option<u8>,
    /// IsItAHorse (byte at +0x190 +0xE8 +0x33)
    pub is_it_a_horse: Option<u8>,
    /// HorseState (4 bytes at +0x190 +0xE8 +0x10 +0x50)
    /// Values: 0=None, 1=AreYouRiding?, 3=IsThereRidingRequest?, 5=Success
    pub horse_state: Option<i32>,
    /// HorseHP (4 bytes at +0x190 +0xE8 +0x12C)
    pub horse_hp: Option<i32>,
    /// IsInsideNoRideArea (byte at +0x190 +0xE8 +0x164)
    pub is_inside_no_ride_area: Option<u8>,
}

/// Custom pointers for route tracking features
pub struct CustomPointers {
    // Ride module pointers (PlayerIns + 0x190 + 0xE8 + offset)
    ride_param_id: PointerChain<i32>,
    is_riding_enabled: PointerChain<u8>,
    riding: PointerChain<u8>,
    is_it_a_horse: PointerChain<u8>,
    horse_state: PointerChain<i32>,
    horse_hp: PointerChain<i32>,
    is_inside_no_ride_area: PointerChain<u8>,
    // Death counter (GameDataMan + 0x94)
    death_count: PointerChain<u32>,
}

impl CustomPointers {
    /// Create custom pointers using base addresses from libeldenring
    pub fn new(base_addresses: &BaseAddresses) -> Self {
        let version = get_version();

        // PlayerIns offset varies by game version
        let player_ins: usize = match version {
            Version::V1_02_0 | Version::V1_02_1 | Version::V1_02_2 | Version::V1_02_3
            | Version::V1_03_0 | Version::V1_03_1 | Version::V1_03_2 | Version::V1_04_0
            | Version::V1_04_1 | Version::V1_05_0 | Version::V1_06_0 => 0x18468,
            _ => 0x1E508, // V1_07_0 and later (including 2.x)
        };

        let world_chr_man = base_addresses.world_chr_man;

        Self {
            // +0x190 +0xE8 +0x20
            ride_param_id: PointerChain::new(&[world_chr_man, player_ins, 0x190, 0xE8, 0x20]),
            // +0x190 +0xE8 +0x31
            is_riding_enabled: PointerChain::new(&[world_chr_man, player_ins, 0x190, 0xE8, 0x31]),
            // +0x190 +0xE8 +0x32
            riding: PointerChain::new(&[world_chr_man, player_ins, 0x190, 0xE8, 0x32]),
            // +0x190 +0xE8 +0x33
            is_it_a_horse: PointerChain::new(&[world_chr_man, player_ins, 0x190, 0xE8, 0x33]),
            // +0x190 +0xE8 +0x10 +0x50
            horse_state: PointerChain::new(&[world_chr_man, player_ins, 0x190, 0xE8, 0x10, 0x50]),
            // +0x190 +0xE8 +0x12C
            horse_hp: PointerChain::new(&[world_chr_man, player_ins, 0x190, 0xE8, 0x12C]),
            // +0x190 +0xE8 +0x164
            is_inside_no_ride_area: PointerChain::new(&[world_chr_man, player_ins, 0x190, 0xE8, 0x164]),
            // GameDataMan + 0x94
            death_count: PointerChain::new(&[base_addresses.game_data_man, 0x94]),
        }
    }

    /// Read all Torrent-related debug values
    pub fn read_torrent_debug(&self) -> TorrentDebugInfo {
        TorrentDebugInfo {
            ride_param_id: self.ride_param_id.read(),
            is_riding_enabled: self.is_riding_enabled.read(),
            riding: self.riding.read(),
            is_it_a_horse: self.is_it_a_horse.read(),
            horse_state: self.horse_state.read(),
            horse_hp: self.horse_hp.read(),
            is_inside_no_ride_area: self.is_inside_no_ride_area.read(),
        }
    }

    /// Returns true if the player is currently riding Torrent
    /// Uses "HorseState" - returns true if value != 0
    #[allow(dead_code)]
    pub fn is_on_torrent(&self) -> bool {
        self.horse_state.read().map(|v| v != 0).unwrap_or(false)
    }

    /// Read the current death count
    pub fn read_death_count(&self) -> Option<u32> {
        self.death_count.read()
    }
}

// =============================================================================
// EVENT FLAG READER
// =============================================================================

/// Offsets within CSFD4VirtualMemoryFlag structure
#[repr(usize)]
enum VirtualMemoryFlagOffset {
    EventFlagDivisor = 0x1C,
    FlagHolderEntrySize = 0x20,
    FlagHolder = 0x28,
    FlagGroupRootNode = 0x38,
}

/// Offsets within EventFlagGroupNode structure (tree node)
#[repr(usize)]
enum FlagGroupNodeOffset {
    Left = 0x0,
    Parent = 0x8,
    Right = 0x10,
    IsLeaf = 0x19,
    Group = 0x20,
    LocationMode = 0x28,
    Location = 0x30,
}

/// Reader for game event flags using the CSEventFlagMan structure
pub struct EventFlagReader {
    proc: HANDLE,
    csfd4_virtual_memory_flag: usize,
}

impl EventFlagReader {
    /// Create a new EventFlagReader
    pub fn new(base_addresses: &BaseAddresses) -> Self {
        Self {
            proc: unsafe { GetCurrentProcess() },
            csfd4_virtual_memory_flag: base_addresses.csfd4_virtual_memory_flag,
        }
    }

    /// Read a u8 from the given address
    fn read_u8(&self, addr: usize) -> Option<u8> {
        let mut value: u8 = 0;
        unsafe {
            ReadProcessMemory(
                self.proc,
                addr as _,
                &mut value as *mut _ as _,
                std::mem::size_of::<u8>(),
                None,
            )
            .ok()
            .map(|_| value)
        }
    }

    /// Read a u32 from the given address
    #[allow(dead_code)]
    fn read_u32(&self, addr: usize) -> Option<u32> {
        let mut value: u32 = 0;
        unsafe {
            ReadProcessMemory(
                self.proc,
                addr as _,
                &mut value as *mut _ as _,
                std::mem::size_of::<u32>(),
                None,
            )
            .ok()
            .map(|_| value)
        }
    }

    /// Read a i32 from the given address
    fn read_i32(&self, addr: usize) -> Option<i32> {
        let mut value: i32 = 0;
        unsafe {
            ReadProcessMemory(
                self.proc,
                addr as _,
                &mut value as *mut _ as _,
                std::mem::size_of::<i32>(),
                None,
            )
            .ok()
            .map(|_| value)
        }
    }

    /// Read a u64 (pointer) from the given address
    fn read_u64(&self, addr: usize) -> Option<u64> {
        let mut value: u64 = 0;
        unsafe {
            ReadProcessMemory(
                self.proc,
                addr as _,
                &mut value as *mut _ as _,
                std::mem::size_of::<u64>(),
                None,
            )
            .ok()
            .map(|_| value)
        }
    }

    /// Read a pointer (following the chain from base address)
    fn read_ptr(&self, addr: usize) -> Option<usize> {
        self.read_u64(addr).map(|v| v as usize)
    }

    /// Navigate the event flag tree to find the memory location and bit for a flag
    /// Returns (address, bit_offset) or None if not found
    fn get_flag_location(&self, flag_id: u32) -> Option<(usize, u32)> {
        // Read the base event flag manager pointer
        let evt_flag_man = self.read_ptr(self.csfd4_virtual_memory_flag)?;
        if evt_flag_man == 0 {
            return None;
        }

        // Read divisor (should be 1000)
        let divisor = self.read_i32(evt_flag_man + VirtualMemoryFlagOffset::EventFlagDivisor as usize)?;
        if divisor == 0 {
            return None;
        }

        // Read entry size (usually ~125)
        let entry_size = self.read_i32(evt_flag_man + VirtualMemoryFlagOffset::FlagHolderEntrySize as usize)?;
        if entry_size == 0 {
            return None;
        }

        // Calculate group number and bit offset within group
        let group_num = flag_id as i32 / divisor;
        let bit_num_full = flag_id % divisor as u32;

        // Get the tree root node
        let root = self.read_ptr(evt_flag_man + VirtualMemoryFlagOffset::FlagGroupRootNode as usize)?;
        if root == 0 {
            return None;
        }

        // Start from root's parent (this is how the tree is structured)
        let parent = self.read_ptr(root + FlagGroupNodeOffset::Parent as usize)?;
        let mut current = parent;
        let mut is_leaf = self.read_u8(current + FlagGroupNodeOffset::IsLeaf as usize)? != 0;
        let mut found = root;

        // Walk the tree to find the correct group
        let mut walk_count = 0;
        while !is_leaf {
            walk_count += 1;
            if walk_count > 1000 {
                return None; // Prevent infinite loops
            }

            let current_group = self.read_i32(current + FlagGroupNodeOffset::Group as usize)?;
            let next = if current_group < group_num {
                self.read_ptr(current + FlagGroupNodeOffset::Right as usize)?
            } else {
                self.read_ptr(current + FlagGroupNodeOffset::Left as usize)?
            };

            if next == 0 {
                return None;
            }

            found = current;
            current = next;
            is_leaf = self.read_u8(next + FlagGroupNodeOffset::IsLeaf as usize)? != 0;
        }

        // Check if we found a valid node
        let found_group = self.read_i32(found + FlagGroupNodeOffset::Group as usize)?;
        if found == root || group_num < found_group {
            return None;
        }

        // Get the location mode and calculate the actual address
        let loc_mode = self.read_i32(found + FlagGroupNodeOffset::LocationMode as usize)?;

        let ptr = match loc_mode {
            2 => {
                // Direct pointer mode
                self.read_ptr(found + FlagGroupNodeOffset::Location as usize)?
            }
            1 => {
                // Flag holder index mode
                let flag_holder = self.read_ptr(evt_flag_man + VirtualMemoryFlagOffset::FlagHolder as usize)?;
                let loc = self.read_i32(found + FlagGroupNodeOffset::Location as usize)?;
                let loc_offset = loc as usize * entry_size as usize;
                flag_holder + loc_offset
            }
            _ => return None, // Unknown location mode
        };

        Some((ptr, bit_num_full))
    }

    /// Read the value of an event flag
    /// Returns Some(true) if flag is set, Some(false) if not set, None if read failed
    pub fn read_flag(&self, flag_id: u32) -> Option<bool> {
        let (ptr, bit_num_full) = self.get_flag_location(flag_id)?;

        let byte_num = bit_num_full / 8;
        let bit_num = 7 - (bit_num_full % 8); // Big-endian bit order
        let flag_mask = 1u8 << bit_num;

        let flag_byte = self.read_u8(ptr + byte_num as usize)?;
        Some((flag_byte & flag_mask) == flag_mask)
    }

    /// Check if the event flag system is ready (game loaded)
    #[allow(dead_code)]
    pub fn is_ready(&self) -> bool {
        // Try to read a known flag (flag 2200 is used as a loading indicator)
        self.get_flag_location(2200).is_some()
    }
}
