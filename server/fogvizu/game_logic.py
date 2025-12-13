"""
Game logic: discovery propagation through preexisting links.
"""

from collections import defaultdict
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from fogvizu.database import Game

# Starting node (always discovered)
START_NODE = "Chapel of Anticipation"


def is_one_way(link: dict, all_links: list[dict]) -> bool:
    """A link is one-way if no reverse link exists."""
    return not any(
        other["source"] == link["destination"] and other["destination"] == link["source"]
        for other in all_links
    )


def build_preexisting_adjacency(
    zone_pairs: list[dict],
) -> dict[str, list[tuple[str, bool]]]:
    """
    Build adjacency list for preexisting links only.
    Returns dict[source] -> list of (destination, is_bidirectional)
    """
    adj: dict[str, list[tuple[str, bool]]] = defaultdict(list)

    for pair in zone_pairs:
        if pair["type"] == "preexisting":
            is_bidir = not is_one_way(pair, zone_pairs)
            adj[pair["source"]].append((pair["destination"], is_bidir))
            if is_bidir:
                adj[pair["destination"]].append((pair["source"], True))

    return adj


def get_discovered_nodes(discovered_links: list[dict]) -> set[str]:
    """
    Get all discovered nodes from discovered links.
    A node is discovered if it's the source or target of any discovered link,
    or is START_NODE.
    """
    discovered = {START_NODE}

    for link in discovered_links:
        discovered.add(link["source"])
        discovered.add(link["target"])

    return discovered


def link_exists(discovered_links: list[dict], source: str, target: str) -> bool:
    """Check if a link already exists in discovered_links."""
    return any(dl["source"] == source and dl["target"] == target for dl in discovered_links)


async def propagate_discovery(
    db: AsyncSession,
    game_id: UUID,
    source: str,
    target: str,
    discovered_by: str = "mod",
) -> list[dict[str, str]]:
    """
    Propagate a discovery through preexisting links.
    Returns all newly discovered links (including the initial one).

    Logic:
    1. Record the initial link as discovered
    2. If target was not previously discovered, find all preexisting links
       from target to already-discovered nodes and record them
    3. Recursively propagate through newly reachable preexisting links
    """
    # Get game data
    result = await db.execute(select(Game).where(Game.id == game_id))
    game = result.scalar_one_or_none()
    if not game:
        return []

    zone_pairs = game.zone_pairs
    preexisting_adj = build_preexisting_adjacency(zone_pairs)

    # Get current discovered links (make a mutable copy)
    discovered_links: list[dict] = list(game.discovered_links) if game.discovered_links else []

    # Get current discovered nodes
    discovered_nodes = get_discovered_nodes(discovered_links)

    # Track newly discovered links
    newly_discovered: list[dict[str, str]] = []
    now = datetime.now(UTC).isoformat()

    # BFS through preexisting links
    queue: list[tuple[str, str]] = [(source, target)]
    visited: set[tuple[str, str]] = set()

    while queue:
        src, dst = queue.pop(0)
        link_key = (src, dst)

        if link_key in visited:
            continue
        visited.add(link_key)

        # Record this link as discovered (if not already)
        if not link_exists(discovered_links, src, dst):
            new_link = {
                "source": src,
                "target": dst,
                "discovered_at": now,
                "discovered_by": discovered_by,
            }
            discovered_links.append(new_link)
            newly_discovered.append({"source": src, "target": dst})

        # If target was not previously discovered, propagate through preexisting
        if dst not in discovered_nodes:
            discovered_nodes.add(dst)

            # Find preexisting links from dst to already-discovered nodes
            for next_dst, _is_bidir in preexisting_adj.get(dst, []):
                if next_dst in discovered_nodes:
                    # Preexisting link to already-discovered node
                    queue.append((dst, next_dst))

    # Update game with new discovered_links
    if newly_discovered:
        game.discovered_links = discovered_links
        await db.flush()

    return newly_discovered


def compute_total_zones(zone_pairs: list[dict]) -> int:
    """Compute total unique zones from zone pairs."""
    zones = set()
    for pair in zone_pairs:
        zones.add(pair["source"])
        zones.add(pair["destination"])
    return len(zones)
