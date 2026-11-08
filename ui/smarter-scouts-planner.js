/**
 * smarter-scouts-planner.js
 *
 * Pure map-analysis helpers for the Smarter Scouts mod. Finds "frontier"
 * plots (revealed, walkable land plots that border unexplored hidden plots)
 * and ranks them for an auto-exploring scout. No imports; relies only on
 * engine globals (GameplayMap, DirectionTypes, RevealedStates).
 * Does not call any path API: the caller verifies reachability.
 * No try/catch and no console output: the caller handles errors.
 */

let cachedDirections = null;

/**
 * Lazily build and cache the six hex directions (DirectionTypes may not
 * exist at import time).
 * @returns {number[]} The six DirectionTypes.DIRECTION_* values.
 */
export function getHexDirections() {
	if (!cachedDirections) {
		cachedDirections = [
			DirectionTypes.DIRECTION_NORTHEAST,
			DirectionTypes.DIRECTION_EAST,
			DirectionTypes.DIRECTION_SOUTHEAST,
			DirectionTypes.DIRECTION_SOUTHWEST,
			DirectionTypes.DIRECTION_WEST,
			DirectionTypes.DIRECTION_NORTHWEST,
		];
	}
	return cachedDirections;
}

/**
 * Valid neighboring plot locations of a plot.
 * @param {{x:number,y:number}} loc
 * @returns {{x:number,y:number}[]} 0-6 on-map neighbors.
 */
export function neighborLocations(loc) {
	const dirs = getHexDirections();
	const result = [];
	for (let d = 0; d < dirs.length; d++) {
		const n = GameplayMap.getAdjacentPlotLocation(loc, dirs[d]);
		if (n && GameplayMap.isValidLocation(n)) {
			result.push({ x: n.x, y: n.y });
		}
	}
	return result;
}

/**
 * Count neighbors of a plot that are still hidden.
 * @param {{x:number,y:number}} loc
 * @param {ArrayLike<number>} revealedStates Flat array indexed by plot index.
 * @returns {number}
 */
export function countHiddenNeighbors(loc, revealedStates) {
	const neighbors = neighborLocations(loc);
	let count = 0;
	for (let i = 0; i < neighbors.length; i++) {
		const idx = GameplayMap.getIndexFromXY(neighbors[i].x, neighbors[i].y);
		if (revealedStates[idx] === RevealedStates.HIDDEN) {
			count++;
		}
	}
	return count;
}

/**
 * Whether loc is within `radius` (inclusive) of any location in locs.
 * @param {{x:number,y:number}} loc
 * @param {{x:number,y:number}[]} locs
 * @param {number} radius
 * @returns {boolean}
 */
export function isWithinRadiusOfAny(loc, locs, radius) {
	if (!locs) {
		return false;
	}
	for (let i = 0; i < locs.length; i++) {
		if (GameplayMap.getPlotDistance(loc.x, loc.y, locs[i].x, locs[i].y) <= radius) {
			return true;
		}
	}
	return false;
}

/**
 * Find and rank frontier plots for a scout.
 * @param {Object} opts
 * @param {ArrayLike<number>} opts.revealedStates Flat revealed-state array.
 * @param {{x:number,y:number}} opts.scoutLoc Scout's current location.
 * @param {number} opts.areaId Landmass id candidates must belong to.
 * @param {{x:number,y:number}[]} [opts.threatLocs] Dangerous locations to avoid.
 * @param {number} [opts.dangerRadius] Avoid plots within dangerRadius + 1 of a threat.
 * @param {number} [opts.maxCandidates=8] Max results.
 * @param {Set<number>} [opts.visited] Plot indices recently abandoned/unreachable.
 * @returns {{index:number,x:number,y:number,hidden:number,dist:number,score:number}[]}
 *   Best-first.
 */
export function findFrontier(opts) {
	const revealedStates = opts.revealedStates;
	const scoutLoc = opts.scoutLoc;
	const areaId = opts.areaId;
	const threatLocs = opts.threatLocs || [];
	const dangerRadius = opts.dangerRadius || 0;
	const maxCandidates = opts.maxCandidates > 0 ? opts.maxCandidates : 8;
	const visited = opts.visited;

	const width = GameplayMap.getGridWidth();
	const height = GameplayMap.getGridHeight();
	const total = width * height;
	const scoutIndex = GameplayMap.getIndexFromXY(scoutLoc.x, scoutLoc.y);
	const avoidRadius = dangerRadius + 1;

	const better = (a, b) => {
		if (a.score !== b.score) return a.score > b.score;
		if (a.hidden !== b.hidden) return a.hidden > b.hidden;
		return a.dist < b.dist;
	};

	// Bounded best-first list (maxCandidates is small, so insertion is cheap).
	const top = [];

	for (let i = 0; i < total; i++) {
		if (revealedStates[i] === RevealedStates.HIDDEN) continue;
		if (i === scoutIndex) continue;
		if (visited && visited.has(i)) continue;

		const loc = GameplayMap.getLocationFromIndex(i);
		const x = loc.x;
		const y = loc.y;
		if (GameplayMap.isWater(x, y)) continue;
		// isImpassable is only seen in map-generation scripts; guard in case the UI runtime lacks it.
		if (typeof GameplayMap.isImpassable === "function" && GameplayMap.isImpassable(x, y)) continue;
		if (GameplayMap.isMountain(x, y)) continue;
		if (GameplayMap.getAreaId(x, y) !== areaId) continue;

		const hidden = countHiddenNeighbors(loc, revealedStates);
		if (hidden <= 0) continue;
		if (isWithinRadiusOfAny(loc, threatLocs, avoidRadius)) continue;

		const dist = GameplayMap.getPlotDistance(scoutLoc.x, scoutLoc.y, x, y);
		const cand = { index: i, x: x, y: y, hidden: hidden, dist: dist, score: hidden / (1 + dist) };

		if (top.length >= maxCandidates && !better(cand, top[top.length - 1])) continue;

		let pos = top.length;
		while (pos > 0 && better(cand, top[pos - 1])) pos--;
		top.splice(pos, 0, cand);
		if (top.length > maxCandidates) top.pop();
	}

	return top;
}

/**
 * Whether a plot is still a frontier (has at least one hidden neighbor).
 * @param {{x:number,y:number}} loc
 * @param {ArrayLike<number>} revealedStates
 * @returns {boolean}
 */
export function isFrontierPlot(loc, revealedStates) {
	return countHiddenNeighbors(loc, revealedStates) > 0;
}
