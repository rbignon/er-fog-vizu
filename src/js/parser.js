// ============================================================
// PARSER - Converts spoiler log text to graph data
// ============================================================

export const SpoilerLogParser = {
    // Patterns that ALWAYS indicate a one-way connection
    alwaysOneWayPatterns: [
        /sending gate/i,
        /abducted/i,
        /dying/i,
        /burning the Sealing Tree/i,
        /using the Pureblood/i,
        /Hole-Laden Necklace/i,
        /return to entrance/i,
        /O Mother/i,
        /resting in the coffin/i,
        /using the coffin/i,
        /lying down/i,
        /warp to/i,
        /warp after/i,
    ],

    // "arriving at/in/from" is only one-way if the SOURCE contains a teleport mechanism
    // These patterns are checked in the source part when "arriving" is found in target
    teleportSourcePatterns: [
        /sending gate/i,
        /abducted/i,
        /coffin/i,
        /Pureblood/i,
        /Hole-Laden/i,
        /burning/i,
        /warp/i,
        /Horned Remains/i,
        /lying down/i,
    ],

    // Patterns to skip (metadata lines)
    skipPatterns: [
        /^Options and seed:/,
        /^Key item hash:/,
        /^Mod directories/,
        /^Connecting/,
        /^Main fixup/,
        /^Areas before/,
        /^Other areas/,
        /^This spoiler/,
        /^For each area/,
        /^Paired warps/,
        /^How to get/,
        /^- Find/,
        /^- The first/,
        /^- Repeat/,
        /^If you're stuck/,
        /^you haven't/,
        /^>>>/,
        /^Optional areas:/,
        /^Finished/,
        /^Writing/,
        /^\$ /,
        /^\d+ entrances/,
        /^Done$/,
        /^C:\\/,
    ],
    
    // Patterns that indicate details in connection descriptions
    detailPatterns: [
        /\s*\(before\s/i,
        /\s*\(after\s/i,
        /\s*\(at\s/i,
        /\s*\(using\s/i,
        /\s*\(in\s/i,
        /\s*\(the\s/i,
        /\s*\(on\s/i,
        /\s*\(arriving\s/i,
        /\s*\(opening\s/i,
        /\s*\(dropping\s/i,
        /\s*\(with\s/i,
        /\s*\(accessing\s/i,
        /\s*\(defeating\s/i,
        /\s*\(completing\s/i,
        /\s*\(riding\s/i,
        /\s*\(jumping\s/i,
        /\s*\(resting\s/i,
        /\s*\(touching\s/i,
        /\s*\(lying\s/i,
        /\s*\(burning\s/i,
        /\s*\(getting\s/i,
        /\s*\(touching\s/i,
        /\s*\(traversing\s/i,
        /\s*\(going\s/i,
        /\s*\(return\s/i,
        /\s*\(unlocking\s/i,
        /\s*\(instead\s/i,
        /\s*\(warp\s/i,
        /\s*\(outside\s/i,
        /\s*\(behind\s/i,
        /\s*\(past\s/i,
        /\s*\(up\s/i,
        /\s*\(down\s/i,
        /\s*\(backwards\s/i,
    ],
    
    shouldSkipLine(line) {
        const trimmed = line.trim();
        if (!trimmed) return true;
        return this.skipPatterns.some(pattern => pattern.test(trimmed));
    },
    
    parseAreaLine(line) {
        // Area lines are not indented
        if (line.startsWith('  ') || line.startsWith('\t')) return null;
        if (this.shouldSkipLine(line)) return null;
        
        const isBoss = line.includes('<<<<<');
        let lineClean = line.replace(/<<<<</, '').trim();
        
        // Extract scaling info
        const scalingMatch = lineClean.match(/\(scaling:\s*([^)]+)\)/);
        const scaling = scalingMatch ? scalingMatch[1].trim() : null;
        
        // Extract area name (everything before the parenthesis)
        const nameMatch = lineClean.match(/^([^(]+)/);
        if (nameMatch) {
            const name = nameMatch[1].trim();
            if (name) {
                return { name, isBoss, scaling };
            }
        }
        return null;
    },
    
    extractAreaAndDetails(text) {
        for (const pattern of this.detailPatterns) {
            const match = text.match(pattern);
            if (match) {
                const areaName = text.substring(0, match.index).trim();
                // Extract details in parentheses
                const detailsMatch = text.substring(match.index).match(/\(([^)]+)\)/);
                const details = detailsMatch ? detailsMatch[1] : '';
                return { areaName, details };
            }
        }
        return { areaName: text.trim(), details: '' };
    },
    
    parseConnectionLine(line) {
        const trimmed = line.trim();
        let connType, content;
        
        if (trimmed.startsWith('Random:')) {
            connType = 'random';
            content = trimmed.substring(7).trim();
        } else if (trimmed.startsWith('Preexisting:')) {
            connType = 'preexisting';
            content = trimmed.substring(12).trim();
        } else {
            return null;
        }
        
        if (!content.includes(' --> ')) return null;
        
        const parts = content.split(' --> ');
        if (parts.length !== 2) return null;
        
        const [sourcePart, targetPart] = parts;
        
        const { areaName: source, details: sourceDetails } = this.extractAreaAndDetails(sourcePart);
        const { areaName: target, details: targetDetails } = this.extractAreaAndDetails(targetPart);
        
        // Extract "using an item from..." before cleaning
        let requiredItemFrom = null;
        const usingMatch = content.match(/,\s*using an item from\s+(.+?)$/i);
        if (usingMatch) {
            requiredItemFrom = usingMatch[1].trim();
        }
        
        // Clean up "using an item from..."
        const cleanSource = source.split(', using')[0].trim();
        const cleanTarget = target.split(', using')[0].trim();

        // Detect if this is a one-way connection based on description patterns
        // For Random links, check if any one-way pattern matches
        let isInherentlyOneWay = false;
        if (connType === 'random') {
            // Check patterns that always indicate one-way
            if (this.alwaysOneWayPatterns.some(pattern => pattern.test(content))) {
                isInherentlyOneWay = true;
            }
            // Check "arriving" - only one-way if source contains teleport mechanism
            else if (/arriving (at|in|from)/i.test(content)) {
                // Check if source part contains a teleport mechanism
                isInherentlyOneWay = this.teleportSourcePatterns.some(pattern => pattern.test(sourcePart));
            }
        }

        return {
            source: cleanSource,
            target: cleanTarget,
            type: connType,
            sourceDetails,
            targetDetails,
            requiredItemFrom,
            isInherentlyOneWay
        };
    },
    
    parse(text) {
        const lines = text.split('\n');
        const areas = new Map();
        const connections = [];
        let areaOrder = 0;
        let inOptionalSection = false;
        let metadata = {};
        
        // Extract seed from first line
        const firstLine = lines[0] || '';
        const seedMatch = firstLine.match(/seed:(\d+)/);
        if (seedMatch) {
            metadata.seed = seedMatch[1];
        }
        metadata.options = firstLine.trim();
        
        for (const line of lines) {
            // Stop at optional areas section
            if (line.trim() === 'Optional areas:') {
                inOptionalSection = true;
                break;
            }
            
            // Try to parse as area
            const areaInfo = this.parseAreaLine(line);
            if (areaInfo) {
                if (!areas.has(areaInfo.name)) {
                    areas.set(areaInfo.name, {
                        id: areaInfo.name,
                        isBoss: areaInfo.isBoss,
                        scaling: areaInfo.scaling,
                        order: areaOrder++
                    });
                } else {
                    // Update existing area with boss/scaling info if we have it
                    // (area may have been created earlier from a connection line)
                    const existing = areas.get(areaInfo.name);
                    if (areaInfo.isBoss) existing.isBoss = true;
                    if (areaInfo.scaling) existing.scaling = areaInfo.scaling;
                }
                continue;
            }
            
            // Try to parse as connection
            if (line.startsWith('  ') || line.startsWith('\t')) {
                const conn = this.parseConnectionLine(line);
                if (conn) {
                    // Ensure areas exist
                    if (!areas.has(conn.source)) {
                        areas.set(conn.source, {
                            id: conn.source,
                            isBoss: false,
                            scaling: null,
                            order: areaOrder++
                        });
                    }
                    if (!areas.has(conn.target)) {
                        areas.set(conn.target, {
                            id: conn.target,
                            isBoss: false,
                            scaling: null,
                            order: areaOrder++
                        });
                    }
                    connections.push(conn);
                }
            }
        }
        
        return {
            nodes: Array.from(areas.values()),
            links: connections,
            metadata
        };
    }
};

// ============================================================
// ITEM LOG PARSER
// ============================================================

export const ItemLogParser = {
    parse(text) {
        const lines = text.split('\n');
        const keyItems = new Map(); // zone -> [item names]
        let inKeyItemsSection = false;
        let metadata = {};
        
        // Extract seed from first line
        const firstLine = lines[0] || '';
        const seedMatch = firstLine.match(/seed:(\d+)/);
        if (seedMatch) {
            metadata.seed = seedMatch[1];
        }
        
        for (const line of lines) {
            const trimmed = line.trim();
            
            // Start of key items section
            if (trimmed === '-- Hints for key items:') {
                inKeyItemsSection = true;
                continue;
            }
            
            // End of key items section (next section starts)
            if (inKeyItemsSection && trimmed.startsWith('-- Hints for ')) {
                inKeyItemsSection = false;
                continue;
            }
            
            // Parse key item hint: "Item Name: In Zone"
            if (inKeyItemsSection && trimmed.includes(': In ')) {
                const colonIndex = trimmed.indexOf(': In ');
                if (colonIndex > 0) {
                    const itemName = trimmed.substring(0, colonIndex).trim();
                    const zone = trimmed.substring(colonIndex + 5).trim();
                    
                    if (!keyItems.has(zone)) {
                        keyItems.set(zone, []);
                    }
                    keyItems.get(zone).push(itemName);
                }
            }
        }
        
        return {
            keyItems, // Map: zone -> [item names]
            metadata
        };
    },
    
    // Find key items for a given area (with fuzzy matching)
    findKeyItemsForArea(keyItems, areaName) {
        // Exact match only - no partial matching to avoid false positives
        // (e.g., "Leyndell" matching "Ashen Leyndell - Before Divine Tower")
        if (keyItems.has(areaName)) {
            return keyItems.get(areaName);
        }
        return [];
    },
    
    // Find which key item is in a given zone (for required items)
    findKeyItemInZone(keyItems, zoneName) {
        // Exact match only - no fuzzy matching to avoid false positives
        if (keyItems.has(zoneName)) {
            return keyItems.get(zoneName);
        }
        return [];
    }
};
