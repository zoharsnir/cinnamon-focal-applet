# Focal manual test suite

Execution steps + expected result only. Install/reload per [README.md](README.md) before starting.

## Direct mode

1. Click panel text. **Expect:** popup opens, text preselected, cursor focused.
2. Type new text, hit Enter. **Expect:** panel updates immediately.
3. Click panel text, pick a text-color swatch, confirm (hit Enter or click Apply). **Expect:** panel text color changes.
4. Click panel text, pick a background swatch, confirm (hit Enter or click Apply). **Expect:** panel background changes.
5. Open popup, pick a different color, press Escape or click outside the popup (to cancel). **Expect:** panel reverts, nothing persisted.
6. Set a hotkey in Settings, press it anywhere. **Expect:** popup opens.
7. Hover the panel text. **Expect:** tooltip shows the full text.
8. Set "Truncate panel text" to a small number (e.g. 10), type a longer text. **Expect:** panel shows truncated text with "…"; tooltip still shows the full text.

## Calendar mode

1. Switch mode to Calendar. **Expect:** panel briefly shows "Fetching from calendar…", then an event or "No active event".
2. No current event, "show upcoming" off. **Expect:** panel shows "No active event".
3. "Show upcoming" on, no current event, something later today. **Expect:** panel shows "Upcoming \<time\> \<summary\>", time matches system 24h/12h setting.
4. "Show upcoming" on, nothing left today. **Expect:** panel shows "No active or upcoming events".
5. During a current event. **Expect:** panel shows the event's summary.
6. Enable "Show when the current event ends". **Expect:** "Until \<time\>" appended, time matches system 24h/12h setting.
7. Enable "Show how much time is left". **Expect:** "Remaining Xh, Ym" (or "Ym" if it's under an hour) appended.
8. Enable "Always use the color above, even for events with their own color". **Expect:** panel uses the configured default color, not the event's color.
9. Open popup while in Calendar mode. **Expect:** no text entry, both color rows present.
10. In Settings, pick a specific calendar from the dropdown. **Expect:** only that calendar's events show on the panel.
11. In Settings, pick "System Default (...)". **Expect:** reverts to showing events from the system default calendar.

## Right-click menu

 1. Right-click the panel. **Expect:** "Direct Mode"/"Calendar Mode" shown, checkmark on whichever is active.
 2. Click the inactive mode. **Expect:** switches immediately, panel updates to match.

## Settings & About

 1. Open Settings (gear in Applets list, or right-click → Settings). **Expect:** opens without error, every section renders.
 2. Open About (Applets list). **Expect:** opens without error, correct name/description/icon.

## Icon

 1. Toggle "Show an icon" off, then on. **Expect:** icon disappears, then reappears next to the panel text.
