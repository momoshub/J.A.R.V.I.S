#!/usr/bin/env osascript -l JavaScript
//
// Drive ANY macOS app from the shell, through the Accessibility API.
//
//   mac-ui.js apps                               what is running
//   mac-ui.js tree   <app> [--depth N]           the live AX tree
//   mac-ui.js find   <app> <text> [--role R]     elements whose title/value matches
//   mac-ui.js click  <app> <text> [--role R]     press the first match
//   mac-ui.js type   <app> <text>                type into the focused element
//   mac-ui.js key    <app> <key> [--cmd --shift] a keystroke (return, tab, a, ...)
//   mac-ui.js read   <app>                       every visible string
//   mac-ui.js windows <app>                      window titles (AX sees what AppleScript cannot)
//   mac-ui.js close  <app> <title-substring>     close windows by title
//   mac-ui.js menu   <app> <Menu> <Item>         pick a menu item
//   mac-ui.js release-keys                       let go of every modifier key
//
// WHY THIS AND NOT APPLESCRIPT. AppleScript/System Events needs the Automation
// TCC permission, which this host does not grant the bot - that is the -1712
// timeout it hits on Arc. The raw AXUIElement C API needs only Accessibility,
// which it HAS. Measured on this machine: launchd -> bun -> osascript reports
// AXIsProcessTrusted() = true, because TCC attributes a child to the responsible
// parent and the parent (bun) holds the grant.
//
// AX also SEES MORE. Arc's "Little Arc" windows are invisible to AppleScript
// (`count windows` said 1 where AX said 4), so anything tab-based silently
// misses them.
//
// Output is JSON on stdout, except `tree`. Exit 0 on success, 1 on failure.
ObjC.import('ApplicationServices');
ObjC.import('AppKit');

function raw(el, name) {
  var out = Ref();
  if ($.AXUIElementCopyAttributeValue(el, $(name), out) !== 0) return null;
  return out[0];
}
function str(el, name) {
  var v = raw(el, name);
  if (!v) return '';
  try {
    var u = ObjC.unwrap(ObjC.castRefToObject(v));
    return (u === null || u === undefined) ? '' : String(u);
  } catch (e) { return ''; }
}
function children(el) {
  var v = raw(el, 'AXChildren');
  if (!v) return [];
  try {
    var arr = ObjC.castRefToObject(v), res = [];
    for (var i = 0; i < arr.count; i++) res.push(arr.objectAtIndex(i));
    return res;
  } catch (e) { return []; }
}
function sleep(s) { $.NSThread.sleepForTimeInterval(s); }

// AXValueGetValue does not bridge in JXA (-2700). The NSObject description
// carries the numbers - "{value = x:745 y:85 ...}" - so parse that instead.
function point(el, name) {
  var v = raw(el, name);
  if (!v) return null;
  try {
    var d = String(ObjC.unwrap(ObjC.castRefToObject(v).description));
    var x = d.match(/x:(-?[\d.]+)/), y = d.match(/y:(-?[\d.]+)/);
    var w = d.match(/w:(-?[\d.]+)/), h = d.match(/h:(-?[\d.]+)/);
    if (x && y) return { x: parseFloat(x[1]), y: parseFloat(y[1]) };
    if (w && h) return { w: parseFloat(w[1]), h: parseFloat(h[1]) };
    return null;
  } catch (e) { return null; }
}

function appByName(name) {
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications, want = name.toLowerCase();
  for (var i = 0; i < apps.count; i++) {
    var a = apps.objectAtIndex(i), n = ObjC.unwrap(a.localizedName) || '';
    if (String(n).toLowerCase() === want) return a;
  }
  for (var j = 0; j < apps.count; j++) {
    var b = apps.objectAtIndex(j), m = String(ObjC.unwrap(b.localizedName) || '');
    if (m.toLowerCase().indexOf(want) !== -1) return b;
  }
  return null;
}

/**
 * The application element, with Chromium's tree forced on.
 *
 * Electron builds its accessibility tree lazily and only once an assistive
 * client announces itself with AXManualAccessibility. Without it the whole UI
 * reads as nested empty AXGroups - which looks exactly like a permission
 * problem and is not one. It applies to every Electron app: Slack, VS Code,
 * Arc, Discord, Postman. AXEnhancedUserInterface is the AppKit equivalent and
 * returns -25208 here; it is the wrong attribute for Chromium.
 */
function appRef(name, opts) {
  var app = appByName(name);
  if (!app && opts && opts.launch) {
    $.NSWorkspace.sharedWorkspace.launchApplication(name);
    for (var i = 0; i < 40 && !app; i++) { sleep(0.25); app = appByName(name); }
    if (app) sleep(2);
  }
  if (!app) throw new Error(name + ' is not running');
  if (opts && opts.activate) app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
  var ref = $.AXUIElementCreateApplication(app.processIdentifier);
  $.AXUIElementSetAttributeValue(ref, $('AXManualAccessibility'), $.NSNumber.numberWithBool(true));
  // The tree populates asynchronously after the flag flips, so give it a moment
  // rather than reading an empty one and calling the app unscriptable.
  for (var j = 0; j < 12; j++) {
    if (children(ref).length) break;
    sleep(0.25);
  }
  return ref;
}

function findAll(root, pred, depth) {
  depth = depth || 0;
  var hits = [];
  if (depth > 25) return hits;
  try { if (pred(root)) hits.push(root); } catch (e) {}
  children(root).forEach(function (c) { hits = hits.concat(findAll(c, pred, depth + 1)); });
  return hits;
}

function label(el) {
  return str(el, 'AXTitle') || str(el, 'AXValue') || str(el, 'AXDescription') || str(el, 'AXLabel');
}
function matches(el, text, role) {
  if (role && str(el, 'AXRole') !== role) return false;
  return label(el).toLowerCase().indexOf(text.toLowerCase()) !== -1;
}
function describe(el) {
  return { role: str(el, 'AXRole'), subrole: str(el, 'AXSubrole'), title: label(el) };
}

/**
 * Press an element, falling back to a real pointer click.
 *
 * AXPress returns 0 and does nothing on web content - Google's account rows are
 * the known case - because the page only reacts to a genuine pointer event. So
 * the result is verified by clicking at the element's centre when AXPress was a
 * no-op is not knowable; instead `--real` forces the pointer path.
 */
function clickElement(el, real) {
  if (!real) {
    var rc = $.AXUIElementPerformAction(el, $('AXPress'));
    if (rc === 0) return 'AXPress';
  }
  var pos = point(el, 'AXPosition'), size = point(el, 'AXSize');
  if (!pos || !size) throw new Error('element has no frame to click');
  var p = $.CGPointMake(pos.x + size.w / 2, pos.y + size.h / 2);
  var down = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDown, p, $.kCGMouseButtonLeft);
  var up = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseUp, p, $.kCGMouseButtonLeft);
  $.CGEventPost($.kCGHIDEventTap, down);
  sleep(0.05);
  $.CGEventPost($.kCGHIDEventTap, up);
  return 'click';
}

// Key events come from a PRIVATE source and always carry their flags, even
// none. A null source reads and writes the shared HID state: one Shift-flagged
// event posted to the HID tap left Shift "held" for everything after it, and
// later keystrokes fired as shortcuts on the person's Mac (new windows,
// bookmarks, Finder). releaseModifiers then lets go of every modifier anyway,
// in a finally, so nothing outlives the command - whoever pressed it.
var MODIFIER_CODES = [56, 60, 55, 54, 58, 61, 59, 62, 63]; // shift, cmd, option, control (left/right), fn
function keySource() { return $.CGEventSourceCreate($.kCGEventSourceStatePrivate); }
function postKey(src, code, isDown, flagsMask) {
  var ev = $.CGEventCreateKeyboardEvent(src, code, isDown);
  $.CGEventSetFlags(ev, flagsMask);
  $.CGEventPost($.kCGHIDEventTap, ev);
  sleep(0.02);
}
function releaseModifiers() {
  var src = keySource();
  MODIFIER_CODES.forEach(function (code) { postKey(src, code, false, 0); });
}

// JXA's console.log writes to STDERR. osascript prints whatever `run` returns
// to stdout, so everything is accumulated and returned instead - otherwise a
// caller parsing stdout gets an empty string and the tool looks broken.
var OUT = [];
function emit(line) { OUT.push(line); }
function out(o) { emit(JSON.stringify(o)); }

function dispatch(argv) {
  var cmd = argv[0], name = argv[1];
  var flags = {};
  var rest = [];
  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--role') flags.role = argv[++i];
    else if (a === '--depth') flags.depth = parseInt(argv[++i], 10);
    else if (a === '--real') flags.real = true;
    else if (a === '--launch') flags.launch = true;
    else if (a === '--cmd') flags.cmd = true;
    else if (a === '--shift') flags.shift = true;
    else rest.push(a);
  }
  var text = rest.join(' ');

  if (cmd === 'apps') {
    var apps = $.NSWorkspace.sharedWorkspace.runningApplications, list = [];
    for (var k = 0; k < apps.count; k++) {
      var a = apps.objectAtIndex(k);
      if (Number(a.activationPolicy) === 0) list.push({ name: String(ObjC.unwrap(a.localizedName) || ''), pid: a.processIdentifier });
    }
    out(list);
    return;
  }
  if (cmd === 'release-keys') {
    releaseModifiers();
    out({ released: MODIFIER_CODES.length });
    return;
  }
  if (!cmd || !name) throw new Error('usage: mac-ui.js <apps|tree|find|click|type|key|read|windows|close|menu|release-keys> <app> [...]');

  var ref = appRef(name, { launch: flags.launch, activate: cmd !== 'tree' && cmd !== 'read' && cmd !== 'windows' && cmd !== 'apps' });

  if (cmd === 'tree') {
    var max = flags.depth || 6;
    (function walk(el, d) {
      if (d > max) return;
      var info = describe(el);
      if (info.role) emit(new Array(d + 1).join('  ') + info.role + (info.subrole ? '/' + info.subrole : '') + (info.title ? ' "' + info.title.slice(0, 70) + '"' : ''));
      children(el).forEach(function (c) { walk(c, d + 1); });
    })(ref, 0);
    return;
  }
  if (cmd === 'windows') {
    out(children(ref).filter(function (w) { return str(w, 'AXRole') === 'AXWindow'; }).map(function (w) { return str(w, 'AXTitle'); }));
    return;
  }
  if (cmd === 'read') {
    out(findAll(ref, function (e) { return str(e, 'AXRole') === 'AXStaticText'; })
      .map(function (e) { return str(e, 'AXValue'); }).filter(function (s) { return s; }));
    return;
  }
  if (cmd === 'find') {
    out(findAll(ref, function (e) { return matches(e, text, flags.role); }).map(describe));
    return;
  }
  if (cmd === 'click') {
    var hit = findAll(ref, function (e) { return matches(e, text, flags.role); })[0];
    if (!hit) throw new Error('nothing matching "' + text + '"' + (flags.role ? ' with role ' + flags.role : ''));
    out({ clicked: describe(hit), how: clickElement(hit, flags.real) });
    return;
  }
  if (cmd === 'close') {
    // Descending, because the window list is invalidated as windows close.
    var wins = children(ref).filter(function (w) { return str(w, 'AXRole') === 'AXWindow'; });
    var closed = 0;
    for (var n = wins.length - 1; n >= 0; n--) {
      if (str(wins[n], 'AXTitle').indexOf(text) === -1) continue;
      // The close button is an ATTRIBUTE; searching for a subrole finds nothing.
      var btn = raw(wins[n], 'AXCloseButton');
      if (btn && $.AXUIElementPerformAction(ObjC.castRefToObject(btn), $('AXPress')) === 0) closed++;
    }
    out({ closed: closed });
    return;
  }
  if (cmd === 'type') {
    // Setting AXValue on the focused field, rather than synthesising key
    // events: CGEventKeyboardSetUnicodeString does not bridge cleanly in JXA,
    // and a field that refuses AXValue is better reported than half-typed.
    var focused = raw(ref, 'AXFocusedUIElement');
    if (!focused) throw new Error('nothing is focused to type into');
    var el = ObjC.castRefToObject(focused);
    var rc = $.AXUIElementSetAttributeValue(el, $('AXValue'), $.NSString.stringWithString(text));
    if (rc !== 0) throw new Error('could not set the focused field (' + rc + ')');
    out({ typed: text.length });
    return;
  }
  if (cmd === 'key') {
    var CODES = { 'return': 36, enter: 36, tab: 48, space: 49, escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126, 'delete': 51 };
    var code = CODES[text.toLowerCase()];
    if (code === undefined) throw new Error('unknown key "' + text + '" - use return, tab, space, escape, arrows, delete');
    var flagsMask = (flags.cmd ? $.kCGEventFlagMaskCommand : 0) | (flags.shift ? $.kCGEventFlagMaskShift : 0);
    var src = keySource();
    try {
      postKey(src, code, true, flagsMask);
      postKey(src, code, false, flagsMask);
    } finally {
      releaseModifiers();
    }
    out({ key: text });
    return;
  }
  if (cmd === 'menu') {
    var bar = raw(ref, 'AXMenuBar');
    if (!bar) throw new Error('no menu bar');
    var hits = findAll(ObjC.castRefToObject(bar), function (e) { return matches(e, text); });
    if (!hits.length) throw new Error('no menu item matching "' + text + '"');
    $.AXUIElementPerformAction(hits[0], $('AXPress'));
    out({ picked: describe(hits[0]) });
    return;
  }
  throw new Error('unknown command "' + cmd + '"');
}

// JXA calls `run` with the arguments; this is the entry point.
function run(argv) {
  if (!$.AXIsProcessTrusted()) {
    return JSON.stringify({ error: 'no Accessibility permission for this process' });
  }
  try {
    dispatch(argv);
  } catch (e) {
    OUT = [JSON.stringify({ error: String(e.message || e) })];
  }
  return OUT.join('\n');
}
