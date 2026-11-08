// Smarter Scouts - DIAGNOSTICS ONLY.
// Purpose: run the game once and learn which globals/hooks/events are available.
// No imports; only globals are used. Every handler is wrapped in try/catch.

const TAG = "[SmarterScouts]";

// NOTE: the game drops console.log output below its default LogSeverity;
// console.warn/console.error do reach Logs/UI.log, so warn is used here.
function log(...args) {
	console.warn(TAG, ...args);
}

function logErr(where, e) {
	console.error(TAG, where, "failed:", e && e.message, e && e.stack);
}

// Safe JSON.stringify: falls back to String(x) on any failure.
function js(x) {
	try {
		const s = JSON.stringify(x);
		return s === undefined ? String(x) : s;
	} catch (e) {
		return String(x);
	}
}

// Run fn, logging any error under the given label.
function safe(label, fn) {
	try {
		return fn();
	} catch (e) {
		logErr(label, e);
	}
}

log("loaded");

// ---------------------------------------------------------------------------
// 1. Global availability (each on its own line)
// ---------------------------------------------------------------------------
safe("typeof globals", () => {
	log("typeof engine = " + typeof engine);
	log("typeof GameContext = " + typeof GameContext);
	log("typeof Game = " + typeof Game);
	log("typeof Game?.UnitOperations = " + typeof Game?.UnitOperations);
	log("typeof Game?.UnitCommands = " + typeof Game?.UnitCommands);
	log("typeof Game?.IndependentPowers = " + typeof Game?.IndependentPowers);
	log("typeof Units = " + typeof Units);
	log("typeof MapUnits = " + typeof MapUnits);
	log("typeof Players = " + typeof Players);
	log("typeof GameplayMap = " + typeof GameplayMap);
	log("typeof Visibility = " + typeof Visibility);
	log("typeof GameInfo = " + typeof GameInfo);
	log("typeof Database = " + typeof Database);
	log("typeof Controls = " + typeof Controls);
	log("typeof UI = " + typeof UI);
	log("typeof UI?.Player = " + typeof UI?.Player);
	log("typeof GameTutorial = " + typeof GameTutorial);
	log("typeof UnitActivityTypes = " + typeof UnitActivityTypes);
	log("typeof UnitOperationTypes = " + typeof UnitOperationTypes);
	log("typeof UnitOperationMoveModifiers = " + typeof UnitOperationMoveModifiers);
	log("typeof RevealedStates = " + typeof RevealedStates);
	log("typeof DirectionTypes = " + typeof DirectionTypes);
	log("typeof IndependentRelationship = " + typeof IndependentRelationship);
	log("typeof ComponentID = " + typeof ComponentID);
	log("typeof PlayerIds = " + typeof PlayerIds);
});

// ---------------------------------------------------------------------------
// 2. Enum dumps
// ---------------------------------------------------------------------------
safe("enum dumps", () => {
	if (typeof UnitActivityTypes !== "undefined") log("UnitActivityTypes = " + js(UnitActivityTypes));
	if (typeof RevealedStates !== "undefined") log("RevealedStates = " + js(RevealedStates));
	if (typeof IndependentRelationship !== "undefined") log("IndependentRelationship = " + js(IndependentRelationship));
	if (typeof UnitOperationMoveModifiers !== "undefined") log("UnitOperationMoveModifiers = " + js(UnitOperationMoveModifiers));
	if (typeof UnitOperationTypes !== "undefined") {
		log("UnitOperationTypes.MOVE_TO = " + js(UnitOperationTypes.MOVE_TO));
		log("UnitOperationTypes.SKIP_TURN = " + js(UnitOperationTypes.SKIP_TURN));
	}
	if (typeof Database !== "undefined" && typeof Database.makeHash === "function") {
		log("makeHash(UNITOPERATION_AUTOMATE_EXPLORE) = " + js(Database.makeHash("UNITOPERATION_AUTOMATE_EXPLORE")));
		log("makeHash(UNITOPERATION_MOVE_TO) = " + js(Database.makeHash("UNITOPERATION_MOVE_TO")));
	}
});

// ---------------------------------------------------------------------------
// 3. Unit definition sample
// ---------------------------------------------------------------------------
safe("unit definitions", () => {
	for (const t of ["UNIT_SCOUT", "UNIT_WARRIOR", "UNIT_SETTLER", "UNIT_SLINGER", "UNIT_ARMY_COMMANDER"]) {
		safe("unit def " + t, () => {
			const d = GameInfo.Units.lookup(t);
			log(t, "CoreClass=" + d?.CoreClass, "FormationClass=" + d?.FormationClass,
				"ZoneOfControl=" + d?.ZoneOfControl, "Domain=" + d?.Domain,
				"UnitMovementClass=" + d?.UnitMovementClass);
		});
	}
	log("GameInfo.Units.length = " + GameInfo.Units.length);
	log("Object.keys(GameInfo.Units[0]) = " + js(Object.keys(GameInfo.Units[0])));
});

// ---------------------------------------------------------------------------
// 4. Event subscriptions
// ---------------------------------------------------------------------------

// Log details for a unit event if the unit belongs to the local player.
function logUnitDetails(data) {
	if (!data || !data.unit) return;
	if (data.unit.owner != GameContext.localPlayerID) return;
	const u = Units.get(data.unit);
	log("  unit.location = " + js(u?.location));
	log("  unit.type = " + js(u?.type));
	log("  unit.activityType = " + js(u?.activityType));
	log("  unit.Movement.movementMovesRemaining = " + js(u?.Movement?.movementMovesRemaining));
	log("  unit.Movement.maxMoves = " + js(u?.Movement?.maxMoves));
	log("  unit.Combat.hasMovedIntoZOC = " + js(u?.Combat?.hasMovedIntoZOC));
	if (typeof Units.getQueuedOperationDestination === "function") {
		log("  queuedOperationDestination = " + js(Units.getQueuedOperationDestination(data.unit)));
	} else {
		log("  Units.getQueuedOperationDestination is " + typeof Units.getQueuedOperationDestination);
	}
	const def = u ? GameInfo.Units.lookup(u.type) : undefined;
	if (def) log("  unitDef.UnitType = " + js(def.UnitType));
}

// Generic handler factory for all non-PlotVisibilityChanged events.
function makeHandler(name) {
	return (data) => {
		try {
			log("event " + name + " " + js(data));
			logUnitDetails(data);
			if (name === "UnitActivityChanged") {
				log("  operationType == AUTOMATE_EXPLORE: " +
					(data?.operationType == Database.makeHash("UNITOPERATION_AUTOMATE_EXPLORE")));
				log("  operationType == MOVE_TO: " +
					(data?.operationType == UnitOperationTypes.MOVE_TO));
			}
		} catch (e) {
			logErr("handler " + name, e);
		}
	};
}

// PlotVisibilityChanged is noisy: log first 30, then a summary every 200.
let plotVisCount = 0;
function onPlotVisibilityChanged(data) {
	try {
		plotVisCount++;
		if (plotVisCount <= 30) {
			log("PlotVisibilityChanged " + data?.location?.x + "," + data?.location?.y +
				" -> " + data?.visibility + " (raw keys: " + js(data ? Object.keys(data) : data) + ")");
		} else if (plotVisCount % 200 === 0) {
			log("PlotVisibilityChanged count=" + plotVisCount);
		}
	} catch (e) {
		logErr("handler PlotVisibilityChanged", e);
	}
}

const EVENTS = [
	"UnitActivityChanged",
	"UnitOperationAdded",
	"UnitOperationStarted",
	"UnitOperationSegmentComplete",
	"UnitOperationDeactivated",
	"UnitOperationsCleared",
	"UnitMoved",
	"UnitMoveComplete",
	"UnitSelectionChanged",
	"LocalPlayerTurnBegin",
	"LocalPlayerTurnEnd",
	"PlayerTurnActivated",
	"PlotVisibilityChanged",
];

for (const name of EVENTS) {
	try {
		const handler = name === "PlotVisibilityChanged" ? onPlotVisibilityChanged : makeHandler(name);
		engine.on(name, handler);
		log("subscribed " + name);
	} catch (e) {
		logErr("engine.on " + name, e);
	}
}

// ---------------------------------------------------------------------------
// 5. Decorator probe
// ---------------------------------------------------------------------------
try {
	if (typeof Controls?.decorate === "function") {
		const ret = Controls.decorate("unit-actions", (component) => ({
			beforeAttach() {
				try { log("decorate beforeAttach"); } catch (e) { logErr("beforeAttach", e); }
			},
			afterAttach() {
				try {
					log("decorate afterAttach: actions=" +
						(Array.isArray(component.actions) ? component.actions.length : typeof component.actions));
					log("has getUnitActions=" + typeof component.getUnitActions);
					if (Array.isArray(component.actions)) {
						log("action types: " + component.actions.map((a) => a.type).join(","));
					}
				} catch (e) {
					logErr("decorate afterAttach", e);
				}
			},
			beforeDetach() {},
			afterDetach() {},
		}));
		log("Controls.decorate registered for unit-actions; return value: " + js(ret));
	} else {
		log("Controls.decorate unavailable (typeof " + typeof Controls?.decorate + ")");
	}
} catch (e) {
	logErr("Controls.decorate", e);
}

log("init complete");
