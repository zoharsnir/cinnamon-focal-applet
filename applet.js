const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Main = imports.ui.main;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Mainloop = imports.mainloop;
const Lang = imports.lang;
const ByteArray = imports.byteArray;

const HELPER_SCRIPT = "calendar_helper.py"; // lives next to applet.js, resolved via this.metadata.path
const POLL_TIMEOUT_SECONDS = 15; // kill the helper subprocess if EDS hasn't answered by then

const PRESET_COLORS = [
    "rgb(255,255,255)", // white
    "rgb(231,76,60)",   // red
    "rgb(46,204,113)",  // green
    "rgb(52,152,219)",  // blue
    "rgb(241,196,15)",  // yellow
    "rgb(155,89,182)"   // purple
];

const BG_PRESET_COLORS = [
    "rgba(0,0,0,0)",     // transparent (default) - must stay first
    "rgb(0,0,0)",        // black
    "rgb(255,255,255)",  // white
    "rgb(231,76,60)",    // red
    "rgb(46,204,113)",   // green
    "rgb(52,152,219)"    // blue
];

class FocalApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        // Applet.TextIconApplet doesn't set this itself - it's on applet code
        // to store the metadata main() receives. This was never done, so
        // this.metadata has been undefined this whole time; only surfaced once
        // Calendar mode's error handling got good enough to report it instead
        // of hanging/crashing silently.
        this.metadata = metadata;

        this.set_applet_icon_path(this.metadata.path + "/icon.png");

        this._uuid = "focal@zoharsnir";
        this.instance_id = instance_id;

        this.settings = new Settings.AppletSettings(this, this._uuid, instance_id);
        this._bindSettings();

        this._calendarTimeoutId = null;

        this._buildPopup(orientation);
        this._buildContextMenu();
        this._registerHotkey();
        this._updateCalendarSchemaOptions();

        this._refresh();
    }

    _bindSettings() {
        const B = Settings.BindingDirection;
        this.settings.bindProperty(B.IN, "mode", "mode", this._refresh.bind(this), null);
        this.settings.bindProperty(B.IN, "custom-text", "customText", this._refresh.bind(this), null);
        this.settings.bindProperty(B.IN, "custom-color", "customColor", this._refresh.bind(this), null);
        this.settings.bindProperty(B.IN, "custom-bg-color", "customBgColor", this._refresh.bind(this), null);
        this.settings.bindProperty(B.IN, "selected-calendar", "selectedCalendar", this._refresh.bind(this), null);
        this.settings.bindProperty(B.IN, "poll-interval-seconds", "pollInterval", this._onPollIntervalChanged.bind(this), null);
        this.settings.bindProperty(B.IN, "show-upcoming-fallback", "showUpcomingFallback", this._refresh.bind(this), null);
        this.settings.bindProperty(B.IN, "default-event-color", "defaultEventColor", this._refresh.bind(this), null);
        this.settings.bindProperty(B.IN, "override-event-color", "overrideEventColor", this._refresh.bind(this), null);
        this.settings.bindProperty(B.IN, "upcoming-color", "upcomingColor", this._refresh.bind(this), null);
        this.settings.bindProperty(B.IN, "show-event-end-time", "showEventEndTime", this._refresh.bind(this), null);
        this.settings.bindProperty(B.IN, "show-time-remaining", "showTimeRemaining", this._refresh.bind(this), null);
        this.settings.bindProperty(B.IN, "max-text-length", "maxTextLength", this._refresh.bind(this), null);
        this.settings.bindProperty(B.IN, "show-icon", "showIcon", this._refresh.bind(this), null);
        this.settings.bindProperty(B.IN, "hotkey", "hotkey", this._registerHotkey.bind(this), null);
    }

    // ---------- Popup (text + color picker) ----------

    _buildPopup(orientation) {
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        // Swatch clicks only preview live on the panel (see _previewColors);
        // closing without committing (Escape, click-outside) must revert them.
        // Re-running _refresh() on close does that for free: if _commitPopup()
        // ran first, settings already hold the new values; if not, settings
        // were never touched, so this just re-renders the old ones.
        this.menu.connect("open-state-changed", (menu, isOpen) => {
            if (!isOpen) {
                this._refresh();
            }
        });
    }

    // Rebuilt fresh on every _openPopup() call rather than built once, since
    // its content depends on the current mode: Direct mode gets the text
    // entry, Calendar mode doesn't (editing direct text doesn't apply while
    // Calendar mode is driving the display - committing used to silently
    // switch back to Direct mode, which was confirmed undesired). Colors stay
    // available in both modes.
    _rebuildPopupContent(mode) {
        this.menu.removeAll();

        if (mode === "direct") {
            this._entry = new St.Entry({
                style_class: "focal-entry",
                hint_text: "Type direct text..."
            });
            this._entry.set_can_focus(true);
            this._entryText = this._entry.clutter_text;
            // Explicit selection colors: without these, the selected-text
            // highlight falls back to a theme-derived default that can end up
            // low-contrast against our own hardcoded white text (e.g.
            // white-on-white). Picking one fixed, high-contrast pair reads
            // correctly regardless of theme.
            const [selBgOk, selBgColor] = Clutter.Color.from_string("rgb(53,132,228)");
            if (selBgOk) this._entryText.set_selection_color(selBgColor);
            const [selFgOk, selFgColor] = Clutter.Color.from_string("white");
            if (selFgOk) this._entryText.set_selected_text_color(selFgColor);
            this._entryText.connect("key-press-event", (actor, event) => {
                const symbol = event.get_key_symbol();
                if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
                    this._commitPopup();
                    return true;
                }
                return false;
            });

            const entryItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            entryItem.addActor(this._entry, { expand: true, span: -1 });
            this.menu.addMenuItem(entryItem);
        } else {
            this._entry = null;
            this._entryText = null;
        }

        this._addSectionLabel("Text color");
        this._selectedColor = PRESET_COLORS[0];
        this._swatchButtons = this._buildSwatchRow(PRESET_COLORS, (color, button) => {
            this._selectedColor = color;
            this._highlightSwatch(this._swatchButtons, button);
            this._previewColors();
        });

        this._addSectionLabel("Background color");
        this._selectedBgColor = BG_PRESET_COLORS[0];
        this._bgSwatchButtons = this._buildSwatchRow(BG_PRESET_COLORS, (color, button) => {
            this._selectedBgColor = color;
            this._highlightSwatch(this._bgSwatchButtons, button);
            this._previewColors();
        });

        // TODO: replace these rows with a real GTK/Clutter color-picker dialog
        // for fully custom (non-preset) colors. Presets are a placeholder
        // for the v0.1 hand-off.

        // Plain St.Button in a non-reactive PopupBaseMenuItem, not a real
        // PopupMenuItem - PopupMenuItem grabs keyboard focus on hover (for
        // arrow-key menu navigation), which steals focus from the text entry.
        const confirmItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        const confirmLabel = "Apply";
        const confirmButton = new St.Button({ style_class: "focal-confirm-button", label: confirmLabel });
        confirmButton.connect("clicked", () => this._commitPopup());
        confirmItem.addActor(confirmButton, { expand: true, span: -1 });
        this.menu.addMenuItem(confirmItem);
    }

    _addSectionLabel(text) {
        const labelItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        const label = new St.Label({ text: text, style_class: "focal-section-label" });
        labelItem.addActor(label, { expand: true, span: -1 });
        this.menu.addMenuItem(labelItem);
    }

    _buildSwatchRow(colors, onSelect) {
        const rowItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        const row = new St.BoxLayout({ style_class: "focal-swatch-row" });
        const buttons = [];

        colors.forEach((color) => {
            const isTransparent = color === "rgba(0,0,0,0)";
            const swatch = new St.Button({
                style_class: isTransparent ? "focal-swatch focal-swatch-transparent" : "focal-swatch",
                label: isTransparent ? "×" : ""
            });
            if (!isTransparent) {
                swatch.set_style("background-color: " + color + ";");
            }
            swatch.connect("clicked", () => onSelect(color, swatch));
            row.add(swatch);
            buttons.push({ button: swatch, color: color });
        });

        rowItem.addActor(row, { expand: true, span: -1 });
        this.menu.addMenuItem(rowItem);
        return buttons;
    }

    _highlightSwatch(buttonList, selectedButton) {
        buttonList.forEach(({ button }) => {
            button.remove_style_pseudo_class("selected");
        });
        selectedButton.add_style_pseudo_class("selected");
    }

    _openPopup() {
        const mode = this.settings.getValue("mode");
        this._rebuildPopupContent(mode);

        if (mode === "direct") {
            const text = this.settings.getValue("custom-text") || "";
            this._entryText.set_text(text);
            this._selectedColor = this.settings.getValue("custom-color") || PRESET_COLORS[0];
        } else {
            // No text entry in Calendar mode - the fg swatch maps to
            // default-event-color on commit (see _commitPopup), so preselect
            // from that instead of custom-color.
            this._selectedColor = this.settings.getValue("default-event-color") || PRESET_COLORS[0];
        }
        const match = this._swatchButtons.find(s => s.color === this._selectedColor);
        if (match) this._highlightSwatch(this._swatchButtons, match.button);

        this._selectedBgColor = this.settings.getValue("custom-bg-color") || BG_PRESET_COLORS[0];
        const bgMatch = this._bgSwatchButtons.find(s => s.color === this._selectedBgColor);
        if (bgMatch) this._highlightSwatch(this._bgSwatchButtons, bgMatch.button);

        this.menu.open(true);

        if (mode === "direct") {
            const text = this.settings.getValue("custom-text") || "";
            global.stage.set_key_focus(this._entryText);
            this._entryText.set_selection(0, text.length);
        }
    }

    _previewColors() {
        this._setPanelStyle(this._selectedColor, this._selectedBgColor);
    }

    _commitPopup() {
        const mode = this.settings.getValue("mode");
        if (mode === "direct") {
            const text = this._entryText.get_text();
            this.settings.setValue("mode", "direct");
            this.settings.setValue("custom-text", text);
            this.settings.setValue("custom-color", this._selectedColor);
            this.settings.setValue("custom-bg-color", this._selectedBgColor);
        } else {
            // Calendar mode: no text to commit, and mode stays "calendar".
            // Maps to default-event-color (used when the current event has
            // no color of its own) since that's the closest existing analog
            // to "the text color" in this mode. Background selection is
            // preview-only here - there's no persistent calendar-mode
            // background setting to save it to yet.
            this.settings.setValue("default-event-color", this._selectedColor);
        }
        this.menu.close();
    }

    on_applet_clicked(event) {
        if (this.menu.isOpen) {
            this.menu.close();
        } else {
            this._openPopup();
        }
    }

    // ---------- Context menu (right-click) ----------

    // this._applet_context_menu is provided by the base Applet class (the
    // standard right-click menu with "Remove", "About", etc.) - we're just
    // adding our own items to it, not building a separate menu. Calendar
    // selection lives in Preferences instead (see calendar_widget.py), not
    // here - this is just the quick mode switch.
    _buildContextMenu() {
        this._directModeMenuItem = new PopupMenu.PopupMenuItem("Direct Mode");
        this._directModeMenuItem.connect("activate", () => {
            this.settings.setValue("mode", "direct");
            this._refresh(); // belt-and-suspenders: force it even if the settings-changed binding is slow/doesn't fire from this code path
        });
        this._applet_context_menu.addMenuItem(this._directModeMenuItem);

        this._calendarModeMenuItem = new PopupMenu.PopupMenuItem("Calendar Mode");
        this._calendarModeMenuItem.connect("activate", () => {
            this.settings.setValue("mode", "calendar");
            this._refresh();
        });
        this._applet_context_menu.addMenuItem(this._calendarModeMenuItem);

        // Refresh the checkmarks every time the context menu opens, so
        // they're never stale (mode can also change via Settings/the popup
        // while the applet is running).
        this._applet_context_menu.connect("open-state-changed", (menu, isOpen) => {
            if (isOpen) {
                this._updateContextMenu();
            }
        });

        this._updateContextMenu();
    }

    _updateContextMenu() {
        const mode = this.settings.getValue("mode");
        this._directModeMenuItem.label.set_text((mode === "direct" ? "✓ " : "   ") + "Direct Mode");
        this._calendarModeMenuItem.label.set_text((mode === "calendar" ? "✓ " : "   ") + "Calendar Mode");
    }

    _populateCalendarSubMenu(calendars) {
        this._calendarSubMenu.menu.removeAll();
        const selected = this.settings.getValue("selected-calendar") || "";

        const defaultItem = new PopupMenu.PopupMenuItem((selected === "" ? "✓ " : "   ") + "System Default");
        defaultItem.connect("activate", () => {
            this.settings.setValue("selected-calendar", "");
        });
        this._calendarSubMenu.menu.addMenuItem(defaultItem);

        calendars.forEach((cal) => {
            const isSelected = cal.uid === selected;
            const item = new PopupMenu.PopupMenuItem((isSelected ? "✓ " : "   ") + cal.name);
            item.connect("activate", () => {
                this.settings.setValue("selected-calendar", cal.uid);
            });
            this._calendarSubMenu.menu.addMenuItem(item);
        });
    }

    // ---------- Hotkey ----------

    _registerHotkey() {
        Main.keybindingManager.removeHotKey(this._uuid + "-open-" + this.instance_id);
        const accel = this.settings.getValue("hotkey");
        if (accel && accel.length) {
            Main.keybindingManager.addHotKey(
                this._uuid + "-open-" + this.instance_id,
                accel,
                () => this._openPopup()
            );
        }
    }

    // ---------- Calendar picker (Settings screen) ----------

    // settings-schema.json's "custom" widget type is rejected outright by
    // this Cinnamon build's JS-side settings validator (confirmed - it's a
    // hard incompatibility, crashes the whole applet, not just this field),
    // so a real live-populated dropdown isn't possible that way here.
    // "combobox" works fine (already proven - it's what Mode uses), just
    // needs its "options" populated statically at *some* point before
    // Settings is opened. Solution: rewrite the deployed settings-schema.json
    // on load, replacing selected-calendar's definition with a combobox
    // whose options come straight from --list-calendars. Only runs once per
    // applet load (calendars rarely change), not on every poll - reload the
    // applet to pick up newly added/removed calendars.
    _updateCalendarSchemaOptions() {
        const scriptPath = this.metadata.path + "/helper/" + HELPER_SCRIPT;
        try {
            let proc = Gio.Subprocess.new(["python3", scriptPath, "--list-calendars"], Gio.SubprocessFlags.STDOUT_PIPE);
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    let [, stdout] = proc.communicate_utf8_finish(res);
                    this._writeCalendarComboOptions(JSON.parse(stdout));
                } catch (e) {
                    global.logError("focal: failed to list calendars for settings-schema options: " + e);
                }
            });
        } catch (e) {
            global.logError("focal: failed to spawn --list-calendars for settings-schema options: " + e);
        }
    }

    _writeCalendarComboOptions(calendars) {
        const schemaPath = this.metadata.path + "/settings-schema.json";
        try {
            const [ok, contents] = GLib.file_get_contents(schemaPath);
            if (!ok) return;
            const schema = JSON.parse(ByteArray.toString(contents));

            const previousValue = schema["selected-calendar"] && schema["selected-calendar"]["default"];

            const defaultCal = calendars.find((cal) => cal.is_default);
            const defaultLabel = defaultCal ? ("System Default (" + defaultCal.name + ")") : "System Default";

            const options = {};
            options[defaultLabel] = "";
            calendars.forEach((cal) => {
                options[cal.name || cal.uid] = cal.uid;
            });

            schema["selected-calendar"] = {
                "type": "combobox",
                "default": previousValue || "",
                "options": options,
                "description": "Calendar to use",
                "tooltip": "\"System Default\" always tracks whatever calendar your system currently considers the default (shown in parentheses) - if that changes, this follows automatically, no need to re-pick anything. This list refreshes once per applet reload, not live.",
                "dependency": "mode",
                "dependency-value": "calendar"
            };

            GLib.file_set_contents(schemaPath, JSON.stringify(schema, null, 2));
        } catch (e) {
            global.logError("focal: failed to update settings-schema.json with calendar options: " + e);
        }
    }

    // ---------- Rendering ----------

    _refresh() {
        this._updateIconVisibility();

        const mode = this.settings.getValue("mode");
        if (mode === "calendar") {
            if (!this._calendarHasRendered) {
                this._renderCalendarFetching();
            }
            this._stopCalendarPolling(false);
            this._startCalendarPolling();
            this._pollCalendarOnce();
        } else {
            this._stopCalendarPolling(true);
            this._renderCustom();
        }
    }

    // TextIconApplet's icon actor - assumed exposed as this._applet_icon,
    // and that a plain St/Clutter actor .visible assignment is enough to
    // hide/show it. Both are reasonable, standard-ish assumptions but
    // unverified on this specific Cinnamon build.
    _updateIconVisibility() {
        if (this._applet_icon) {
            this._applet_icon.visible = this.settings.getValue("show-icon") !== false;
        }
    }

    _renderCustom() {
        const text = this.settings.getValue("custom-text") || "";
        const color = this.settings.getValue("custom-color") || "rgb(255,255,255)";
        const bg = this.settings.getValue("custom-bg-color") || "rgba(0,0,0,0)";
        this._setLabel(text);
        this._setPanelStyle(color, bg);
    }

    // St.Label child (`this._applet_label`, from Applet.TextApplet) doesn't inherit
    // "color" from the container's inline style, so it has to be set directly.
    _setPanelStyle(color, bg) {
        this.actor.set_style("background-color: " + (bg || "rgba(0,0,0,0)") + ";");
        this._applet_label.set_style("color: " + color + ";");
    }

    _clearPanelStyle() {
        this.actor.set_style("");
        this._applet_label.set_style("");
    }

    // Tooltip always shows the full, untruncated text (set_applet_tooltip is
    // a standard Applet base-class method for panel hover text). Truncation
    // is applied only to what's actually shown on the panel, after the
    // tooltip is set, so hovering always reveals the whole thing.
    // tooltipText lets callers show a differently-formatted tooltip than the
    // panel label (e.g. Calendar mode's Until/Remaining on their own lines -
    // see issue #1); defaults to the panel text when omitted.
    _setLabel(text, tooltipText) {
        this.set_applet_tooltip(tooltipText !== undefined ? tooltipText : text);

        const maxLength = this.settings.getValue("max-text-length") || 0;
        if (maxLength > 0 && text.length > maxLength) {
            text = text.slice(0, Math.max(0, maxLength - 1)) + "…";
        }

        this.set_applet_label(text);
    }

    // Shown once, immediately, when entering Calendar mode - before the first
    // poll has had a chance to come back - so the panel doesn't sit blank
    // while waiting. _calendarHasRendered (set in _pollCalendarOnce's settle())
    // stops it from re-flashing on every later _refresh() while already
    // polling (settings changes, popup close, etc. all call _refresh()).
    _renderCalendarFetching() {
        this._setLabel("Fetching from calendar…");
        this._clearPanelStyle();
    }

    // ---------- Calendar mode ----------

    _onPollIntervalChanged() {
        if (this.settings.getValue("mode") === "calendar") {
            this._stopCalendarPolling(false);
            this._startCalendarPolling();
        }
    }

    _startCalendarPolling() {
        const interval = this.settings.getValue("poll-interval-seconds") || 60;
        this._calendarTimeoutId = Mainloop.timeout_add_seconds(interval, () => {
            this._pollCalendarOnce();
            return true; // keep repeating
        });
    }

    _stopCalendarPolling(clearLabel) {
        if (this._calendarTimeoutId) {
            Mainloop.source_remove(this._calendarTimeoutId);
            this._calendarTimeoutId = null;
        }
        if (clearLabel) {
            // Leaving Calendar mode entirely - abandon any in-flight poll so
            // it can't resolve later and stomp on Direct mode's render, and
            // so it doesn't keep the in-flight guard held forever.
            if (this._calendarPollAbort) {
                this._calendarPollAbort();
            }
            this._calendarHasRendered = false; // so re-entering Calendar mode shows "Fetching..." again
        }
        // NOTE: _pollInFlight is deliberately NOT reset here when !clearLabel.
        // _refresh() calls this on every settings change while staying in
        // Calendar mode (not just on mode switches), and it used to clear
        // the guard unconditionally - which meant every settings tweak while
        // polling spawned another overlapping `python3 calendar_helper.py`,
        // defeating the guard entirely.
    }

    // Guards against overlapping/hung subprocesses: without this, a mode
    // switch (which calls _refresh() directly) landing close to the poll
    // timer firing - or _refresh() simply being called more than once in a
    // row - could spawn several concurrent `python3 calendar_helper.py`
    // processes, each independently opening EDS clients. That's a plausible
    // cause of the whole-system sluggishness (including the separate
    // Preferences window) seen when switching into Calendar mode.
    _pollCalendarOnce() {
        if (this._pollInFlight) {
            return;
        }
        this._pollInFlight = true;

        let settled = false;
        const settle = () => {
            settled = true;
            this._pollInFlight = false;
            this._calendarHasRendered = true; // stops "Fetching..." from re-showing on later _refresh() calls
            this._calendarPollAbort = null;
        };

        // Everything below is inside the try, including scriptPath/args setup -
        // previously those lines sat outside it, so any exception there (e.g.
        // this.metadata being unexpectedly unset) left _pollInFlight stuck
        // `true` forever with no way to reach settle(), permanently jamming
        // the guard against all future polls.
        try {
            const scriptPath = this.metadata.path + "/helper/" + HELPER_SCRIPT;
            const selectedCalendar = this.settings.getValue("selected-calendar") || "";
            const args = ["python3", scriptPath, "--current-or-next"];
            if (selectedCalendar) {
                args.push("--calendar", selectedCalendar);
            }

            let proc = Gio.Subprocess.new(args, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);

            const timeoutId = Mainloop.timeout_add_seconds(POLL_TIMEOUT_SECONDS, () => {
                if (!settled) {
                    global.logError("focal: calendar helper timed out after " + POLL_TIMEOUT_SECONDS + "s, killing it");
                    proc.force_exit();
                    settle();
                    this._renderCalendarError();
                }
                return false; // one-shot
            });

            this._calendarPollAbort = () => {
                if (!settled) {
                    Mainloop.source_remove(timeoutId);
                    proc.force_exit();
                    settle();
                }
            };

            proc.communicate_utf8_async(null, null, (proc, res) => {
                if (settled) return; // already timed out - watchdog source already auto-removed itself
                Mainloop.source_remove(timeoutId);
                try {
                    let [, stdout, stderr] = proc.communicate_utf8_finish(res);
                    settle();
                    this._onCalendarResult(stdout, stderr);
                } catch (e) {
                    global.logError("focal: helper communicate failed: " + e);
                    settle();
                    this._renderCalendarError();
                }
            });
        } catch (e) {
            global.logError("focal: failed to spawn calendar helper: " + e);
            settle();
            this._renderCalendarError();
        }
    }

    // toLocaleTimeString() with no explicit hour12 follows ICU's *locale*
    // default (e.g. en-US -> 12h), which is a different setting entirely
    // from Cinnamon/GNOME's actual 24-hour-clock toggle - Intl has no
    // visibility into that desktop preference on its own. Read it directly
    // from GSettings instead, same key Cinnamon's own clock applet uses.
    _timeFormatOptions() {
        const options = { hour: "numeric", minute: "2-digit" };
        try {
            const desktopSettings = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" });
            const clockFormat = desktopSettings.get_string("clock-format"); // "12h" or "24h"
            if (clockFormat === "24h") {
                options.hour12 = false;
            } else if (clockFormat === "12h") {
                options.hour12 = true;
            }
        } catch (e) {
            // Schema unavailable for some reason - fall back to locale default.
        }
        return options;
    }

    // Computes the "Until <time>" / "Remaining <duration>" strings for the
    // current event, independent of the show-event-end-time/show-time-remaining
    // switches - callers decide whether/how to include them. Either can be
    // null (no end time on the event, or it's already ended).
    _untilRemainingParts(ev) {
        const endDate = ev.end_iso ? new Date(ev.end_iso) : null;
        if (!endDate) {
            return { until: null, remaining: null };
        }

        const until = "Until " + endDate.toLocaleTimeString([], this._timeFormatOptions());

        const remainingMinutes = Math.floor((endDate.getTime() - Date.now()) / 60000);
        let remaining = null;
        if (remainingMinutes > 0) {
            const hours = Math.floor(remainingMinutes / 60);
            const minutes = remainingMinutes % 60;
            const duration = hours > 0 ? (hours + "h, " + minutes + "m") : (minutes + "m");
            remaining = "Remaining " + duration;
        }

        return { until, remaining };
    }

    // Appends " | Until <time>" and/or " | Remaining <duration>" to the
    // current event's summary, per their respective switches. Only applies
    // to the current event (not the dimmed "upcoming" fallback) - "until"/
    // "remaining" don't make sense for something that hasn't started yet.
    _formatCurrentEventLabel(ev) {
        let label = ev.summary || "";
        const { until, remaining } = this._untilRemainingParts(ev);

        if (this.settings.getValue("show-event-end-time") && until) {
            label += " | " + until;
        }

        if (this.settings.getValue("show-time-remaining") && remaining) {
            label += " | " + remaining;
        }

        return label;
    }

    // Tooltip for the current event: summary / Until / Remaining each on
    // their own line, always included when computable regardless of the
    // panel's show-event-end-time/show-time-remaining switches (issue #1).
    _formatCurrentEventTooltip(ev) {
        const lines = [ev.summary || ""];
        const { until, remaining } = this._untilRemainingParts(ev);
        if (until) {
            lines.push(until);
        }
        if (remaining) {
            lines.push(remaining);
        }
        return lines.join("\n");
    }

    _onCalendarResult(stdout, stderr) {
        if (!stdout) {
            this._renderCalendarEmpty();
            return;
        }
        let data;
        try {
            data = JSON.parse(stdout);
        } catch (e) {
            global.logError("focal: bad JSON from helper: " + stdout + " / stderr: " + stderr);
            this._renderCalendarError();
            return;
        }

        if (data.current) {
            const ev = data.current;
            const useOwnColor = ev.color && !this.settings.getValue("override-event-color");
            const color = (useOwnColor ? ev.color : null) || this.settings.getValue("default-event-color") || "rgb(255,255,255)";
            this._setLabel(this._formatCurrentEventLabel(ev), this._formatCurrentEventTooltip(ev));
            this._setPanelStyle(color, "rgba(0,0,0,0)");
        } else if (data.next && this.settings.getValue("show-upcoming-fallback")) {
            const ev = data.next;
            const color = this.settings.getValue("upcoming-color") || "rgb(150,150,150)";
            // Computed here from start_iso (not calendar_helper.py's start_label,
            // which is hardcoded to 12h/AM-PM Python-side with no awareness of
            // the system's clock-format setting) so it's consistent with "Until".
            const time = ev.start_iso ? new Date(ev.start_iso).toLocaleTimeString([], this._timeFormatOptions()) : "";
            this._setLabel("Upcoming " + time + " " + (ev.summary || ""));
            this._setPanelStyle(color, "rgba(0,0,0,0)");
        } else {
            this._renderCalendarEmpty();
        }
    }

    _renderCalendarEmpty() {
        const text = this.settings.getValue("show-upcoming-fallback")
            ? "No active or upcoming events"
            : "No active event";
        this._setLabel(text);
        this._clearPanelStyle();
    }

    _renderCalendarError() {
        this._setLabel("Calendar error");
        this._clearPanelStyle();
    }

    on_applet_removed_from_panel() {
        this._stopCalendarPolling(false);
        this.settings.finalize();
        Main.keybindingManager.removeHotKey(this._uuid + "-open-" + this.instance_id);
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new FocalApplet(metadata, orientation, panel_height, instance_id);
}
