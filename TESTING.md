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
12. Run the named-timezone script below (set `CALENDAR_UID` in it first if not `system-calendar`). **Expect:** prints `PASS`. If it warns about crossing midnight, run it again.

```bash
python3 - <<'PYEOF'
import gi
gi.require_version("EDataServer", "1.2")
gi.require_version("ECal", "2.0")
gi.require_version("ICalGLib", "3.0")
from gi.repository import EDataServer, ECal, ICalGLib

import sys, uuid
sys.path.insert(0, "helper")
import calendar_helper as ch
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

CALENDAR_UID = "system-calendar"
TZID = "Europe/London"  # real, heavily-used, DST-aware zone - a hand-rolled/
                         # custom TZID isn't reliably resolved

registry = EDataServer.SourceRegistry.new_sync(None)
source = registry.ref_source(CALENDAR_UID)
client = ch._open_client(source)

now_local = datetime.now().astimezone()
raw_start = (now_local + timedelta(minutes=2)).replace(tzinfo=None, second=0, microsecond=0)
raw_end = raw_start + timedelta(minutes=15)
# Independently computed via Python's own system tzdata (zoneinfo), not
# libical's bundled copy - a cross-check, not a reimplementation of what
# Focal itself does.
expected_local = raw_start.replace(tzinfo=ZoneInfo(TZID)).astimezone(now_local.tzinfo).replace(tzinfo=None)

if expected_local.date() != raw_start.date():
    print("WARNING: expected time crosses midnight - re-run this later/earlier so it stays today.")

def fmt_dt(dt):
    return dt.strftime("%Y%m%dT%H%M%S")

summary = f"Focal named-timezone test {uuid.uuid4().hex[:8]}"
ics = f"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Focal//named-tz-test//EN
CALSCALE:GREGORIAN
BEGIN:VTIMEZONE
TZID:{TZID}
BEGIN:DAYLIGHT
DTSTART:19700329T010000
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
TZNAME:BST
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
DTSTART:19701025T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
TZNAME:GMT
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:{uuid.uuid4()}@focal-test
DTSTAMP:{datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")}
SUMMARY:{summary}
DTSTART;TZID={TZID}:{fmt_dt(raw_start)}
DTEND;TZID={TZID}:{fmt_dt(raw_end)}
END:VEVENT
END:VCALENDAR
"""

vcal = ICalGLib.Component.new_from_string(ics)
vevent = vcal.get_first_component(ICalGLib.ComponentKind.VEVENT_COMPONENT)

success, created_uid = client.create_object_sync(vevent, ECal.OperationFlags.NONE, None)
if not success:
    print("FAIL: could not create test event")
    sys.exit(1)

try:
    _, comps = client.get_object_list_as_comps_sync("#t", None)
    match = next((c for c in comps if (c.get_summary().get_value() if c.get_summary() else "") == summary), None)

    if match is None:
        print("FAIL: created event not found via query")
    else:
        ev = ch._comp_to_event(match)
        actual = datetime.fromisoformat(ev["start_iso"])
        print(f"Raw written clock-time: {raw_start.strftime('%H:%M')}")
        print(f"Expected (per system tzdata): {expected_local.strftime('%H:%M')}")
        print(f"calendar_helper.py computed: {actual.strftime('%Y-%m-%d %H:%M')}")
        print("PASS" if actual.replace(second=0, microsecond=0) == expected_local.replace(second=0, microsecond=0) else "FAIL: mismatch")
finally:
    ok = client.remove_object_sync(created_uid, None, ECal.ObjModType.ALL, ECal.OperationFlags.NONE, None)
    print(f"Cleanup: removed test event ({'ok' if ok else 'FAILED - remove manually'})")
PYEOF
```

## Right-click menu

 1. Right-click the panel. **Expect:** "Direct Mode"/"Calendar Mode" shown, checkmark on whichever is active.
 2. Click the inactive mode. **Expect:** switches immediately, panel updates to match.

## Settings & About

 1. Open Settings (gear in Applets list, or right-click → Settings). **Expect:** opens without error, every section renders.
 2. Open About (Applets list). **Expect:** opens without error, correct name/description/icon.

## Icon

 1. Toggle "Show an icon" off, then on. **Expect:** icon disappears, then reappears next to the panel text.
