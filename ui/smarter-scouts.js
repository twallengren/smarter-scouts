// Smarter Scouts: a cautious replacement for the Auto Explore button.
//
// The engine's own auto-explore plans a whole turn of movement up front and
// only notices enemy zone of control after the scout is already inside it.
// This script replaces the Auto Explore action for the local player's land
// units: it moves the unit ONE tile at a time and re-scans for hostile
// military units after every step, so the scout stops the moment a threat
// comes into view, while it still has movement points left to react with.
//
// Facts this file relies on (confirmed by the diagnostics build, see git
// history):
//  - console.log is dropped from Logs/UI.log; console.warn/error are kept.
//  - Pressing Auto Explore moves the unit immediately in the engine, so the
//    only safe hook is replacing the action callback via Controls.decorate.
//  - UnitOperationAdded.data1 carries the operation hash;
//    UnitMoveComplete carries {unit, location}.
//  - Events fire for every player's units; everything filters on owner.

import { findFrontier, isFrontierPlot } from "./smarter-scouts-planner.js";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Stop exploring when a hostile military unit is visible within this many tiles. */
const DANGER_RADIUS = 3;
/** Safety cap on single-tile steps per unit per turn. */
const MAX_STEPS_PER_TURN = 20;
/** How many frontier candidates to path-test per round when choosing a target. */
const MAX_CANDIDATES = 8;
/** How many rounds of candidates to try before declaring nothing reachable. */
const MAX_CANDIDATE_ROUNDS = 4;

const TAG = "[SmarterScouts]";
const EXPLORE_OP = "UNITOPERATION_AUTOMATE_EXPLORE";
const SAVE_KEY_PREFIX = "SMARTER_SCOUTS_TRACKED_V1:";
/** Verbose tracing to UI.log (temporary, for the end-turn hang investigation). */
const TRACE = true;
/** Set false to run with the Auto Explore button hook disabled (bisecting). */
const HOOK_BUTTON = true;

function trace(...args) {
	if (TRACE) console.warn(TAG, "TRACE", ...args);
}

// Catch anything that escapes our try/catch blocks or vanilla code we touch.
try {
	if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
		window.addEventListener("error", (e) => {
			console.error(TAG, "window.error:", e && e.message, e && e.filename, e && e.lineno, e && e.error && e.error.stack);
		});
		window.addEventListener("unhandledrejection", (e) => {
			console.error(TAG, "unhandledrejection:", e && e.reason && (e.reason.stack || e.reason));
		});
	}
} catch (e) {
	/* ignore */
}

// ---------------------------------------------------------------------------
// Logging (warn, not log: see header)
// ---------------------------------------------------------------------------

function log(...args) {
	console.warn(TAG, ...args);
}

function logErr(where, e) {
	console.error(TAG, where, "failed:", e && e.message, e && e.stack);
}

function js(x) {
	try {
		const s = JSON.stringify(x);
		return s === undefined ? String(x) : s;
	} catch (e) {
		return String(x);
	}
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function keyOf(cid) {
	return `${cid.owner}:${cid.id}:${cid.type}`;
}

function cidFromKey(key) {
	const parts = key.split(":").map(Number);
	if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
	return { owner: parts[0], id: parts[1], type: parts[2] };
}

function sameLoc(a, b) {
	return !!a && !!b && a.x === b.x && a.y === b.y;
}

function localPlayerID() {
	return GameContext.localPlayerID;
}

function isLocalTurnActive() {
	const me = Players.get(localPlayerID());
	return !!me && me.isTurnActive !== false;
}

/** Land, non-embarked unit? Only those get the cautious explorer. */
function isLandUnit(unit) {
	const def = GameInfo.Units.lookup(unit.type);
	if (!def || def.Domain !== "DOMAIN_LAND") return false;
	if (typeof unit.isEmbarked === "function" && unit.isEmbarked()) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Tracked units
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Entry
 * @property {{owner:number,id:number,type:number}} cid
 * @property {{x:number,y:number}|null} target
 * @property {{x:number,y:number}|null} pendingDest  tile of the step we requested, until it completes
 * @property {number} expectOpAdded  our own MOVE_TO UnitOperationAdded events still to arrive
 * @property {number} stepsThisTurn
 * @property {number} retries
 * @property {Set<number>} visited   plot indices found unreachable this turn
 */

/** @type {Map<string, Entry>} */
const tracked = new Map();
let restoredFromSave = false;

function saveKeyHash() {
	return Database.makeHash(SAVE_KEY_PREFIX + localPlayerID());
}

// Persistence: a comma-joined key list in the save-backed GameTutorial store
// (same mechanism core/ui/utilities/utility-serialize.js uses), one key per
// local player so hotseat seats don't clobber each other.
function saveTracked() {
	try {
		const local = localPlayerID();
		const keys = [...tracked.values()].filter((e) => e.cid.owner === local).map((e) => keyOf(e.cid));
		GameTutorial.setProperty(saveKeyHash(), keys.join(","));
	} catch (e) {
		logErr("saveTracked", e);
	}
}

function restoreTracked() {
	if (restoredFromSave) return;
	restoredFromSave = true;
	try {
		const raw = GameTutorial.getProperty(saveKeyHash());
		if (typeof raw !== "string" || raw.length === 0) return;
		let n = 0;
		for (const key of raw.split(",")) {
			const cid = cidFromKey(key);
			if (!cid || cid.owner !== localPlayerID()) continue;
			if (!Units.get(cid)) continue; // unit died or was disbanded
			if (!tracked.has(key)) {
				tracked.set(key, newEntry(cid));
				n++;
			}
		}
		if (n > 0) log(`restored ${n} exploring unit(s) from save`);
	} catch (e) {
		logErr("restoreTracked", e);
	}
}

function newEntry(cid) {
	return {
		cid: { owner: cid.owner, id: cid.id, type: cid.type },
		target: null,
		pendingDest: null,
		expectOpAdded: 0,
		stepsThisTurn: 0,
		retries: 0,
		visited: new Set(),
	};
}

function track(cid) {
	restoreTracked(); // never let a fresh track() overwrite an unread save
	const key = keyOf(cid);
	let entry = tracked.get(key);
	if (!entry) {
		entry = newEntry(cid);
		tracked.set(key, entry);
		saveTracked();
	}
	return entry;
}

function untrack(entry, reason) {
	if (!tracked.delete(keyOf(entry.cid))) return;
	log(`stop exploring ${keyOf(entry.cid)}: ${reason}`);
	saveTracked();
}

function entryFor(cid) {
	if (!cid || cid.owner !== localPlayerID()) return undefined;
	return tracked.get(keyOf(cid));
}

// ---------------------------------------------------------------------------
// Threat detection
// ---------------------------------------------------------------------------

function isMilitaryDef(def) {
	return !!def && (def.CoreClass === "CORE_CLASS_MILITARY" || def.ZoneOfControl === true);
}

/** Is a unit owned by `ownerId` something that would attack us? */
function isHostileOwner(me, ownerId, unit) {
	if (me.Diplomacy && me.Diplomacy.isAtWarWith(ownerId)) return true;
	const owner = Players.get(ownerId);
	if (!owner) return false;
	if (owner.isBarbarian) return true;
	if (owner.isIndependent || owner.isMinor) {
		const indId = Game.IndependentPowers.getIndependentPlayerIDFromUnit(unit.id);
		if (indId !== PlayerIds.NO_PLAYER) {
			const rel = Game.IndependentPowers.getIndependentRelationship(indId, me.id);
			return rel === IndependentRelationship.HOSTILE;
		}
		return true; // unknown independent: be cautious
	}
	return false;
}

/**
 * Visible hostile military units within DANGER_RADIUS of `loc`.
 * @returns {{x:number,y:number,name:string}[]}
 */
function findThreats(loc) {
	const local = localPlayerID();
	const me = Players.get(local);
	const threats = [];
	if (!me) return threats;
	const indices = GameplayMap.getPlotIndicesInRadius(loc.x, loc.y, DANGER_RADIUS);
	for (const idx of indices) {
		const p = GameplayMap.getLocationFromIndex(idx);
		if (GameplayMap.getRevealedState(local, p.x, p.y) !== RevealedStates.VISIBLE) continue;
		const unitIds = MapUnits.getUnits(p.x, p.y);
		if (!unitIds) continue;
		for (const uid of unitIds) {
			if (uid.owner === local) continue;
			const u = Units.get(uid);
			if (!u) continue;
			if (!Visibility.isVisible(local, u.id)) continue;
			const def = GameInfo.Units.lookup(u.type);
			if (!isMilitaryDef(def)) continue;
			if (!isHostileOwner(me, uid.owner, u)) continue;
			threats.push({ x: p.x, y: p.y, name: def.UnitType });
		}
	}
	return threats;
}

// ---------------------------------------------------------------------------
// Player feedback
// ---------------------------------------------------------------------------

function alertPlayer(unit) {
	try {
		UI.Player.selectUnit(unit.id);
	} catch (e) {
		logErr("selectUnit", e);
	}
	try {
		UI.Player.lookAtID(unit.id, 0);
	} catch (e) {
		logErr("lookAtID", e);
	}
	try {
		UI.sendAudioEvent("popup-open-generic");
	} catch (e) {
		/* audio is optional */
	}
}

// ---------------------------------------------------------------------------
// Target selection and stepping
// ---------------------------------------------------------------------------

function plotIndexOf(loc) {
	return GameplayMap.getIndexFromLocation(loc);
}

/**
 * Pick the best-scoring frontier plot that is actually reachable. Unreachable
 * candidates go into entry.visited and the next round skips them.
 */
function chooseTarget(unit, loc, revealed, entry) {
	const areaId = GameplayMap.getAreaId(loc.x, loc.y);
	for (let round = 0; round < MAX_CANDIDATE_ROUNDS; round++) {
		const candidates = findFrontier({
			revealedStates: revealed,
			scoutLoc: loc,
			areaId,
			maxCandidates: MAX_CANDIDATES,
			visited: entry.visited,
		});
		if (candidates.length === 0) return null;
		let best = null;
		let bestTurns = Infinity;
		for (const c of candidates) {
			const path = Units.getPathTo(unit.id, { x: c.x, y: c.y });
			if (!path || !path.plots || path.plots.length < 2) {
				entry.visited.add(c.index);
				continue;
			}
			const turns = path.turns && path.turns.length ? path.turns[path.turns.length - 1] : Infinity;
			// Candidates arrive best-score-first; only let a later one win if it
			// is clearly closer in turns.
			if (best === null || turns < bestTurns - 1) {
				best = { x: c.x, y: c.y };
				bestTurns = turns;
			}
		}
		if (best) return best;
	}
	return null;
}

/** Advance one tracked unit by at most one tile. Safe to call repeatedly. */
function step(entry) {
	const unit = Units.get(entry.cid);
	if (!unit || (typeof unit.isOnMap === "function" && !unit.isOnMap())) {
		untrack(entry, "unit no longer on map");
		return;
	}
	const moves = unit.Movement ? unit.Movement.movementMovesRemaining : 0;
	trace(`step ${keyOf(entry.cid)} at ${js(unit.location)} moves=${moves} turnActive=${isLocalTurnActive()} pending=${js(entry.pendingDest)} steps=${entry.stepsThisTurn} activity=${unit.activityType}`);
	if (!isLocalTurnActive()) {
		trace("step: local turn not active; skipping");
		return; // never issue orders during other players' turns
	}
	if (entry.pendingDest) {
		trace("step: move still pending; skipping");
		return; // waiting for UnitMoveComplete
	}
	if (!(moves > 0)) {
		trace("step: no moves left this turn");
		return; // finished for this turn
	}
	if (entry.stepsThisTurn >= MAX_STEPS_PER_TURN) {
		log(`${keyOf(entry.cid)} hit MAX_STEPS_PER_TURN; pausing until next turn`);
		return;
	}

	const loc = unit.location;
	const threats = findThreats(loc);
	if (threats.length > 0) {
		untrack(entry, `threat in view at ${js(threats)} (scout at ${js(loc)})`);
		alertPlayer(unit);
		return;
	}

	const revealed = GameplayMap.getRevealedStates(localPlayerID());
	const hereIdx = plotIndexOf(loc);

	if (entry.target && (plotIndexOf(entry.target) === hereIdx || !isFrontierPlot(entry.target, revealed))) {
		entry.target = null;
	}
	if (!entry.target) {
		entry.target = chooseTarget(unit, loc, revealed, entry);
		if (!entry.target) {
			untrack(entry, "nothing reachable left to explore");
			alertPlayer(unit);
			return;
		}
	}

	const path = Units.getPathTo(unit.id, entry.target);
	if (!path || !path.plots || path.plots.length < 2) {
		entry.visited.add(plotIndexOf(entry.target));
		entry.target = null;
		return retryStep(entry);
	}
	const nextIdx = path.plots[0] === hereIdx ? path.plots[1] : path.plots[0];
	const next = GameplayMap.getLocationFromIndex(nextIdx);
	const params = {
		X: next.x,
		Y: next.y,
		Modifiers: UnitOperationMoveModifiers.MOVE_IGNORE_UNEXPLORED_DESTINATION,
	};
	const can = Game.UnitOperations.canStart(unit.id, UnitOperationTypes.MOVE_TO, params, false);
	if (!can || !can.Success) {
		log(`cannot step ${keyOf(entry.cid)} to ${js(next)}: ${js(can && can.FailureReasons)}`);
		entry.visited.add(nextIdx);
		entry.visited.add(plotIndexOf(entry.target));
		entry.target = null;
		return retryStep(entry);
	}

	entry.pendingDest = { x: next.x, y: next.y };
	entry.expectOpAdded++;
	entry.stepsThisTurn++;
	entry.retries = 0;
	Game.UnitOperations.sendRequest(unit.id, UnitOperationTypes.MOVE_TO, params);
}

function retryStep(entry) {
	if (entry.retries >= 2) {
		log(`${keyOf(entry.cid)}: no usable target after retries; pausing this turn`);
		entry.retries = 0;
		return;
	}
	entry.retries++;
	step(entry);
}

function beginTurnForAll() {
	restoreTracked();
	const local = localPlayerID();
	for (const entry of [...tracked.values()]) {
		if (entry.cid.owner !== local) continue;
		entry.stepsThisTurn = 0;
		entry.pendingDest = null;
		entry.expectOpAdded = 0;
		entry.retries = 0;
		entry.visited.clear();
		try {
			step(entry);
		} catch (e) {
			logErr("step@turnBegin " + keyOf(entry.cid), e);
		}
	}
}

function endTurnForAll() {
	// Anything still pending at turn end has either been consumed by the engine
	// or will never complete; don't carry the wait into the next turn.
	for (const entry of tracked.values()) {
		entry.pendingDest = null;
		entry.expectOpAdded = 0;
	}
}

/**
 * Called from the (replaced) Auto Explore button. Starts exploring, or if the
 * unit is already exploring, nudges it to step now. (Not a toggle: the button
 * has no on/off indicator, so a toggle is too easy to flip by accident. Any
 * other order given to the unit stops it.)
 * @returns {boolean} true if handled, false if vanilla should run instead.
 */
function startExploring(unit) {
	restoreTracked();
	const existing = entryFor(unit.id);
	if (existing) {
		log(`already exploring ${keyOf(unit.id)}; stepping now`);
		step(existing);
		return true;
	}
	if (!isLandUnit(unit)) return false; // naval/embarked: vanilla behaviour
	const entry = track(unit.id);
	log(`start exploring ${keyOf(unit.id)}`);
	step(entry);
	return true;
}

// ---------------------------------------------------------------------------
// Engine events
// ---------------------------------------------------------------------------

function onUnitMoveComplete(data) {
	const entry = entryFor(data && data.unit);
	if (!entry || !entry.pendingDest) return;
	if (!sameLoc(data.location, entry.pendingDest)) {
		// The unit arrived somewhere we didn't send it: the player (or the
		// game) moved it. Hand control back.
		untrack(entry, `moved to ${js(data.location)} by other orders`);
		return;
	}
	entry.pendingDest = null;
	step(entry);
}

function onUnitOperationAdded(data) {
	const entry = entryFor(data && data.unit);
	if (!entry) return;
	// Exactly one UnitOperationAdded(MOVE_TO) is ours per step we requested;
	// anything beyond that means the player gave different orders.
	if (data.data1 === UnitOperationTypes.MOVE_TO && entry.expectOpAdded > 0) {
		entry.expectOpAdded--;
		return;
	}
	untrack(entry, `other orders received (op ${data.data1})`);
}

function onUnitActivityChanged(data) {
	const entry = entryFor(data && data.unit);
	if (!entry) return;
	const a = data.activity;
	if (a === UnitActivityTypes.SLEEP || a === UnitActivityTypes.HOLD || a === UnitActivityTypes.SENTRY || a === UnitActivityTypes.HEAL) {
		untrack(entry, "unit put to sleep/hold/sentry/heal");
	}
}

function onUnitRemovedFromMap(data) {
	const entry = entryFor(data && data.unit);
	if (entry) untrack(entry, "removed from map");
}

let turnBegunFor = -1;

function onPlayerTurnActivated(data) {
	if (!data || data.player !== localPlayerID()) return;
	// LocalPlayerTurnBegin fires before the player is flagged turn-active, so
	// orders issued there are refused. Run the per-turn work here instead, once
	// per game turn. This also covers loading a save mid-turn.
	if (turnBegunFor === Game.turn) return;
	turnBegunFor = Game.turn;
	beginTurnForAll();
}

function wrap(name, fn) {
	return (data) => {
		trace("event", name, data && data.unit ? `owner=${data.unit.owner} id=${data.unit.id}` : (data && data.player !== undefined ? `player=${data.player}` : ""));
		try {
			fn(data);
		} catch (e) {
			logErr("handler " + name, e);
		}
		trace("event done", name);
	};
}

engine.on("LocalPlayerTurnEnd", wrap("LocalPlayerTurnEnd", endTurnForAll));
engine.on("PlayerTurnActivated", wrap("PlayerTurnActivated", onPlayerTurnActivated));
engine.on("UnitMoveComplete", wrap("UnitMoveComplete", onUnitMoveComplete));
engine.on("UnitOperationAdded", wrap("UnitOperationAdded", onUnitOperationAdded));
engine.on("UnitActivityChanged", wrap("UnitActivityChanged", onUnitActivityChanged));
engine.on("UnitRemovedFromMap", wrap("UnitRemovedFromMap", onUnitRemovedFromMap));

// ---------------------------------------------------------------------------
// Replace the Auto Explore button's behaviour.
// unit-actions.js rebuilds `this.actions` via getUnitActions(unit) every time
// the panel refreshes; we wrap that per-instance and swap the callback on the
// AUTOMATE_EXPLORE entry. Both the button click and the X hotkey go through
// action.callback.
// ---------------------------------------------------------------------------

if (HOOK_BUTTON) try {
	Controls.decorate("unit-actions", (component) => ({
		beforeAttach() {
			trace("unit-actions beforeAttach");
		},
		afterAttach() {
			trace("unit-actions afterAttach start");
			try {
				if (component.__smarterScoutsWrapped) {
					trace("already wrapped");
					return;
				}
				component.__smarterScoutsWrapped = true;
				const original = component.getUnitActions;
				if (typeof original !== "function") {
					log("unit-actions has no getUnitActions; Auto Explore not replaced");
					return;
				}
				component.getUnitActions = function (unit) {
					trace("getUnitActions wrapper enter", unit && unit.id ? `owner=${unit.id.owner} id=${unit.id.id}` : typeof unit);
					let result;
					try {
						result = original.call(this, unit);
					} catch (e) {
						logErr("vanilla getUnitActions threw", e);
						throw e;
					}
					trace("getUnitActions vanilla done; actions=", Array.isArray(this.actions) ? this.actions.length : typeof this.actions);
					try {
						if (!Array.isArray(this.actions)) return result;
						for (const action of this.actions) {
							if (!action || action.type !== EXPLORE_OP) continue;
							const vanilla = action.callback;
							const panel = this;
							action.callback = (location) => {
								try {
									if (!action.active) return;
									const handled = startExploring(unit);
									if (!handled && typeof vanilla === "function") {
										vanilla(location);
										return;
									}
									if (typeof panel.realizeButtons === "function") panel.realizeButtons();
								} catch (e) {
									logErr("autoExplore callback", e);
								}
							};
						}
					} catch (e) {
						logErr("getUnitActions wrapper", e);
					}
					trace("getUnitActions wrapper exit");
					return result;
				};
				log("Auto Explore action replaced");
			} catch (e) {
				logErr("decorate afterAttach", e);
			}
			trace("unit-actions afterAttach end");
		},
		beforeDetach() {
			trace("unit-actions beforeDetach");
		},
		afterDetach() {
			trace("unit-actions afterDetach");
		},
	}));
} catch (e) {
	logErr("Controls.decorate", e);
}

log("loaded (danger radius " + DANGER_RADIUS + ", trace=" + TRACE + ", hookButton=" + HOOK_BUTTON + ")");
