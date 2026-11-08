# Smarter Scouts

A Civilization VII mod that replaces the Auto Explore action for your units with a cautious version. The vanilla auto-explore commits to a full turn of movement and only stops once the scout is already inside an enemy's zone of control, which usually gets it killed. Smarter Scouts moves the unit one tile at a time and re-scans for visible hostile military units after every step, stopping immediately (with movement points still in hand) when one appears, then selects the unit and moves the camera to it so you can decide what to do.

## How it works

- Press Auto Explore (button or X hotkey) as normal; the mod takes over instead of the engine.
- Each turn the mod picks a "frontier" target: a revealed land tile on the same landmass that borders unexplored tiles, scored by unexplored neighbours and distance.
- It paths to the target and steps one tile at a time, re-checking for threats after each step.
- A threat is a visible unit within `DANGER_RADIUS` tiles (default 3) that is military (`CORE_CLASS_MILITARY` or exerts zone of control) and belongs to a player you are at war with, a hostile independent power, or barbarians.
- Give the unit any other order (move, sleep, skip turn, ...) to turn the behaviour off. Pressing Auto Explore again on an exploring unit just makes it step immediately.
- Exploring units are remembered across save and load.
- When nothing reachable is left to explore, the unit stops and is selected.

## Settings

Constants at the top of `ui/smarter-scouts.js`:

- `DANGER_RADIUS` (3): how many tiles away a visible hostile military unit must be to stop a scout.
- `MAX_STEPS_PER_TURN` (20): upper limit on single-tile steps a scout takes in one turn.
- `MAX_CANDIDATES` (8): how many frontier targets are considered when choosing where to explore next.

## Install

Copy the `smarter-scouts` folder into `%LOCALAPPDATA%\Firaxis Games\Sid Meier's Civilization VII\Mods` and enable it under **Additional Content → Mods**.

## Limits

- Runs in the game's UI script layer on the local client only. It protects the local player's units: fine for single player, and in multiplayer only your own scouts are affected.
- It can only see what you can see. The gain comes from re-checking after every tile and keeping a safety margin.
- Land exploration only. For naval or embarked units the Auto Explore button keeps its vanilla behaviour.
- Villages, encampments and rival borders are not avoided; only visible military units are.

## Troubleshooting

The game drops `console.log`, so this mod logs with `console.warn`. Look for `[SmarterScouts]` lines in `%LOCALAPPDATA%\Firaxis Games\Sid Meier's Civilization VII\Logs\UI.log`. `Modding.log` in the same folder shows whether the mod loaded.

## Files

- `smarter-scouts.modinfo`: mod manifest.
- `ui/smarter-scouts.js`: hook, state, threat scan and stepping.
- `ui/smarter-scouts-planner.js`: pure frontier-selection helpers.
